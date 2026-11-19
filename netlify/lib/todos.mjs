// To-do lists by section (DNSP, Quoting, Order stock, …), shared by the dashboard and Eltra.
import { store, currentUser, USERS } from './util.mjs';
import crypto from 'node:crypto';

const KEY = 'todos';
const DEFAULT_SECTIONS = ['DNSP', 'Quoting', 'Order stock', 'Install dates', 'Accounts', 'Socials', 'Admin'];
const ETHAN_SECTIONS = ['Install dates', 'Accounts', 'Socials'];
// Ethan looks after stock, socials, install dates and accounts/invoicing
const ETHAN_WORK = /(stock|install date|booking|account|invoic|social)/i;
// who a to-do is for: 'will', 'ethan' or 'both'
export const ownerOf = (v) => { const x = String(v || '').toLowerCase(); return x === 'both' || x === 'everyone' || x === 'team' ? 'both' : USERS[x] ? x : x === 'me' ? currentUser() : currentUser(); };
const str = (v, n) => String(v ?? '').trim().slice(0, n);

export async function loadTodos() {
  const d = (await store().get(KEY, { type: 'json' })) || {};
  let sections = Array.isArray(d.sections) && d.sections.length ? d.sections.slice() : DEFAULT_SECTIONS.slice();
  // "Bookings" became "Install dates": fold it in
  const bi = sections.findIndex((x) => /^bookings?$/i.test(x)), ii = sections.findIndex((x) => /^install dates?$/i.test(x));
  if (bi >= 0) { if (ii >= 0) sections.splice(bi, 1); else sections[bi] = 'Install dates'; }
  (d.items || []).forEach((x) => { if (/^bookings?$/i.test(x.section || '')) x.section = 'Install dates'; });
  if (!d.teamSections) ETHAN_SECTIONS.forEach((x) => { if (!sections.some((y) => y.toLowerCase() === x.toLowerCase())) sections.splice(Math.max(0, sections.length - 1), 0, x); });   // one-off: add Ethan's sections
  // to-dos from before Ethan joined have no owner: give his kind of work to him, the rest to Will
  const guessOwner = (x) => ETHAN_WORK.test(x.section || '') || /(book the install|install date|order stock|invoice|xero|myob|instagram|facebook)/i.test(x.text || '') ? 'ethan' : 'will';
  // (older to-dos have no 'by' field; ones you've deliberately reassigned are marked ownerSet)
  const items = (Array.isArray(d.items) ? d.items : []).map((x) => (x.by || x.ownerSet ? x : { ...x, owner: guessOwner(x) }));
  return { sections, items, teamSections: true };
}
const save = (d) => store().setJSON(KEY, d);

// match a section loosely: "dnsp", "stock", "order" → the right one; unknown names become a new section
function pickSection(d, name, create) {
  const n = str(name, 40); if (!n) return d.sections[0];
  const low = n.toLowerCase();
  const hit = d.sections.find((s) => s.toLowerCase() === low) || d.sections.find((s) => s.toLowerCase().includes(low) || low.includes(s.toLowerCase()))
    || (/(stock|order|buy|supplier)/.test(low) && d.sections.find((s) => /stock/i.test(s))) || (/(quote|proposal|pylon)/.test(low) && d.sections.find((s) => /quot/i.test(s)))
    || (/(dnsp|pre.?approval|grid|powercor|citipower|jemena|ausnet|united)/.test(low) && d.sections.find((s) => /dnsp/i.test(s)))
    || (/(book|schedul|install date|calendar)/.test(low) && d.sections.find((s) => /install date|book/i.test(s)))
    || (/(account|invoice|xero|myob|bill|payment|bas|gst)/.test(low) && d.sections.find((s) => /account/i.test(s)))
    || (/(social|facebook|instagram|post|insta|fb)/.test(low) && d.sections.find((s) => /social/i.test(s)));
  if (hit) return hit;
  if (create) { d.sections.push(n); return n; }
  return d.sections[0];
}

export async function addTodo({ section, text, due, ref, owner, meta }) {
  const d = await loadTodos();
  const item = { id: crypto.randomUUID().slice(0, 8), section: pickSection(d, section, true), text: str(text, 300), due: /^\d{4}-\d{2}-\d{2}$/.test(due || '') ? due : '', ref: str(ref, 200), owner: ownerOf(owner), by: currentUser(), done: false, createdAt: new Date().toISOString() };
  if (meta && typeof meta === 'object') item.meta = JSON.parse(JSON.stringify(meta, (k, v) => (typeof v === 'string' ? v.slice(0, 300) : v)));
  if (!item.text) throw new Error('A to-do needs some text');
  d.items.push(item); await save(d); return item;
}
export async function updateTodo(id, patch) {
  const d = await loadTodos(), it = d.items.find((x) => x.id === id);
  if (!it) throw new Error('That to-do no longer exists');
  if (patch.text !== undefined) it.text = str(patch.text, 300) || it.text;
  if (patch.section !== undefined) it.section = pickSection(d, patch.section, true);
  if (patch.due !== undefined) it.due = /^\d{4}-\d{2}-\d{2}$/.test(patch.due || '') ? patch.due : '';
  if (patch.owner !== undefined) { it.owner = ownerOf(patch.owner); it.ownerSet = true; }
  if (patch.done !== undefined) { it.done = !!patch.done; it.doneAt = it.done ? new Date().toISOString() : undefined; }
  await save(d); return it;
}
export async function deleteTodo(id) { const d = await loadTodos(); d.items = d.items.filter((x) => x.id !== id); await save(d); }
export async function setSections(list) {
  const d = await loadTodos(), clean = [...new Set((Array.isArray(list) ? list : []).map((s) => str(s, 40)).filter(Boolean))].slice(0, 12);
  if (!clean.length) throw new Error('Keep at least one section');
  d.items.forEach((it) => { if (!clean.includes(it.section)) it.section = clean[0]; });
  d.sections = clean; await save(d); return d;
}
// tidy: drop finished items older than 30 days
export async function pruneTodos() {
  const d = await loadTodos(), cut = Date.now() - 30 * 864e5, before = d.items.length;
  d.items = d.items.filter((x) => !x.done || !x.doneAt || Date.parse(x.doneAt) > cut);
  if (d.items.length !== before) await save(d);
  return d;
}
