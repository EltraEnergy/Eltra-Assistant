// Temporary public image links so Instagram can fetch photos and carousel slides to post.
// POST (logged in) { data: <base64 JPEG> } → { url }  ·  GET or HEAD ?id&exp&sig → the image (links last 24 hours, or longer for scheduled posts)
// The links need no login and never redirect, and answer with Content-Type image/jpeg and a Content-Length, which Instagram's fetcher wants.
import { json, guard, store, signState } from '../lib/util.mjs';
import { checkImageLink } from '../lib/instagram-api.mjs';
import crypto from 'node:crypto';
export default async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET' || req.method === 'HEAD') {
    const id = url.searchParams.get('id') || '', exp = url.searchParams.get('exp') || '', sig = url.searchParams.get('sig') || '';
    if (!/^[a-f0-9]{16,28}$/.test(id) || +exp < Date.now() || sig !== signState('media:' + id + ':' + exp)) return new Response('Not found', { status: 404 });
    const m = await store().get('media/' + id, { type: 'json' }).catch(() => null);
    if (!m) return new Response('Not found', { status: 404 });
    const bytes = Buffer.from(m.b64, 'base64');
    const headers = { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length), 'Cache-Control': 'public, max-age=86400', 'Accept-Ranges': 'none' };
    return new Response(req.method === 'HEAD' ? null : bytes, { status: 200, headers });
  }
  const bad = guard(req); if (bad) return bad;
  const b = await req.json().catch(() => ({}));
  const data = String(b.data || '').replace(/^data:[^,]+,/, '').replace(/\s/g, '');
  if (!data) return json(400, { error: 'Image missing' });
  const bytes = Buffer.from(data, 'base64');
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return json(400, { error: 'That photo isn’t a JPEG, so Instagram can’t use it. Attach it again (the dashboard converts photos to JPEG).' });
  if (bytes.length > 8e6) return json(400, { error: 'That photo is over 8 MB, too big for Instagram. Attach a smaller one.' });
  const days = Math.max(1, Math.min(30, +b.days || 1));   // scheduled posts keep their images until a little after their date
  const id = Date.now().toString(16) + crypto.randomBytes(8).toString('hex'), exp = String(Date.now() + days * 24 * 3600e3);
  await store().setJSON('media/' + id, { b64: bytes.toString('base64'), type: 'image/jpeg', created: new Date().toISOString() });
  const link = url.origin + url.pathname + '?' + new URLSearchParams({ id, exp, sig: signState('media:' + id + ':' + exp) });
  // Self-check: fetch the link once, as Instagram would, so a broken link is reported now rather than at posting time
  const problem = await checkImageLink(link);
  if (problem) return json(502, { error: 'The photo was saved but its posting link doesn’t work: ' + problem + '.', url: link });
  return json(200, { url: link });
};
