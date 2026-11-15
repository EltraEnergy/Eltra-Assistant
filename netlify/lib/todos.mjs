// To-do lists by section (DNSP, Quoting, Order stock, …), shared by the dashboard and Eltra.
import { store } from './util.mjs';
import crypto from 'node:crypto';

const KEY = 'todos';
const DEFAULT_SECTIONS = ['DNSP', 'Quoting', 'Order stock', 'Admin'];
const str = (v, n) => String(v ?? '').trim().slice(0, n);

export async function loadTodos() {
  const d = (await store().get(KEY, { type: 'json' })) || {};
  return { sections: Array.isArray(d.sections) && d.sections.length ? d.sections : DEFAULT_SECTIONS.slice(), items: Array.isArray(d.items) ? d.items : [] };
}
const save = (d) => store().setJSON(KEY, d);

// match a section loosely: "dnsp", "stock", "order" → the right one; unknown names become a new section
function pickSection(d, name, create) {
  const n = str(name, 40); if (!n) return d.sections[0];
  const low = n.toLowerCase();
  const hit = d.sections.find((s) => s.toLowerCase() === low) || d.sections.find((s) => s.toLowerCase().includes(low) || low.includes(s.toLowerCase()))
    || (/(stock|order|buy|supplier)/.test(low) && d.sections.find((s) => /stock/i.test(s))) || (/(quote|proposal|pylon)/.test(low) && d.sections.find((s) => /quot/i.test(s)))
    || (/(dnsp|pre.?approval|grid|powercor|citipower|jemena|ausnet|united)/.test(low) && d.sections.find((s) => /dnsp/i.test(s)));
  if (hit) return hit;
  if (create) { d.sections.push(n); return n; }
  return d.sections[0];
}

export async function addTodo({ section, text, due, ref }) {
  const d = await loadTodos();
  const item = { id: crypto.randomUUID().slice(0, 8), section: pickSection(d, section, true), text: str(text, 300), due: /^\d{4}-\d{2}-\d{2}$/.test(due || '') ? due : '', ref: str(ref, 200), done: false, createdAt: new Date().toISOString() };
  if (!item.text) throw new Error('A to-do needs some text');
  d.items.push(item); await save(d); return item;
}
export async function updateTodo(id, patch) {
  const d = await loadTodos(), it = d.items.find((x) => x.id === id);
  if (!it) throw new Error('That to-do no longer exists');
  if (patch.text !== undefined) it.text = str(patch.text, 300) || it.text;
  if (patch.section !== undefined) it.section = pickSection(d, patch.section, true);
  if (patch.due !== undefined) it.due = /^\d{4}-\d{2}-\d{2}$/.test(patch.due || '') ? patch.due : '';
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
