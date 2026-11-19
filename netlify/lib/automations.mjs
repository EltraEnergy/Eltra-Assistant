// Automatic to-dos, so nothing slips:
//  • a Pylon proposal gets signed  → pre-approval, stock order, install booking and welcome email to-dos
//  • a proposal has sat unsigned for 3+ days → a follow-up to-do (once per project)
// Runs on a schedule (functions/automations.mjs) and whenever the dashboard loads the to-do list (at most every 15 min).
import { store, runAs, melbToday } from './util.mjs';
import { addTodo, loadTodos } from './todos.mjs';
import { pylon, pylonReady, pylonProject, pylonDesign, DESIGN_FIELDS, toolByName } from './tools.mjs';
import { googleStatus, g, CAL } from './google.mjs';
import { claudeJSON } from './claude.mjs';
import { sendWeeklySummaries } from './weekly.mjs';

const STATE = 'automations';
const dayPlus = (n) => { const d = new Date(Date.now() + n * 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }); };

// What gets added when a job is signed. Sections must match (or loosely match) your to-do sections.
function signedTasks(name, design) {
  const kit = design ? [design.panels.join('; '), design.inverters.join('; '), design.batteries.join('; ')].filter(Boolean).join(' · ') : '';
  return [
    { section: 'Admin', text: 'Send ' + name + ' the welcome / next steps email', due: dayPlus(0), owner: 'will' },
    { section: 'Install dates', text: 'Book the install date with ' + name, due: dayPlus(1), owner: 'ethan' },
    { section: 'DNSP', text: 'Lodge the DNSP pre-approval for ' + name, due: dayPlus(1), owner: 'will' }
  ];   // ordering stock comes a week before the install date (see the install check)
}
const kitOf = (design) => design ? [design.panels.join('; '), design.inverters.join('; '), design.batteries.join('; ')].filter(Boolean).join(' · ') : '';
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const custOf = (summary) => String(summary || '').replace(/^\s*install(ation)?\s*[-–:]?\s*/i, '').trim() || 'the install';
// the signed job whose customer name matches the calendar event (to list the right kit)
function kitFor(s, who) { const w = norm(who); if (!w) return ''; const k = Object.keys(s.kits || {}).find((n) => n && (w.includes(n) || n.includes(w))); return k ? s.kits[k] : ''; }

// ---- Proposal follow-up sequence ----
// Three touches per unsigned proposal, counted from when its design was made in Pylon: day 3, day 7, day 14.
// The next touch only comes once the previous to-do is ticked off and its day has arrived; deleting a follow-up
// to-do stops the sequence for that customer. At most 3 new follow-ups a day; extras roll over to the next day.
const FOLLOW_DAYS = [3, 7, 14], FOLLOW_PER_DAY = 3;
const STAGE = [
  { text: (n) => 'Follow up ' + n + '’s proposal (first check-in)', brief: 'a friendly first check-in: did the proposal arrive, any questions, happy to walk through it' },
  { text: (n) => 'Second follow-up for ' + n, brief: 'offer to answer questions, adjust the system size or battery, or talk through the numbers; suggest a quick call' },
  { text: (n) => 'Last follow-up for ' + n + ' (then keep warm or mark lost)', brief: 'a short, no-pressure close-the-loop: the price holds for now, they can reach out any time, and ask if they would like you to keep in touch' }
];
async function followUpStep(s, p, name, google, today, budget) {
  const f = s.follow[p.id] || { stage: 0 };
  if (f.stopped || f.stage >= STAGE.length) return false;
  // previous touch: still open → wait; deleted (not ticked) → stop the sequence
  if (f.todoId) {
    const t = budget.todos.items.find((x) => x.id === f.todoId);
    if (!t) { f.stopped = true; s.follow[p.id] = f; return false; }
    if (!t.done) return false;
  }
  // when was the proposal made? (the primary design's creation date, cached)
  s.designAt = s.designAt || {};
  if (!s.designAt[p.id]) {
    const ds = await pylon('/solar_designs/' + p.primary_design_id + '?fields[solar_designs]=created_at').catch(() => null);
    s.designAt[p.id] = (ds && ds.data && ds.data.attributes && ds.data.attributes.created_at) || p.createdAt || new Date().toISOString();
  }
  const sentDays = (Date.now() - Date.parse(s.designAt[p.id])) / 864e5;
  if (!isFinite(sentDays)) return false;
  if (sentDays > 60) return false;                                   // too old to chase
  if (sentDays < FOLLOW_DAYS[f.stage]) return false;                 // not due yet
  if (f.lastAt && (Date.now() - Date.parse(f.lastAt)) / 864e5 < FOLLOW_DAYS[f.stage] - (FOLLOW_DAYS[f.stage - 1] || 0) - 0.5) return false;   // keep the gap since the last touch
  if (s.followDay.count >= FOLLOW_PER_DAY) return false;            // today's quota used: next run tomorrow
  const st = STAGE[f.stage];
  let draftNote = '';
  const email = p.customer && p.customer.email;
  if (google.connected && email) {
    if (budget.drafts <= 0 || Date.now() - budget.started > 12000) return false;   // write it next run, with its draft
    try {
      const ds = await pylon('/solar_designs/' + p.primary_design_id + '?fields[solar_designs]=' + DESIGN_FIELDS).catch(() => null);
      const des = ds && ds.data ? pylonDesign(ds.data) : null;
      const m = await claudeJSON({ system: 'You write short, friendly follow-up emails for Will at Eltra Energy, a Melbourne solar and battery installer. Australian English, plain and warm, no pressure, no exclamation marks, no sign-off name (the signature is added).',
        prompt: 'Customer: ' + name + '. Proposal sent ' + Math.round(sentDays) + ' days ago, not signed yet. This is follow-up ' + (f.stage + 1) + ' of 3: ' + st.brief + '.' + (des ? ' System: ' + [des.solar_kw ? des.solar_kw + 'kW solar' : '', des.battery_kwh ? des.battery_kwh + 'kWh battery' : '', des.total ? 'total ' + des.total : ''].filter(Boolean).join(', ') + '.' : '') + ' 3-5 sentences, plus a subject line.',
        schema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] }, maxTokens: 600, timeoutMs: 15000 });
      await toolByName('gmail_create_draft').run({ to: email, subject: m.subject, body: m.body });
      draftNote = ' (draft ready in Gmail)'; budget.drafts--;
    } catch {}
  }
  const t = await addTodo({ owner: 'will', section: 'Quoting', text: st.text(name) + draftNote, due: today, ref: name + ' · auto' });
  s.follow[p.id] = { stage: f.stage + 1, lastAt: new Date().toISOString(), todoId: t.id };
  s.followDay.count++;
  return true;
}

// Always run as Will: these jobs use his Gmail and calendar, even when Ethan's dashboard is what triggered the check.
export const runAutomations = (opts = {}) => runAs('will', () => automationsAsWill(opts));
async function automationsAsWill({ force = false } = {}) {
  const s = (await store().get(STATE, { type: 'json' })) || {};
  if (!force && s.lastRun && Date.now() - Date.parse(s.lastRun) < 15 * 60000) return { skipped: 'ran recently' };
  s.signed = s.signed || []; s.followed = s.followed || []; s.signedLog = s.signedLog || []; s.commissioned = s.commissioned || []; s.kits = s.kits || {};
  const first = !s.lastRun, added = [], started = Date.now();
  const google = await googleStatus().catch(() => ({ connected: false }));   // Will's Google (background jobs run as Will)

  if (pylonReady()) {
    // newest projects (last ~60): enough for a small team
    let url = '/solar_projects?sort=created_at.desc&filter[is_archived]=false', projects = [];
    for (let page = 0; url && page < 4; page++) { const d = await pylon(url.replace('https://api.getpylon.com/v1', '')); projects = projects.concat(d.data || []); url = d.links && d.links.next; }
    const today = melbToday(0), budget = { drafts: 2, started };
    s.follow = s.follow || {}; s.followDay = s.followDay && s.followDay.date === today ? s.followDay : { date: today, count: 0 };
    // older single follow-ups count as stage 1 already done
    (s.followed || []).forEach((id) => { if (!s.follow[id]) s.follow[id] = { stage: 1, lastAt: s.lastRun || new Date().toISOString(), migrated: true }; });
    s.followed = [];
    const todos = await loadTodos();
    budget.todos = todos;
    for (const raw of projects) {
      const p = pylonProject(raw), name = (p.customer && p.customer.name) || p.address || 'customer', attrs = raw.attributes || {};
      if (p.sold && !s.signed.includes(p.id)) {
        s.signed.push(p.id);
        if (first) continue;   // first run: remember what is already signed, don't flood the list with old jobs
        s.signedLog.push({ name, at: new Date().toISOString() });
        const ds = await pylon('/solar_designs?filter[project]=' + encodeURIComponent(p.id) + '&fields[solar_designs]=' + DESIGN_FIELDS).catch(() => ({ data: [] }));
        const designs = (ds.data || []).map(pylonDesign);
        const design = designs.find((x) => x.id === p.signed_design_id) || designs.find((x) => x.primary) || designs[0];
        for (const t of signedTasks(name, design)) added.push(await addTodo({ ...t, ref: name + ' · auto' }));
        s.kits = s.kits || {}; s.kits[norm(name)] = kitOf(design);
      }
      if (p.sold || !attrs.is_committed || !p.primary_design_id) continue;
      p.createdAt = attrs.created_at;
      if (await followUpStep(s, p, name, google, today, budget)) added.push('follow-up');
    }
  }

  // Install bookings in Will's calendar (events with "install" in the title) drive three reminders:
  //   a week before  → Ethan: order the stock (with the kit from the signed design)
  //   install day    → Will: create the CES and send it to the inspector
  //   2 weeks after  → Will: lodge the DNSP commissioning notice (once the inspector has inspected)
  if (google.connected && (!s.calCheckedAt || Date.now() - Date.parse(s.calCheckedAt) > 2 * 3600e3)) {
    s.calCheckedAt = new Date().toISOString();
    s.installs = s.installs || {};
    (s.commissioned || []).forEach((id) => { if (!s.installs[id]) s.installs[id] = { stock: true, ces: true, comm: true }; });   // done under the old rules
    s.commissioned = [];
    try {
      const q = new URLSearchParams({ q: 'install', singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(Date.now() - 20 * 864e5).toISOString(), timeMax: new Date(Date.now() + 9 * 864e5).toISOString(), maxResults: '50' });
      const ev = await g(CAL + '/events?' + q);
      const today = melbToday(0), inDays = (n) => melbToday(n);
      const toDay = (x) => x && (x.date || (x.dateTime && new Date(x.dateTime).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }))) || '';
      for (const e of ev.items || []) {
        if (!/install/i.test(e.summary || '') || e.status === 'cancelled') continue;
        const day = toDay(e.start); if (!day) continue;
        const who = custOf(e.summary), rec = s.installs[e.id] || {};
        // the first check under these rules: jobs already booked got their stock reminder at signing, and old installs are done
        if (first || !s.installsInit) { if (!s.installs[e.id]) s.installs[e.id] = { stock: true, ces: day < inDays(-1), comm: day <= inDays(-14), day }; continue; }
        rec.day = day;
        if (!rec.stock && day <= inDays(7) && day > today) {
          const kit = kitFor(s, who), due = new Date(Date.parse(day + 'T12:00:00Z') - 7 * 864e5).toISOString().slice(0, 10);
          added.push(await addTodo({ owner: 'ethan', section: 'Order stock', text: 'Order stock for ' + who + ' (install ' + day + ')' + (kit ? ': ' + kit : ''), due: due < today ? today : due, ref: who + ' · auto' }));
          rec.stock = true;
        }
        if (!rec.ces && day <= today) {
          added.push(await addTodo({ owner: 'will', section: 'DNSP', text: 'Create the CES for ' + who + ' and send it to the inspector', due: day < inDays(-1) ? today : day, ref: who + ' · auto' }));
          rec.ces = true;
        }
        if (!rec.comm && day <= inDays(-14)) {
          added.push(await addTodo({ owner: 'will', section: 'DNSP', text: 'Lodge the DNSP commissioning notice for ' + who + ' (installed ' + day + ', inspection should be done)', due: today, ref: who + ' · auto' }));
          rec.comm = true;
        }
        s.installs[e.id] = rec;
      }
      s.installsInit = true;
    } catch {}
  }

  // Monday morning summary email (once a week)
  try { await sendWeeklySummaries(s); } catch {}

  s.signed = s.signed.slice(-500);
  if (s.installs) for (const k of Object.keys(s.installs)) if (s.installs[k].day && s.installs[k].day < melbToday(-40)) delete s.installs[k];
  if (s.kits && Object.keys(s.kits).length > 200) s.kits = Object.fromEntries(Object.entries(s.kits).slice(-200));
  if (s.follow) for (const k of Object.keys(s.follow)) if (s.follow[k].stopped || s.follow[k].stage >= 3) { if (Date.now() - Date.parse(s.follow[k].lastAt || 0) > 90 * 864e5) { delete s.follow[k]; if (s.designAt) delete s.designAt[k]; } }
  s.signedLog = s.signedLog.filter((x) => Date.now() - Date.parse(x.at) < 30 * 864e5);
  s.lastRun = new Date().toISOString();
  await store().setJSON(STATE, s);
  return { added: added.length, first };
}
