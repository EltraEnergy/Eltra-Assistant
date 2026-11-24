// Install an update from a zip (Will only). The dashboard reads the zip and POSTs { target: eltra | quote, name, files: [{ path, data (base64) }] }.
// The files go on a new GitHub branch with a pull request, and the update shows in the improvement ideas until Will makes it live.
import { json, guard, currentUser } from '../lib/util.mjs';
import { addUpdate } from '../lib/improve.mjs';
import { UPDATE_PATH } from '../lib/codebuild.mjs';
const MAX = 5 * 1024 * 1024;
export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  if (req.method !== 'POST') return json(405, { error: 'Not allowed' });
  if (currentUser() !== 'will') return json(403, { error: 'Only Will can install updates.' });
  try {
    if (+(req.headers.get('content-length') || 0) > MAX) return json(413, { error: 'That update is too big (5 MB max).' });
    const raw = await req.text();
    if (raw.length > MAX) return json(413, { error: 'That update is too big (5 MB max).' });
    const b = JSON.parse(raw || '{}');
    if (b.target !== 'eltra' && b.target !== 'quote') return json(400, { error: 'Pick Eltra or the Quote app.' });
    const files = Array.isArray(b.files) ? b.files : [];
    if (!files.length) return json(400, { error: 'There are no files to install.' });
    if (files.length > 400) return json(400, { error: 'That’s too many files for one update (400 max).' });
    const seen = new Set();
    for (const f of files) {
      if (!f || !UPDATE_PATH(f.path)) return json(400, { error: 'Only files in netlify/, public/ or top-level .md files can be installed: ' + String(f && f.path).slice(0, 120) });
      if (typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return json(400, { error: 'Couldn’t read ' + f.path });
      if (seen.has(f.path)) return json(400, { error: f.path + ' is in the zip twice.' }); seen.add(f.path);
    }
    const it = await addUpdate(b.target, files.map((f) => ({ path: f.path, data: f.data })), String(b.name || '').slice(0, 80));
    return json(200, { item: it });
  } catch (e) { return json(400, { error: e.message }); }
};
