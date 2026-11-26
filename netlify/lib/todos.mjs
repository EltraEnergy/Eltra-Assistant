// To-do lists by section (DNSP, Quoting, Order stock, …), shared by the dashboard and Eltra.
import { store, currentUser, USERS } from './util.mjs';
import crypto from 'node:crypto';

const KEY = 'todos';
const DEFAULT_SECTIONS = ['DNSP', 'Quoting', 'Order stock', 'Install dates', 'Accounts', 'Socials', 'Admin'];
const ETHAN_SECTIONS = ['Install dates', 'Accounts', 'Socials'];
// DNSP is split into these sub-sections (Will asked for this), always shown together in this order
const DNSP_SUBS = ['DNSP - Pre approval', 'DNSP - Grid connection', 'DNSP - Solar Vic', 'DNSP - Retailer request'];
const DNSP_ORDER = ['DNSP - Solar Vic', 'DNSP - Pre approval', 'DNSP - CES', 'DNSP - Grid connection', 'DNSP - Retailer request'];   // the order the jobs happen
// Quoting sub-sections (Will asked for this), always shown together in this order. Follow-ups used to be their own "Follow ups" section.
const QUOTING_ORDER = ['Quoting - To quote', 'Quoting - Send proposal', 'Quoting - Follow ups'];
export const FOLLOW_UPS_SECTION = QUOTING_ORDER[2];
const OLD_FOLLOW_UPS = /^follow[\s-]*ups?$/i;
// Ethan looks after stock, socials, install dates and accounts/invoicing
const ETHAN_WORK = /(stock|install date|booking|account|invoic|social)/i;
// who a to-do is for: 'will', 'ethan' or 'both'
export const ownerOf = (v) => { const x = String(v || '').toLowerCase(); return x === 'both' || x === 'everyone' || x === 'team' ? 'both' : USERS[x] ? x : x === 'me' ? currentUser() : currentUser(); };
const str = (v, n) => String(v ?? '').trim().slice(0, n);
// a free-text note on a to-do (what a customer said, what it's waiting on, …)
const NOTE_MAX = 1000;
const noteOf = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, NOTE_MAX);
// urgency (Will asked for this): 'red' (urgent), 'yellow' (soon), 'green' (can wait), or '' for no rating
export const URGENCY = ['red', 'yellow', 'green'];
const urgencyOf = (v) => { const x = String(v ?? '').trim().toLowerCase(); return URGENCY.includes(x) ? x : ''; };
// what the dashboard shows: the set urgency, else from the due date (overdue/today red, within 3 days yellow, later green)
export function urgencyFor(x, today) {
  if (urgencyOf(x.urgency)) return urgencyOf(x.urgency);
  if (!x.due) return '';
  const t = today || new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
  const days = Math.round((Date.parse(x.due + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 864e5);
  return days <= 0 ? 'red' : days <= 3 ? 'yellow' : 'green';
}

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
  sections = orderDnsp(sections, d.items || []);
  // one-off: move everything in the old "Follow ups" section into "Quoting - Follow ups" and drop "Follow ups"
  if (!d.quotingFollowUps) sections = moveFollowUps(sections, d.items || []);
  sections = orderQuoting(sections, d.items || []);
  // to-dos from before Ethan joined have no owner: give his kind of work to him, the rest to Will
  const guessOwner = (x) => ETHAN_WORK.test(x.section || '') || /(book the install|install date|order stock|invoice|xero|myob|instagram|facebook)/i.test(x.text || '') ? 'ethan' : 'will';
  // (older to-dos have no 'by' field; ones you've deliberately reassigned are marked ownerSet)
  const items = (Array.isArray(d.items) ? d.items : []).map((x) => (x.by || x.ownerSet ? x : { ...x, owner: guessOwner(x) }));
  return { sections, items, teamSections: true, dnspSplit: true, quotingFollowUps: true };
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
// Will asked for this: the DNSP sub-sections always sit together in DNSP_ORDER, even when empty.
// Any other "DNSP - …" sub-sections follow them; every other section keeps its place.
function orderDnsp(sections, items) {
  const k = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const isDnsp = (s) => /^dnsp\s*([-–—:].*)?$/i.test(s);
  // a stored name that's the same as a fixed one bar case/spacing ("DNSP - Ces") becomes the fixed one, with its to-dos
  const fixed = (s) => DNSP_ORDER.find((n) => k(n) === k(s));
  items.forEach((x) => { const f = fixed(x.section); if (f) x.section = f; });
  const at = sections.findIndex(isDnsp), start = at < 0 ? 0 : at;
  const plain = sections.filter((s) => /^dnsp$/i.test(s));
  const extra = sections.filter((s) => isDnsp(s) && !/^dnsp$/i.test(s) && !fixed(s));
  const others = sections.filter((s) => !isDnsp(s));
  const before = sections.slice(0, start).filter((s) => !isDnsp(s));
  return [...before, ...plain, ...DNSP_ORDER, ...extra, ...others.slice(before.length)];
}
function moveFollowUps(sections, items) {
  // (open auto follow-up to-dos that were filed under plain "Quoting" move too)
  items.forEach((x) => { if (OLD_FOLLOW_UPS.test(x.section || '') || (!x.done && x.meta && x.meta.kind === 'followup' && /^quoting$/i.test(x.section || ''))) x.section = FOLLOW_UPS_SECTION; });
  return sections.filter((s) => !OLD_FOLLOW_UPS.test(s));
}
// Like DNSP: the Quoting sub-sections sit together in QUOTING_ORDER (after plain "Quoting" if it's still there), even when empty.
// Any other "Quoting - …" sub-sections follow them; every other section keeps its place.
function orderQuoting(sections, items) {
  const isQuoting = (s) => /^quoting\s*([-–—:].*)?$/i.test(s);
  const fixed = (s) => QUOTING_ORDER.find((n) => keyOf(n) === keyOf(s));
  items.forEach((x) => { const f = fixed(x.section); if (f) x.section = f; });
  const at = sections.findIndex(isQuoting);
  const plain = sections.filter((s) => /^quoting$/i.test(s));
  const extra = sections.filter((s) => isQuoting(s) && !/^quoting$/i.test(s) && !fixed(s));
  const others = sections.filter((s) => !isQuoting(s));
  const start = at < 0 ? others.length : sections.slice(0, at).filter((s) => !isQuoting(s)).length;
  return [...others.slice(0, start), ...plain, ...QUOTING_ORDER, ...extra, ...others.slice(start)];
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
  // "Follow ups" (the old section) now means "Quoting - Follow ups"
  if (/^(quoting)?followups?$/.test(key)) return d.sections.find((s) => s === FOLLOW_UPS_SECTION) || FOLLOW_UPS_SECTION;
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
    || (/solar ?vic/.test(low) && d.sections.find((s) => /^dnsp\b.*solar ?vic/i.test(s))) || (/retailer/.test(low) && d.sections.find((s) => /^dnsp\b.*retailer/i.test(s)))
    || (/(\bces\b|electrical safety)/.test(low) && d.sections.find((s) => /^dnsp\b.*\bces\b/i.test(s)));
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

function addOne(d, { section, text, due, ref, owner, meta, note, urgency }) {
  const item = { id: crypto.randomUUID().slice(0, 8), section: pickSection(d, section, true), text: str(text, 300), due: /^\d{4}-\d{2}-\d{2}$/.test(due || '') ? due : '', ref: str(ref, 200), owner: ownerOf(owner), by: currentUser(), done: false, createdAt: new Date().toISOString() };
  if (noteOf(note)) item.note = noteOf(note);
  if (urgencyOf(urgency)) item.urgency = urgencyOf(urgency);
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
  // note: replaces the note ('' clears it); append_note: adds a new line to the end of it
  if (patch.note !== undefined && patch.note !== null) { const n = noteOf(patch.note); if (n) it.note = n; else delete it.note; }
  if (patch.append_note) { const a = noteOf(patch.append_note); if (a) it.note = noteOf(it.note ? it.note + '\n' + a : a); }
  // urgency: red / yellow / green, or '' / 'none' to clear it
  if (patch.urgency !== undefined && patch.urgency !== null) { const u = urgencyOf(patch.urgency); if (u) it.urgency = u; else delete it.urgency; }
  if (patch.owner !== undefined) { it.owner = ownerOf(patch.owner); it.ownerSet = true; }
  if (patch.done !== undefined) {
    const was = !!it.done;
    it.done = !!patch.done; it.doneAt = it.done ? new Date().toISOString() : undefined;
    if (it.done && !was) dnspNextStep(d, it);
  }
  return it;
}
// DNSP pipeline (Will asked for this): ticking off a step leaves it in the done history and puts an open
// to-do for the same customer in the next step, so the job stays on the list until the retailer request is done.
const DNSP_NEXT = [
  { from: 'DNSP - Pre approval', to: 'DNSP - Grid connection', text: 'Grid connection' },
  { from: 'DNSP - Grid connection', to: 'DNSP - Retailer request', text: 'Confirm meter reconfigured' }
];
// who a to-do is about: its ref without the " · auto" tag (else the customer saved on it)
const customerOf = (x) => String(x.ref || (x.meta && x.meta.customer) || '').replace(/\s*·\s*auto\s*$/i, '').trim().toLowerCase();
function dnspNextStep(d, it) {
  const step = DNSP_NEXT.find((s) => keyOf(s.from) === keyOf(it.section));
  if (!step) return null;
  const who = customerOf(it), toKey = keyOf(step.to);
  // don't double up: an open to-do for this customer is already in the next step, or this one was moved on before
  const there = d.items.find((x) => x !== it && ((x.meta && x.meta.dnspFrom === it.id) || (!x.done && keyOf(x.section) === toKey && who && customerOf(x) === who)));
  if (there) return null;
  // no ref: keep what the old to-do said as the ref, so it's still clear which job it is
  return addOne(d, { section: step.to, text: step.text, ref: it.ref || it.text, owner: 'will', meta: { dnspFrom: it.id } });
}
export const addTodo = (input) => serial(async () => { const d = await loadTodos(), item = addOne(d, input); await save(d); return item; });
export const updateTodo = (id, patch) => serial(async () => { const d = await loadTodos(), it = updateOne(d, id, patch); await save(d); return it; });

// Several at once: apply each in turn to one copy of the list, save once, then read it back
// to check every change actually stuck. Returns one result per item, in order: { ok, item } or { ok: false, error }.
const same = (a, b) => ['text', 'section', 'due', 'done', 'note', 'urgency'].every((k) => (a[k] ?? '') === (b[k] ?? ''));
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
