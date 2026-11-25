// Content schedule for the dashboard. GET: schedule + settings + what works. POST { action, id, … }.
import { json, guard } from '../lib/util.mjs';
import { loadContent, updateItem, deleteItems, addOwnIdea, saveSettings, saveContent } from '../lib/content.mjs';
export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  try {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (b.action === 'settings') await saveSettings(b);
      else if (b.action === 'wake') { const d = await loadContent(); d.wakeAt = new Date().toISOString(); await saveContent(d); }
      else if (b.action === 'delete') await deleteItems({ id: b.id });
      else if (b.action === 'add') await addOwnIdea(b);
      else if (b.action === 'clear_skipped') await deleteItems({ skipped: true });
      else await updateItem(b.id, b);
    }
    const d = await loadContent(), cut = Date.now() - 14 * 864e5;
    return json(200, { settings: d.settings, items: d.items.filter((x) => Date.parse(x.at || x.createdAt) > cut).sort((a, b) => (a.at || '').localeCompare(b.at || '')), learnings: d.learnings, log: d.log.slice(0, 8), lastRun: d.lastRun });
  } catch (e) { return json(400, { error: e.message }); }
};
