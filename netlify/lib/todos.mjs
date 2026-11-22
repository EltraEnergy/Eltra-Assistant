// To-do lists by section (DNSP, Quoting, Order stock, …), shared by the dashboard and Eltra.
import { store, currentUser, USERS } from './util.mjs';
import crypto from 'node:crypto';

const KEY = 'todos';
const DEFAULT_SECTIONS = ['DNSP', 'Quoting', 'Order stock', 'Install dates', 'Accounts', 'Socials', 'Admin'];
const ETHAN_SECTIONS = ['Install dates', 'Accounts', 'Socials'];
// DNSP is split into these sub-sections (Will asked for this)
const DNSP_SUBS = ['DNSP - Pre approval', 'DNSP - Grid connection', 'DNSP - Solar Vic', 'DNSP - Retailer request'];
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
  // one-off: split "DNSP" into its sub-sections and move the existing DNSP to-dos into the right one
  if (!d.dnspSplit) splitDnsp(sections, d.items || []);
  // to-dos from before Ethan joined have no owner: give his kind of work to him, the rest to Will
  const guessOwner = (x) => ETHAN_WORK.test(x.section || '') || /(book the install|install date|order stock|invoice|xero|myob|instagram|facebook)/i.test(x.text || '') ? 'ethan' : 'will';
  // (older to-dos have no 'by' field; ones you've deliberately reassigned are marked ownerSet)
  const items = (Array.isArray(d.items) ? d.items : []).map((x) => (x.by || x.ownerSet ? x : { ...x, owner: guessOwner(x) }));
  return { sections, items, teamSections: true, dnspSplit: true };
}
// which DNSP sub-section an old "DNSP" to-do belongs in (by what it says, then by the customers Will listed)
function dnspSubFor(x) {
  const t = ((x.text || '') + ' ' + (x.ref || '')).toLowerCase();
  if (/solar ?vic/.test(t)) return DNSP_SUBS[2];
  if (/retailer/.test(t)) return DNSP_SUBS[3];
  if (/(grid|connection|commission|\bces\b)/.test(t) || /(aryan|ameris|mathew bock|\bbock\b|natalie|thuy)/.test(t)) return DNSP_SUBS[1];
  if (/pre.?approv/.test(t) || /(alex wong|kirk|donaldson|brendan|boulus|george|mashalidis)/.test(t)) return DNSP_SUBS[0];
  return '';
}
function splitDnsp(sections, items) {
  const at = sections.findIndex((s) => /^dnsp$/i.test(s));
  const missing = DNSP_SUBS.filter((n) => !sections.some((s) => s.toLowerCase() === n.toLowerCase()));
  if (at < 0) return;   // no plain DNSP section (already split, or removed on purpose)
  sections.splice(at + 1, 0, ...missing);
  items.forEach((x) => { if (/^dnsp$/i.test(x.section || '')) { const to = dnspSubFor(x); if (to) x.section = sections.find((s) => s.toLowerCase() === to.toLowerCase()); } });
  // keep plain "DNSP" only while something is still in it
  if (!items.some((x) => /^dnsp$/i.test(x.section || ''))) sections.splice(sections.findIndex((s) => /^dnsp$/i.test(s)), 1);
}
const save = (d) => store().setJSON(KEY, d);
// One write at a time: each change loads, edits and saves the list before the next starts,
// so two changes made together can't overwrite each other.
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

// match a section loosely: "dnsp", "stock", "order" → the right one; unknown names become a new section.
// "Parent - Sub" names (e.g. "DNSP - Pre approval") are their own section, never folded into the parent.
const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function pickSection(d, name, create) {
  const n = str(name, 40); if (!n) return d.sections[0];
  const low = n.toLowerCase(), key = keyOf(n);
  const exact = d.sections.find((s) => s.toLowerCase() === low) || (key && d.sections.find((s) => keyOf(s) === key));
  if (exact) return exact;
  const sub = n.match(/^(.+?)\s*[-–—:]\s*(.+)$/);
  if (sub) {
    const pk = keyOf(sub[1]), parent = d.sections.find((s) => keyOf(s) === pk || keyOf(s.split(/\s+-\s+/)[0]) === pk);
    if (parent) {
      const name2 = parent.split(/\s+-\s+/)[0] + ' - ' + sub[2].trim();
      if (!create) return parent;
      let at = -1; d.sections.forEach((s, i) => { if (keyOf(s.split(/\s+-\s+/)[0]) === pk) at = i; });   // after the parent and its other sub-sections
      d.sections.splice(at + 1, 0, name2); return name2;
    }
  }
  // DNSP words go to the matching DNSP sub-section if there is one
  const dnspSub = (/pre.?approv/.test(low) && d.sections.find((s) => /^dnsp\b.*pre.?approv/i.test(s))) || (/(grid|connection)/.test(low) && d.sections.find((s) => /^dnsp\b.*grid/i.test(s)))
    || (/solar ?vic/.test(low) && d.sections.find((s) => /^dnsp\b.*solar ?vic/i.test(s))) || (/retailer/.test(low) && d.sections.find((s) => /^dnsp\b.*retailer/i.test(s)));
  const hit = dnspSub || d.sections.find((s) => s.toLowerCase().includes(low) || low.includes(s.toLowerCase()))
    || (/(stock|order|buy|supplier)/.test(low) && d.sections.find((s) => /stock/i.test(s))) || (/(quote|proposal|pylon)/.test(low) && d.sections.find((s) => /quot/i.test(s)))
    || (/(dnsp|pre.?approval|grid|powercor|citipower|jemena|ausnet|united)/.test(low) && d.sections.find((s) => /dnsp/i.test(s)))
    || (/(book|schedul|install date|calendar)/.test(low) && d.sections.find((s) => /install date|book/i.test(s)))
    || (/(account|invoice|xero|myob|bill|payment|bas|gst)/.test(low) && d.sections.find((s) => /account/i.test(s)))
    || (/(social|facebook|instagram|post|insta|fb)/.test(low) && d.sections.find((s) => /social/i.test(s)));
  if (hit) return hit;
  if (create) { d.sections.push(n); return n; }
  return d.sections[0];
}

function addOne(d, { section, text, due, ref, owner, meta }) {
  const item = { id: crypto.randomUUID().slice(0, 8), section: pickSection(d, section, true), text: str(text, 300), due: /^\d{4}-\d{2}-\d{2}$/.test(due || '') ? due : '', ref: str(ref, 200), owner: ownerOf(owner), by: currentUser(), done: false, createdAt: new Date().toISOString() };
  if (meta && typeof meta === 'object') item.meta = JSON.parse(JSON.stringify(meta, (k, v) => (typeof v === 'string' ? v.slice(0, 300) : v)));
  if (!item.text) throw new Error('A to-do needs some text');
  d.items.push(item); return item;
}
function updateOne(d, id, patch) {
  const it = d.items.find((x) => x.id === id);
  if (!it) throw new Error('That to-do no longer exists');
  if (patch.text !== undefined) it.text = str(patch.text, 300) || it.text;
  if (patch.section !== undefined) it.section = pickSection(d, patch.section, true);
  if (patch.due !== undefined) it.due = /^\d{4}-\d{2}-\d{2}$/.test(patch.due || '') ? patch.due : '';
  if (patch.owner !== undefined) { it.owner = ownerOf(patch.owner); it.ownerSet = true; }
  if (patch.done !== undefined) { it.done = !!patch.done; it.doneAt = it.done ? new Date().toISOString() : undefined; }
  return it;
}
export const addTodo = (input) => serial(async () => { const d = await loadTodos(), item = addOne(d, input); await save(d); return item; });
export const updateTodo = (id, patch) => serial(async () => { const d = await loadTodos(), it = updateOne(d, id, patch); await save(d); return it; });

// Several at once: apply each in turn to one copy of the list, save once, then read it back
// to check every change actually stuck. Returns one result per item, in order: { ok, item } or { ok: false, error }.
const same = (a, b) => ['text', 'section', 'due', 'done'].every((k) => (a[k] ?? '') === (b[k] ?? ''));
async function batch(list, apply) {
  return serial(async () => {
    const d = await loadTodos();
    const results = list.map((x) => { try { return { ok: true, item: apply(d, x) }; } catch (e) { return { ok: false, error: e.message || 'Failed' }; } });
    if (!results.some((r) => r.ok)) return results;
    try { await save(d); } catch (e) { return results.map((r) => (r.ok ? { ok: false, error: 'Not saved: ' + (e.message || 'storage error') } : r)); }
    const check = await loadTodos();
    return results.map((r) => {
      if (!r.ok) return r;
      const now = check.items.find((x) => x.id === r.item.id);
      return now && same(now, r.item) ? { ok: true, item: now } : { ok: false, error: 'Didn’t stick (something else changed the list at the same time). Please try this one again.' };
    });
  });
}
export const addTodos = (items) => batch(Array.isArray(items) ? items : [], addOne);
export const updateTodos = (updates) => batch(Array.isArray(updates) ? updates : [], (d, u) => updateOne(d, u && u.id, u || {}));
export const deleteTodo = (id) => serial(async () => { const d = await loadTodos(); d.items = d.items.filter((x) => x.id !== id); await save(d); });
export const setSections = (list) => serial(async () => {
  const d = await loadTodos(), clean = [...new Set((Array.isArray(list) ? list : []).map((s) => str(s, 40)).filter(Boolean))].slice(0, 16);
  if (!clean.length) throw new Error('Keep at least one section');
  d.items.forEach((it) => { if (!clean.includes(it.section)) it.section = clean[0]; });
  d.sections = clean; await save(d); return d;
});
// tidy: drop finished items older than 30 days
export const pruneTodos = () => serial(async () => {
  const d = await loadTodos(), cut = Date.now() - 30 * 864e5, before = d.items.length;
  d.items = d.items.filter((x) => !x.done || !x.doneAt || Date.parse(x.doneAt) > cut);
  if (d.items.length !== before) await save(d);
  return d;
});
