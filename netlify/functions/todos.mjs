// Dashboard to-do list: GET the lists, POST { action: add | update | delete | sections, … }
import { json, guard } from '../lib/util.mjs';
import { pruneTodos, addTodo, updateTodo, deleteTodo, setSections } from '../lib/todos.mjs';
import { runAutomations } from '../lib/automations.mjs';

export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  try {
    if (req.method === 'GET') { await runAutomations().catch(() => null); return json(200, await pruneTodos()); }
    if (req.method !== 'POST') return json(405, { error: 'Not allowed' });
    const b = await req.json().catch(() => ({}));
    if (b.action === 'add') await addTodo(b);
    else if (b.action === 'update') await updateTodo(b.id, b);
    else if (b.action === 'delete') await deleteTodo(b.id);
    else if (b.action === 'sections') await setSections(b.sections);
    else return json(400, { error: 'Unknown action' });
    return json(200, await pruneTodos());
  } catch (e) { return json(400, { error: e.message }); }
};
