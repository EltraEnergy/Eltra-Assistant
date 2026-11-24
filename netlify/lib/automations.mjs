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
import { loadJobs, saveJobs, upsertJob, setInstall } from './jobs.mjs';
import { openJobFolder, closeJobFolder } from './jobfolders.mjs';

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
async function followUpStep(s, p, name, google, today, budget) {   // google/budget.drafts no longer used for drafting
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
  // no email is written here: the Draft email button on this to-do asks Eltra to draft it in front of Will, for approval
  const t = await addTodo({ owner: 'will', section: 'Quoting', text: st.text(name), due: today, ref: name + ' · auto', meta: { kind: 'followup', stage: f.stage + 1, of: STAGE.length, customer: name, email: (p.customer && p.customer.email) || '', projectId: p.id, brief: st.brief, sentDays: Math.round(sentDays) } });
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
  const jobs = await loadJobs();

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
        const jb = upsertJob(jobs, { name, projectId: p.id, kit: kitOf(design) });
        // the customer's quote folder moves to Active Jobs, with subfolders
        if (google.connected) { try { Object.assign(jb, await openJobFolder(jb, p.address)); } catch (e) { jb.folderError = e.message; } }
      }
      if (p.sold || !attrs.is_committed || !p.primary_design_id) continue;
      p.createdAt = attrs.created_at;
      if (await followUpStep(s, p, name, google, today, budget)) added.push('follow-up');
    }
  }

  // 1. Calendars as a backup source of install dates: "Install – name" events in Will's or Ethan's calendar.
  if (!s.calCheckedAt || Date.now() - Date.parse(s.calCheckedAt) > 2 * 3600e3) {
    s.calCheckedAt = new Date().toISOString();
    for (const who of ['will', 'ethan']) {
      await runAs(who, async () => {
        const gs = await googleStatus().catch(() => ({}));
        if (!gs.connected) return;
        const q = new URLSearchParams({ q: 'install', singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(Date.now() - 20 * 864e5).toISOString(), timeMax: new Date(Date.now() + 120 * 864e5).toISOString(), maxResults: '100' });
        const ev = await g(CAL + '/events?' + q).catch(() => ({ items: [] }));
        const toDay = (x) => x && (x.date || (x.dateTime && new Date(x.dateTime).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }))) || '';
        for (const e of ev.items || []) {
          if (!/install/i.test(e.summary || '') || e.status === 'cancelled') continue;
          const day = toDay(e.start); if (day) setInstall(jobs, custOf(e.summary), day, 'calendar');
        }
      }).catch(() => {});
    }
  }

  // 2. Reminders from each job's install date:
  //    a week before → Ethan orders the stock (with the kit) · install day → Will creates the CES and sends it to the
  //    inspector · 2 weeks after → Will lodges the DNSP commissioning notice (once the inspector has been).
  {
    const today = melbToday(0), inDays = (n) => melbToday(n);
    // switching over from the calendar-only version: jobs already under way don't get repeat reminders
    if (!s.jobsInit) {
      for (const jb of jobs.list) if (jb.installDate) jb.flags = { ...(jb.flags || {}), stock: true, ces: jb.installDate < inDays(-1), comm: jb.installDate < today };
      s.jobsInit = true;
    }
    for (const jb of jobs.list) {
      const day = jb.installDate; if (!day || jb.closed) continue;
      jb.flags = jb.flags || {};
      if (first) { jb.flags = { stock: true, ces: day < inDays(-1), comm: day <= inDays(-14) }; continue; }
      if (!jb.flags.stock && day > today && day <= inDays(7)) {
        const due = new Date(Date.parse(day + 'T12:00:00Z') - 7 * 864e5).toISOString().slice(0, 10);
        added.push(await addTodo({ owner: 'ethan', section: 'Order stock', text: 'Order stock for ' + jb.name + ' (install ' + day + ')' + (jb.kit ? ': ' + jb.kit : ''), due: due < today ? today : due, ref: jb.name + ' · auto' }));
        jb.flags.stock = true;
      }
      if (!jb.flags.ces && day <= today && day >= inDays(-3)) {
        added.push(await addTodo({ owner: 'will', section: 'DNSP', text: 'Create the CES for ' + jb.name + ' and send it to the inspector', due: today, ref: jb.name + ' · auto' }));
        jb.flags.ces = true;
      }
      if (!jb.flags.comm && day <= inDays(-14)) {
        const ct = await addTodo({ owner: 'will', section: 'DNSP', text: 'Lodge the DNSP commissioning notice for ' + jb.name + ' (installed ' + day + ', inspection should be done)', due: today, ref: jb.name + ' · auto' });
        added.push(ct); jb.commTodoId = ct.id;
        jb.flags.comm = true;
      }
      // commissioning ticked off → the job's Drive folder moves to Completed Jobs
      if (jb.commTodoId && jb.folderId && !jb.folderDone && google.connected) {
        const ct = (await loadTodos()).items.find((x) => x.id === jb.commTodoId);
        if (ct && ct.done) { try { if (await closeJobFolder(jb)) jb.folderDone = true; } catch (e) { jb.folderError = e.message; } }
      }
      if (jb.flags.comm && day < inDays(-60) && (jb.folderDone || !jb.folderId)) jb.closed = true;
    }
    await saveJobs(jobs);
  }

  // Monday morning summary email (once a week)
  try { await sendWeeklySummaries(s); } catch {}

  s.signed = s.signed.slice(-500);
  delete s.installs; delete s.kits;
  if (s.follow) for (const k of Object.keys(s.follow)) if (s.follow[k].stopped || s.follow[k].stage >= 3) { if (Date.now() - Date.parse(s.follow[k].lastAt || 0) > 90 * 864e5) { delete s.follow[k]; if (s.designAt) delete s.designAt[k]; } }
  s.signedLog = s.signedLog.filter((x) => Date.now() - Date.parse(x.at) < 30 * 864e5);
  s.lastRun = new Date().toISOString();
  await store().setJSON(STATE, s);
  return { added: added.length, first };
}
