// GET: who's logged in · POST { password }: log in (Will or Ethan) · DELETE: log out
import { json, checkPassword, sessionCookie, clearCookie, sessionUser, userName } from '../lib/util.mjs';
export default async (req) => {
  if (req.method === 'GET') { const u = sessionUser(req); return json(200, { loggedIn: !!u, user: u, name: u ? userName(u) : null }); }
  if (req.method === 'DELETE') return json(200, { ok: true }, { 'Set-Cookie': clearCookie() });
  if (req.method !== 'POST' || req.headers.get('x-eltra') !== '1') return json(403, { error: 'Bad request' });
  await new Promise((r) => setTimeout(r, 400));   // slows down password guessing
  const b = await req.json().catch(() => ({}));
  if (!process.env.AGENT_PASSWORD) return json(503, { error: 'AGENT_PASSWORD isn’t set in Netlify yet.' });
  const user = checkPassword(b.password);
  if (!user) return json(401, { error: 'That password isn’t right.' });
  return json(200, { loggedIn: true, user, name: userName(user) }, { 'Set-Cookie': sessionCookie(user) });
};
