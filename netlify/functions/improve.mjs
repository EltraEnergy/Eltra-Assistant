// Eltra's improvement proposals. GET: list. POST { id, action: approve | reject | done | undo }.
import { json, guard } from '../lib/util.mjs';
import { loadImprove, decide, logIssue } from '../lib/improve.mjs';
export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  try {
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (b.action === 'feedback') { await logIssue('feedback', '👎 on a reply. Asked: "' + String(b.asked || '').slice(0, 160) + '". Replied: "' + String(b.reply || '').slice(0, 260) + '"' + (b.note ? '. Note: ' + String(b.note).slice(0, 200) : '')); return json(200, { ok: true }); }
      await decide(b.id, b.action);
    }
    const d = await loadImprove();
    return json(200, { items: d.items.filter((x) => x.status !== 'rejected' || Date.now() - Date.parse(x.decidedAt || 0) < 7 * 864e5), reviewedAt: d.reviewedAt });
  } catch (e) { return json(400, { error: e.message }); }
};
