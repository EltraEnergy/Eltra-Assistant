// Automatic to-dos, so nothing slips:
//  • a Pylon proposal gets signed  → install booking and DNSP pre-approval to-dos (plus the welcome email to-do when WELCOME_EMAIL_TODO is on)
//  • a proposal has sat unsigned for 3+ days → a follow-up to-do (once per project)
//  • a proposal or signed design includes Solar Victoria (battery rebate or interest-free loan) → a "Lodge Solar Victoria application" to-do (once per project)
//  • an "Install - name" event appears in the calendar for a signed job → install date, DNSP pre-approval and stock to-dos, and a note to Will
//  • a site appointment in Will's calendar has finished → a "Send Pylon proposal to …" Quoting to-do (ticked off once it's sent)
//  • an install date check (customer asked by email/text if a date suits) → reads their reply: confirmed records the date,
//    a decline or other day is flagged to Ethan, no reply in 2 days → a follow-up to-do for Ethan (see install-check.mjs)
//  • every Monday morning → "Do payroll", every Saturday morning → "Do ServiceM8" (Ethan, Accounts, due that day)
// Runs on a schedule (functions/automations.mjs) and whenever the dashboard loads the to-do list (at most every 15 min).
import { store, runAs, melbToday } from './util.mjs';
import { addTodo, loadTodos, updateTodo } from './todos.mjs';
import { pylon, pylonReady, pylonProject, pylonDesign, DESIGN_FIELDS, toolByName, invitee } from './tools.mjs';
import { googleStatus, g, CAL, GMAIL } from './google.mjs';
import { claudeJSON } from './claude.mjs';
import { sendWeeklySummaries, sendTo } from './weekly.mjs';
import { loadJobs, saveJobs, upsertJob, setInstall, findJob, normName } from './jobs.mjs';
import { watchInstallChecks } from './install-check.mjs';

const STATE = 'automations';
const dayPlus = (n) => { const d = new Date(Date.now() + n * 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }); };

// Switched off until Will has written a welcome / next steps email template.
// Set to true (or set the Netlify env var WELCOME_EMAIL_TODO=on) to add the to-do again when a job is signed.
const WELCOME_EMAIL_TODO = false;
const welcomeEmailTodoOn = () => WELCOME_EMAIL_TODO || /^(1|true|on|yes)$/i.test(String(process.env.WELCOME_EMAIL_TODO || '').trim());

// What gets added when a job is signed. Sections must match (or loosely match) your to-do sections.
function signedTasks(name, design) {
  const kit = design ? [design.panels.join('; '), design.inverters.join('; '), design.batteries.join('; ')].filter(Boolean).join(' · ') : '';
  return [
    welcomeEmailTodoOn() && { section: 'Admin', text: 'Send ' + name + ' the welcome / next steps email', due: dayPlus(0), owner: 'will' },
    { section: 'Install dates', text: 'Book the install date with ' + name, due: dayPlus(1), owner: 'ethan' },
    { section: 'DNSP', text: 'Lodge the DNSP pre-approval for ' + name, due: dayPlus(1), owner: 'will' }
  ].filter(Boolean);   // ordering stock comes a week before the install date (see the install check)
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

// ---- Solar Victoria applications ----
// When a proposal (primary design) or the signed design mentions Solar Victoria – the battery rebate or the
// interest-free loan – add one "Lodge Solar Victoria application" to-do for Will. Each design is checked once,
// each project gets at most one to-do, and only a few designs are fetched per run to stay inside the time limit.
const SV_RE = /solar\s*vic(toria)?\b|\bsv\s+(battery\s+)?(rebate|loan)|interest[\s-]*free\s+loan/i;
const SV_PER_RUN = 4, SV_TEXT = 'Lodge Solar Victoria application';
const hasSolarVic = (raw) => !!raw && SV_RE.test(JSON.stringify(raw.attributes || {}));
async function solarVicStep(s, p, name, designIds, budget, loaded = []) {
  const sv = s.sv[p.id] = s.sv[p.id] || { checked: [] };
  if (sv.todoId) return false;                                       // already has its to-do
  for (const id of designIds) {
    if (!id || sv.checked.includes(id)) continue;
    let raw = loaded.find((x) => x && x.id === id);
    if (!raw) {
      if (budget.svFetches >= SV_PER_RUN || Date.now() - budget.started > 12000) return false;   // try again next run
      budget.svFetches++;
      const d = await pylon('/solar_designs/' + encodeURIComponent(id) + '?fields[solar_designs]=' + DESIGN_FIELDS).catch(() => null);
      if (!d || !d.data) continue;                                   // Pylon hiccup: not marked checked, so retried next run
      raw = d.data;
    }
    sv.checked.push(id);
    if (!hasSolarVic(raw)) continue;
    // no duplicates: reuse a matching to-do already on the list (ticked or not)
    const ref = name + ' · auto', low = norm(name);
    const dupe = budget.todos.items.find((t) => t.text === SV_TEXT && norm(String(t.ref || '').replace(/ · auto$/, '')) === low);
    if (dupe) { sv.todoId = dupe.id; return false; }
    const t = await addTodo({ owner: 'will', section: 'Solar Victoria', text: SV_TEXT, due: melbToday(0), ref, meta: { kind: 'solarvic', customer: name, projectId: p.id, designId: id } });
    budget.todos.items.push(t);
    sv.todoId = t.id; sv.at = new Date().toISOString();
    return t;
  }
  return false;
}

// ---- Installs booked in the calendar ----
// "Install - Sarah Smith" (or "Installation – …", "Install: …") → the customer name after the dash
const INSTALL_TITLE = /^\s*install(ation)?\s*[-–—:]\s*(.+?)\s*$/i;
// the signed Pylon job for a calendar name: exact name first, otherwise one clear loose match (never a guess between two)
function signedMatch(signedList, jobs, who) {
  const w = normName(who); if (w.length < 3) return null;
  const pool = signedList.concat(jobs.list.filter((j) => j.projectId && !j.unsigned && !j.closed).map((j) => ({ name: j.name, projectId: j.projectId })));
  const exact = pool.find((p) => normName(p.name) === w); if (exact) return exact;
  const loose = pool.filter((p) => { const n = normName(p.name); return n.length >= 3 && (w.includes(n) || n.includes(w)); });
  return new Set(loose.map((p) => p.projectId)).size === 1 ? loose[0] : null;
}
const before = (day, n, today) => { const d = new Date(Date.parse(day + 'T12:00:00Z') - n * 864e5).toISOString().slice(0, 10); return d < today ? today : d; };
// the to-dos for a newly booked install; returns a line for Will's note
async function installBooked(jb, today, added) {
  const todos = await loadTodos(), low = normName(jb.name), day = jb.installDate, done = [];
  const forJob = (re) => todos.items.find((t) => re.test(t.text || '') && normName(t.text).includes(low));
  // DNSP pre-approval for Will, due a week before the install (or today if it's sooner). Reuse an open one from signing.
  const dnspDue = before(day, 7, today), dnsp = forJob(/dnsp pre.?approval/i);
  if (dnsp && dnsp.done) done.push('DNSP pre-approval already lodged');
  else if (dnsp) { if (!dnsp.due || dnsp.due > dnspDue) await updateTodo(dnsp.id, { due: dnspDue }); done.push('DNSP pre-approval to-do (yours) now due ' + dnspDue); }
  else { added.push(await addTodo({ owner: 'will', section: 'DNSP', text: 'Lodge the DNSP pre-approval for ' + jb.name + ' (install ' + day + ')', due: dnspDue, ref: jb.name + ' · auto' })); done.push('DNSP pre-approval to-do for you, due ' + dnspDue); }
  // stock order for Ethan, a week before the install (once only: the week-before reminder below then skips it)
  if (forJob(/order stock/i)) done.push('stock order to-do for Ethan was already there');
  else { added.push(await addTodo({ owner: 'ethan', section: 'Order stock', text: 'Order stock for ' + jb.name + ' (install ' + day + ')' + (jb.kit ? ': ' + jb.kit : ''), due: before(day, 7, today), ref: jb.name + ' · auto' })); done.push('stock order to-do for Ethan'); }
  jb.flags = { ...(jb.flags || {}), stock: true };
  return { name: jb.name, day, done };
}
// a short email to Will (from his own Gmail to himself) listing what was added
async function installNotice(notes) {
  const gs = await googleStatus().catch(() => ({}));
  if (!notes.length || !gs.connected || !gs.email) return;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const subject = notes.length === 1 ? 'Install booked: ' + notes[0].name + ', ' + fmt(notes[0].day) : notes.length + ' installs booked in the calendar';
  const text = 'Eltra spotted ' + (notes.length === 1 ? 'a new install' : 'new installs') + ' in the calendar for signed jobs:\n\n' + notes.map((n) => '• ' + n.name + ' – ' + fmt(n.day) + '\n  ' + n.done.join('\n  ')).join('\n') + '\n\nOpen Eltra to see the to-dos.';
  const html = '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#14263D;max-width:560px"><p>Eltra spotted ' + (notes.length === 1 ? 'a new install' : 'new installs') + ' in the calendar for signed jobs:</p><ul>' +
    notes.map((n) => '<li><b>' + esc(n.name) + '</b> – ' + fmt(n.day) + '<br><span style="color:#5D6E82">' + n.done.map(esc).join('<br>') + '</span></li>').join('') +
    '</ul><p style="color:#5D6E82;font-size:13px">Open Eltra to see the to-dos: <a href="https://eltra-assistant.netlify.app">eltra-assistant.netlify.app</a></p></div>';
  await sendTo(gs.email, { subject, html, text });
}

// ---- Site appointments → "Send Pylon proposal" to-do ----
// Once a site appointment in Will's calendar has finished, add one Quoting to-do for Will, due the day of the visit:
// "Send Pylon proposal to <name> (<address>)". A site appointment is a timed event whose title or description says
// site visit / appointment / assessment / consult / quote (GoHighLevel bookings included), or one titled with just a
// customer name and a street address as its location. Installs, inspections, service jobs, phone or video calls and
// personal events are skipped. No doubles, and none if that customer's Pylon job is already signed or a proposal was
// made on or after the visit. Open ones are ticked off once the proposal has gone out (see siteProposalSent).
const SITE_WORDS = /\bsite\b|appointment|assessment|consult|\bquote|\bsales\b/i;
const NOT_SITE = /\binstall|\bcommission|\binspect|\bservice|\bmaintenance|\brepair|\bwarranty|\bphone\b|\bcalls?\b|\bzoom\b|\bteams\b|\bmeet\b|\bwebinar|\bbirthday|\banniversary|\bdentist|\bdoctor|\bphysio|\bgym\b|\bdinner|\blunch|\bbreakfast|\bdrinks\b|\bschool|\bholiday|\bleave\b|\bpersonal\b|\bprivate\b|\bpick ?up\b|\bdrop ?off\b|\bfooty\b|\bwedding|\bhaircut|\bdelivery\b|\bpickup\b|\bdeposit\b|\bvet\b|\bhair|\bnails\b|\bmassage|\boptometrist|\bmechanic|\brego\b|\bcar\b/i;
const STREET = /\d+[a-z]?\s+[a-z' ]+\b(st|street|rd|road|ave|avenue|ct|court|cres|crescent|dr|drive|pde|parade|pl|place|way|lane|ln|bvd|blvd|boulevard|hwy|highway|cl|close|tce|terrace|gr|grove|cct|circuit|sq|square|rise|walk|track|trk)\b/i;
const looksAddress = (t) => !!t && !/^https?:/i.test(t) && STREET.test(t);
const SITE_FILLER = /\b(eltra|energy|solar|battery|batteries|site|visit|appointment|assessment|consult(ation)?|quote|quoting|sales|meeting|onsite|on|with|for|at|and|the|a|new|lead)\b/gi;
const cleanName = (t) => String(t || '').replace(SITE_FILLER, ' ').replace(/[-–—|:()[\]/,]/g, ' ').replace(/\s+/g, ' ').trim();
const isName = (t) => /^\p{L}[\p{L}'. -]{1,58}[\p{L}.]$/u.test(t);
// { name, address, email } when the event is a site appointment with a customer, otherwise null
function siteAppointment(e) {
  const title = String(e.summary || '').trim(), desc = String(e.description || '');
  if (!title || e.status === 'cancelled' || !(e.start && e.start.dateTime && e.end && e.end.dateTime)) return null;   // all-day events are installs or personal
  if (e.eventType && e.eventType !== 'default') return null;                                                        // out of office, focus time, working location
  if ((e.attendees || []).some((a) => a.self && a.responseStatus === 'declined')) return null;
  if (NOT_SITE.test(title)) return null;
  const who = invitee(desc);
  const parts = title.split(/\s+[-–—|:]\s+|[–—|:]/).map((x) => x.trim()).filter(Boolean);
  const address = (looksAddress(e.location) && e.location) || (who && who.address) || parts.find(looksAddress) || '';
  const site = SITE_WORDS.test(title) || /appointment details|site visit|site assessment/i.test(desc) || !!who;
  let name = (who && who.name) || cleanName(parts.find((x) => !SITE_WORDS.test(x) && !looksAddress(x) && isName(cleanName(x))) || '') || cleanName(parts.filter((x) => !looksAddress(x)).join(' '));
  if (!isName(name)) return null;
  if (!who && !/\bsite\b/i.test(title + ' ' + desc) && name.split(' ').length < 2) return null;   // "Vet appointment" is not a customer
  if (!site && !(address && name.split(' ').length >= 2 && name.split(' ').length <= 4)) return null;   // "Sarah Smith" at "12 Smith St, …"
  return { name: name.replace(/\s+/g, ' '), address: String(address).replace(/,?\s*(australia|aus)\s*$/i, '').trim(), email: (who && who.email) || '' };
}
// the customer's Pylon project: exact name first, then one clear loose name match, then the street address
function pylonFor(projects, name, address) {
  const w = normName(name), list = (projects || []).map((raw) => ({ raw, p: pylonProject(raw) })).filter((x) => x.p.customer && x.p.customer.name);
  const exact = list.find((x) => normName(x.p.customer.name) === w); if (exact) return exact;
  const loose = list.filter((x) => { const n = normName(x.p.customer.name); return n.length >= 3 && w.length >= 3 && (w.includes(n) || n.includes(w)); });
  if (loose.length === 1) return loose[0];
  const street = normName(String(address || '').split(',')[0]);
  const byAddr = street.length >= 6 ? list.filter((x) => normName(x.p.address).startsWith(street)) : [];
  return byAddr.length === 1 ? byAddr[0] : null;
}
// has the proposal gone out since the visit? Pylon: job signed, or a proposal (primary design) made on or after the visit
// day. Gmail: Will has sent the customer an email about their proposal or quote since the visit.
async function siteProposalSent(s, ctx, m) {
  const hit = pylonFor(ctx.projects, m.customer, m.address);
  if (hit) {
    if (hit.p.sold) return 'signed in Pylon';
    const id = hit.p.primary_design_id;
    if (id && (hit.raw.attributes || {}).is_committed) {
      if (!s.site.designAt[id] && ctx.fetches < 4 && Date.now() < ctx.deadline) {
        ctx.fetches++;
        const d = await pylon('/solar_designs/' + encodeURIComponent(id) + '?fields[solar_designs]=created_at').catch(() => null);
        const at = d && d.data && d.data.attributes && d.data.attributes.created_at;
        if (at) s.site.designAt[id] = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
      }
      if (s.site.designAt[id] && s.site.designAt[id] >= m.day) return 'proposal made in Pylon';
    }
  }
  if (ctx.gmail && ctx.searches < 4 && Date.now() < ctx.deadline) {
    ctx.searches++;
    const q = 'in:sent after:' + m.day.replace(/-/g, '/') + ' (proposal OR quote OR pylon) ' + (m.email ? 'to:' + m.email : '"' + m.customer.replace(/"/g, '') + '"');
    const r = await g(GMAIL + '/messages?maxResults=1&q=' + encodeURIComponent(q)).catch(() => null);
    if (r && r.messages && r.messages.length) return 'proposal emailed';
  }
  return '';
}
async function siteAppointmentTodos(s, ctx, first) {
  s.site = s.site || { seen: {}, designAt: {} };
  const seed = !s.site.started; s.site.started = s.site.started || new Date().toISOString();
  const today = melbToday(0), out = [], ticked = [];
  const todos = await loadTodos();
  // 1. tick off open ones whose proposal has gone out
  for (const t of todos.items) {
    if (t.done || !t.meta || t.meta.kind !== 'siteproposal' || !t.meta.day || t.meta.day < melbToday(-30)) continue;
    const why = await siteProposalSent(s, ctx, t.meta);
    if (why) { await updateTodo(t.id, { done: true }); t.done = true; ticked.push(t.meta.customer + ' (' + why + ')'); }
  }
  // 2. finished site appointments from the last 3 days
  const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(Date.now() - 3 * 864e5).toISOString(), timeMax: new Date().toISOString(), maxResults: '100' });
  const ev = await g(CAL + '/events?' + q);
  for (const e of ev.items || []) {
    if (s.site.seen[e.id] || !e.end || !e.end.dateTime || Date.parse(e.end.dateTime) > Date.now()) continue;
    const day = new Date(e.start.dateTime).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    const appt = siteAppointment(e);
    if (!appt) continue;   // not marked seen, so a renamed event is looked at again next time
    // first run (of Eltra or of this check): remember earlier days' visits without adding to-dos for them
    if (first || (seed && day < today)) { s.site.seen[e.id] = 'before this check started'; continue; }
    const low = normName(appt.name);
    // no doubles: a proposal to-do for this customer that's still open, or added in the last fortnight
    const dupe = todos.items.find((t) => (t.meta && t.meta.kind === 'siteproposal' && t.meta.eventId === e.id) ||
      (/proposal/i.test(t.text || '') && normName(t.text).includes(low) && (!t.done || Date.now() - Date.parse(t.createdAt || 0) < 14 * 864e5)));
    if (dupe) { s.site.seen[e.id] = dupe.id; continue; }
    const meta = { kind: 'siteproposal', customer: appt.name, address: appt.address, email: appt.email, day, eventId: e.id };
    const sent = await siteProposalSent(s, ctx, meta);
    if (sent) { s.site.seen[e.id] = 'skipped: ' + sent; continue; }
    const t = await addTodo({ owner: 'will', section: 'Quoting', text: 'Send Pylon proposal to ' + appt.name + (appt.address ? ' (' + appt.address + ')' : ''), due: day, ref: appt.name + ' · auto', meta });
    todos.items.push(t); out.push(t);
    s.site.seen[e.id] = t.id;
  }
  const ids = Object.keys(s.site.seen); ids.slice(0, Math.max(0, ids.length - 300)).forEach((k) => delete s.site.seen[k]);
  const dz = Object.keys(s.site.designAt); dz.slice(0, Math.max(0, dz.length - 200)).forEach((k) => delete s.site.designAt[k]);
  if (ticked.length) console.log('site proposal to-dos ticked off:', ticked.join(', '));
  return out;
}

// Repeating weekly to-dos, added on the morning of the day (Melbourne time), due that day.
const WEEKLY = [
  { key: 'payroll', day: 'Mon', owner: 'ethan', section: 'Accounts', text: 'Do payroll' },
  { key: 'servicem8', day: 'Sat', owner: 'ethan', section: 'Accounts', text: 'Do ServiceM8' },
];
const WEEKLY_FROM_HOUR = 6;
function melbWeekdayHour() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: +p.hour };
}
async function weeklyTodos(s) {
  const { weekday, hour } = melbWeekdayHour(), today = melbToday(0), out = [];
  s.weeklyDone = s.weeklyDone || {};
  const due = WEEKLY.filter((w) => w.day === weekday && hour >= WEEKLY_FROM_HOUR && s.weeklyDone[w.key] !== today);
  if (!due.length) return out;
  const list = (await loadTodos()).items, same = (x, w) => String(x.text || '').trim().toLowerCase() === w.text.toLowerCase();
  for (const w of due) {
    // no doubling: skip if there's already one for today (ticked or not), or last week's is still open
    const have = list.some((x) => same(x, w) && (x.due === today || !x.done));
    if (!have) out.push(await addTodo({ owner: w.owner, section: w.section, text: w.text, due: today, ref: 'Weekly · auto' }));
    s.weeklyDone[w.key] = today;
  }
  return out;
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
  let signedList = [], pylonProjects = null;   // signed Pylon projects seen this run: { name, projectId }; all projects loaded

  // 0. Weekly repeating to-dos (done first so a Pylon or Google hiccup later can't hold them up)
  try { added.push(...(await weeklyTodos(s))); } catch (e) { console.log('weekly to-dos failed', e.message); }

  if (pylonReady()) {
    // newest projects (last ~60): enough for a small team
    let url = '/solar_projects?sort=created_at.desc&filter[is_archived]=false', projects = [];
    for (let page = 0; url && page < 4; page++) { const d = await pylon(url.replace('https://api.getpylon.com/v1', '')); projects = projects.concat(d.data || []); url = d.links && d.links.next; }
    pylonProjects = projects;
    signedList = projects.map(pylonProject).filter((p) => p.sold && p.customer && p.customer.name).map((p) => ({ name: p.customer.name, projectId: p.id }));
    const today = melbToday(0), budget = { drafts: 2, started };
    s.follow = s.follow || {}; s.followDay = s.followDay && s.followDay.date === today ? s.followDay : { date: today, count: 0 };
    // older single follow-ups count as stage 1 already done
    (s.followed || []).forEach((id) => { if (!s.follow[id]) s.follow[id] = { stage: 1, lastAt: s.lastRun || new Date().toISOString(), migrated: true }; });
    s.followed = [];
    const todos = await loadTodos();
    budget.todos = todos;
    // Solar Victoria check: on its first run, skip proposals older than 14 days so old jobs don't flood the list
    const svFirst = !s.sv; s.sv = s.sv || {}; budget.svFetches = 0;
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
        upsertJob(jobs, { name, projectId: p.id, kit: kitOf(design) });
        // just signed: check the signed design for Solar Victoria again (it may have changed since the proposal; designs already loaded)
        const signedId = p.signed_design_id || (design && design.id);
        if (s.sv[p.id]) s.sv[p.id].checked = s.sv[p.id].checked.filter((x) => x !== signedId);
        if (await solarVicStep(s, p, name, [signedId], budget, ds.data || [])) added.push('solar-vic');
      }
      // proposal made or signed: check the proposal (primary design) and the signed design for Solar Victoria
      if (attrs.is_committed && (p.primary_design_id || p.signed_design_id)) {
        const ids = [p.signed_design_id, p.primary_design_id].filter(Boolean);
        if (svFirst && !s.sv[p.id] && Date.now() - Date.parse(attrs.created_at || 0) > 14 * 864e5) s.sv[p.id] = { checked: ids, seeded: true };
        else if (await solarVicStep(s, p, name, ids, budget)) added.push('solar-vic');
      }
      if (p.sold || !attrs.is_committed || !p.primary_design_id) continue;
      p.createdAt = attrs.created_at;
      if (await followUpStep(s, p, name, google, today, budget)) added.push('follow-up');
    }
  }

  // 1. Calendars: "Install – name" events in Will's or Ethan's calendar, checked every hour.
  //    An event for a signed Pylon job that Eltra has no install date for yet is a newly booked install:
  //    record the date, add Will's DNSP pre-approval to-do (due before the install), make sure Ethan's stock
  //    order to-do exists, and email Will a short note of what was added. Other install events are still
  //    used as a backup source of install dates, as before.
  if (!s.calCheckedAt || Date.now() - Date.parse(s.calCheckedAt) > 55 * 60000) {
    s.calCheckedAt = new Date().toISOString();
    s.calSeen = s.calSeen || {};
    const found = [];
    for (const who of ['will', 'ethan']) {
      await runAs(who, async () => {
        const gs = await googleStatus().catch(() => ({}));
        if (!gs.connected) return;
        const q = new URLSearchParams({ q: 'install', singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(Date.now() - 20 * 864e5).toISOString(), timeMax: new Date(Date.now() + 120 * 864e5).toISOString(), maxResults: '100' });
        const ev = await g(CAL + '/events?' + q).catch(() => ({ items: [] }));
        const toDay = (x) => x && (x.date || (x.dateTime && new Date(x.dateTime).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }))) || '';
        for (const e of ev.items || []) {
          if (!/install/i.test(e.summary || '') || e.status === 'cancelled') continue;
          const day = toDay(e.start); if (day) found.push({ id: e.id, summary: e.summary, day });
        }
      }).catch(() => {});
    }
    if (found.length) {
      const today = melbToday(0), booked = [];
      for (const e of found) {
        const m = !s.calSeen[e.id] && !first && e.day >= today && String(e.summary).match(INSTALL_TITLE);
        const job = m && signedMatch(signedList, jobs, m[2]);
        if (job && !(findJob(jobs, job.name, job.projectId) || {}).installDate) {
          const jb = upsertJob(jobs, { name: job.name, projectId: job.projectId });
          setInstall(jobs, jb.name, e.day, 'calendar', jb.projectId);
          booked.push(jb);
        } else setInstall(jobs, custOf(e.summary), e.day, 'calendar');   // the backup, as before
        s.calSeen[e.id] = e.day;
      }
      if (booked.length) {
        await saveJobs(jobs);   // keep the dates even if a to-do or the email below fails
        const notes = [];
        for (const jb of booked) notes.push(await installBooked(jb, today, added));
        await installNotice(notes).catch((err) => console.log('install notice failed', err.message));
      }
    }
    const ids = Object.keys(s.calSeen); ids.slice(0, Math.max(0, ids.length - 300)).forEach((k) => delete s.calSeen[k]);
  }

  // 1b. Site appointments in Will's calendar that have finished → "Send Pylon proposal" Quoting to-dos (about hourly).
  //     Skipped on a dashboard load that has already used most of its time; the 30-minute schedule picks it up.
  if (google.connected && (!s.siteCheckedAt || Date.now() - Date.parse(s.siteCheckedAt) > 55 * 60000) && Date.now() - started < (force ? 15000 : 5000)) {
    s.siteCheckedAt = new Date().toISOString();
    try { added.push(...(await siteAppointmentTodos(s, { projects: pylonProjects, gmail: true, deadline: started + (force ? 22000 : 8000), fetches: 0, searches: 0 }, first))); }
    catch (e) { console.log('site appointment to-dos failed', e.message); }
  }

  // 1c. Install date checks: read customers' replies (email and text) to "does this date suit?". A confirmed date is
  //     recorded and gets the same to-dos as an install booked in the calendar. Skipped when short of time.
  if (!first && Date.now() - started < (force ? 16000 : 5000)) {
    try {
      const ok = await watchInstallChecks(jobs, { deadline: started + (force ? 22000 : 8000), added });
      if (ok.length) {
        await saveJobs(jobs);
        const today = melbToday(0);
        for (const jb of ok) await installBooked(jb, today, added);   // DNSP pre-approval (Will) and stock order (Ethan)
      }
    } catch (e) { console.log('install date checks failed', e.message); }
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
        added.push(await addTodo({ owner: 'will', section: 'DNSP', text: 'Lodge the DNSP commissioning notice for ' + jb.name + ' (installed ' + day + ', inspection should be done)', due: today, ref: jb.name + ' · auto' }));
        jb.flags.comm = true;
      }
      if (jb.flags.comm && day < inDays(-60)) jb.closed = true;
    }
    await saveJobs(jobs);
  }

  // Monday morning summary email (once a week)
  try { await sendWeeklySummaries(s); } catch {}

  s.signed = s.signed.slice(-500);
  if (s.sv) { const keys = Object.keys(s.sv); keys.slice(0, Math.max(0, keys.length - 300)).forEach((k) => delete s.sv[k]); }   // keep the newest 300 projects
  delete s.installs; delete s.kits;
  if (s.follow) for (const k of Object.keys(s.follow)) if (s.follow[k].stopped || s.follow[k].stage >= 3) { if (Date.now() - Date.parse(s.follow[k].lastAt || 0) > 90 * 864e5) { delete s.follow[k]; if (s.designAt) delete s.designAt[k]; } }
  s.signedLog = s.signedLog.filter((x) => Date.now() - Date.parse(x.at) < 30 * 864e5);
  s.lastRun = new Date().toISOString();
  await store().setJSON(STATE, s);
  return { added: added.length, first };
}
