// Temporary public image links so Instagram can fetch photos and carousel slides to post.
// POST (logged in) { data: <base64 JPEG> } → { url }  ·  GET ?id&exp&sig → the image (links last 24 hours)
import { json, guard, store, signState } from '../lib/util.mjs';
import crypto from 'node:crypto';
export default async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const id = url.searchParams.get('id') || '', exp = url.searchParams.get('exp') || '', sig = url.searchParams.get('sig') || '';
    if (!/^[a-f0-9]{16}$/.test(id) || +exp < Date.now() || sig !== signState('media:' + id + ':' + exp)) return new Response('Not found', { status: 404 });
    const m = await store().get('media/' + id, { type: 'json' }).catch(() => null);
    if (!m) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(m.b64, 'base64'), { status: 200, headers: { 'Content-Type': m.type || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
  }
  const bad = guard(req); if (bad) return bad;
  const b = await req.json().catch(() => ({}));
  const data = String(b.data || '').replace(/^data:[^,]+,/, '');
  if (!data || data.length > 11e6) return json(400, { error: 'Image missing or too big (8 MB max)' });
  const id = crypto.randomBytes(8).toString('hex'), exp = String(Date.now() + 24 * 3600e3);
  await store().setJSON('media/' + id, { b64: data, type: 'image/jpeg', created: new Date().toISOString() });
  return json(200, { url: url.origin + url.pathname + '?' + new URLSearchParams({ id, exp, sig: signState('media:' + id + ':' + exp) }) });
};
