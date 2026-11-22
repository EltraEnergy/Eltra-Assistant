// Eltra's record of each signed job: customer, Pylon project, kit and install date. The install date can come from
// Ethan ticking "Book the install date" (dashboard asks for it), from anyone telling Eltra, or from an "Install – name"
// event in Will's or Ethan's calendar. The after-sale reminders (stock, CES, commissioning) run from this record.
import { store, melbToday } from './util.mjs';
import { loadTodos, updateTodo } from './todos.mjs';
import crypto from 'node:crypto';

const KEY = 'jobs';
export const normName = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export async function loadJobs() { const d = (await store().get(KEY, { type: 'json' })) || {}; return { list: Array.isArray(d.list) ? d.list : [] }; }
export const saveJobs = (d) => store().setJSON(KEY, { list: d.list.slice(-300) });

// find a job by customer name (loose match either way) or Pylon project id
export function findJob(d, who, projectId) {
  if (projectId) { const j = d.list.find((x) => x.projectId === projectId); if (j) return j; }
  const w = normName(who); if (!w) return null;
  const open = d.list.filter((x) => !x.closed);
  return open.find((x) => normName(x.name) === w) || open.find((x) => { const n = normName(x.name); return n && (w.includes(n) || n.includes(w)); }) || null;
}
export function upsertJob(d, { name, projectId, kit }) {
  let j = findJob(d, name, projectId);
  if (!j) { j = { id: crypto.randomBytes(5).toString('hex'), name, signedAt: new Date().toISOString(), flags: {} }; d.list.push(j); }
  if (projectId) j.projectId = projectId; if (kit) j.kit = kit; if (name && !j.name) j.name = name;
  return j;
}
// accepts 2026-11-25, 25/11, 25/11/2026, 25-11-26
export function parseDay(v) {
  const s = String(v || '').trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/))) {
    const now = new Date(), y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(now.getFullYear());
    let out = y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    if (!m[3] && Date.parse(out) < Date.now() - 60 * 864e5) out = (+y + 1) + out.slice(4);   // "25/1" in December means next year
    return isFinite(Date.parse(out)) ? out : null;
  }
  return null;
}
// set or move the install date. Dates someone gives always win; a calendar only fills a gap or updates its own date.
export function setInstall(d, who, day, source, projectId) {
  let j = findJob(d, who, projectId);
  if (!j) { j = upsertJob(d, { name: who, projectId }); j.unsigned = true; }
  if (source === 'calendar' && j.installDate && j.installSource && j.installSource !== 'calendar') return j;
  if (j.installDate !== day) { if (j.installDate) j.previousDate = j.installDate; j.installDate = day; j.installSource = source; j.installSetAt = new Date().toISOString(); j.flags = { ...j.flags, ces: false, comm: false }; }
  return j;
}

// ---- DNSP pre-approval to-do (Will) ----
// Added as soon as a job is signed ("Lodge the DNSP pre-approval for <customer>"), with no due date until the install
// date is known. Its due date is 7 days before the install (today if that has already passed) and follows the install
// date when it moves. job.dnspFor remembers which install date the to-do was last set for.
export const PRE_APPROVAL_SECTION = 'DNSP - Pre approval';
export const preApprovalText = (name) => 'Lodge the DNSP pre-approval for ' + name;
const PRE_RE = /dnsp pre.?approval/i;
const refName = (ref) => normName(String(ref || '').replace(/\s*·\s*auto\s*$/i, ''));
// the pre-approval to-do for a customer (open first, then a ticked one), or null
export function findPreApproval(items, name) {
  const low = normName(name); if (!low) return null;
  const pre = (items || []).filter((t) => PRE_RE.test(t.text || ''));
  // the customer as ref first, then their whole name in the text
  let hits = pre.filter((t) => refName(t.ref) === low);
  if (!hits.length) hits = pre.filter((t) => (' ' + normName(t.text) + ' ').includes(' ' + low + ' '));
  return hits.find((t) => !t.done) || hits[0] || null;
}
// the due date for an install day: 7 days before, never earlier than today
export function preApprovalDue(day, today = melbToday(0)) {
  const d = new Date(Date.parse(day + 'T12:00:00Z') - 7 * 864e5).toISOString().slice(0, 10);
  return d < today ? today : d;
}
// set or move the due date of each job's open pre-approval to-do to match its install date. Marks job.dnspFor;
// the caller saves the jobs afterwards. Returns how many to-dos were changed.
export async function syncPreApprovals(d, todos) {
  const pending = d.list.filter((j) => j.installDate && !j.closed && j.dnspFor !== j.installDate);
  if (!pending.length) return 0;
  const items = (todos || (await loadTodos())).items, today = melbToday(0);
  let changed = 0;
  for (const j of pending) {
    const t = findPreApproval(items, j.name);
    if (!t) continue;                                     // none for this customer: nothing to move (try again next time)
    if (!t.done) {
      const exact = preApprovalDue(j.installDate, '0000-00-00'), due = preApprovalDue(j.installDate, today);
      // a week-before day that has already passed: leave a to-do that is already due or overdue as it is
      const keep = exact < today && t.due && t.due <= today;
      if (!keep && t.due !== due) { await updateTodo(t.id, { due }); t.due = due; changed++; }
    }
    j.dnspFor = j.installDate;
  }
  return changed;
}
