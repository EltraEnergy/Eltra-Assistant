// Eltra's record of each signed job: customer, Pylon project, kit and install date. The install date can come from
// Ethan ticking "Book the install date" (dashboard asks for it), from anyone telling Eltra, or from an "Install – name"
// event in Will's or Ethan's calendar. The after-sale reminders (stock, CES, commissioning) run from this record.
import { store } from './util.mjs';
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
