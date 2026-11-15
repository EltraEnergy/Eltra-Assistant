import { json, guard } from '../lib/util.mjs';
import { loadPrefs, savePrefs } from '../lib/prefs.mjs';
export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  if (req.method === 'GET') return json(200, await loadPrefs());
  if (req.method !== 'POST') return json(405, { error: 'Not allowed' });
  return json(200, await savePrefs(await req.json().catch(() => ({}))));
};
