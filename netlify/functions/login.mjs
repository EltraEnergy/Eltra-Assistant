// GET: who's logged in · POST { password }: log in (Will or Ethan) · DELETE: log out
import { json, checkPassword, sessionCookie, clearCookie, sessionUser, userName, store } from '../lib/util.mjs';

// 5 wrong passwords from one connection within 15 minutes locks logins from it for 15 minutes.
const MAX = 5, WINDOW = 15 * 60000;
const ipOf = (req) => (req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || 'unknown').trim();
async function fails() { return (await store().get('login-fails', { type: 'json' }).catch(() => null)) || {}; }
async function saveFails(f) { const now = Date.now(); for (const k of Object.keys(f)) if (now - f[k].first > WINDOW && (!f[k].until || f[k].until < now)) delete f[k]; await store().setJSON('login-fails', f); }
export default async (req) => {
  if (req.method === 'GET') { const u = sessionUser(req); return json(200, { loggedIn: !!u, user: u, name: u ? userName(u) : null }); }
  if (req.method === 'DELETE') return json(200, { ok: true }, { 'Set-Cookie': clearCookie() });
  if (req.method !== 'POST' || req.headers.get('x-eltra') !== '1') return json(403, { error: 'Bad request' });
  await new Promise((r) => setTimeout(r, 400));   // slows down password guessing
  const b = await req.json().catch(() => ({}));
  if (!process.env.AGENT_PASSWORD) return json(503, { error: 'AGENT_PASSWORD isn’t set in Netlify yet.' });
  const ip = ipOf(req), f = await fails(), rec = f[ip];
  if (rec && rec.until && rec.until > Date.now()) return json(429, { error: 'Too many wrong passwords. Try again in ' + Math.ceil((rec.until - Date.now()) / 60000) + ' minutes.' });
  const user = checkPassword(b.password);
  if (!user) {
    const now = Date.now(), r = rec && now - rec.first < WINDOW ? rec : { first: now, count: 0 };
    r.count++; if (r.count >= MAX) r.until = now + WINDOW;
    f[ip] = r; await saveFails(f);
    return json(r.until ? 429 : 401, { error: r.until ? 'Too many wrong passwords. Try again in 15 minutes.' : 'That password isn’t right.' + (MAX - r.count <= 2 ? ' ' + (MAX - r.count) + ' tr' + (MAX - r.count === 1 ? 'y' : 'ies') + ' left before a 15-minute lock.' : '') });
  }
  if (rec) { delete f[ip]; await saveFails(f); }
  return json(200, { loggedIn: true, user, name: userName(user) }, { 'Set-Cookie': sessionCookie(user) });
};
