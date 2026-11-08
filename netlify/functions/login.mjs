// Log in with AGENT_PASSWORD (POST), check the session (GET), log out (DELETE).
import { json, checkPassword, sessionCookie, clearCookie, loggedIn } from '../lib/util.mjs';

const tries = new Map(); // simple slow-down for wrong passwords (per running instance)

export default async (req) => {
  if (req.method === 'GET') return json(200, { loggedIn: loggedIn(req), ready: !!(process.env.AGENT_PASSWORD && process.env.SESSION_SECRET && process.env.ANTHROPIC_API_KEY) });
  if (req.method === 'DELETE') return json(200, { ok: true }, { 'Set-Cookie': clearCookie() });
  if (req.method !== 'POST' || req.headers.get('x-eltra') !== '1') return json(405, { error: 'Not allowed' });
  const ip = req.headers.get('x-nf-client-connection-ip') || 'x';
  const t = tries.get(ip) || { n: 0, at: 0 };
  if (t.n >= 5 && Date.now() - t.at < 10 * 60000) return json(429, { error: 'Too many tries. Wait 10 minutes.' });
  let b = {}; try { b = await req.json(); } catch {}
  if (!checkPassword(b.password)) {
    tries.set(ip, { n: t.n + 1, at: Date.now() });
    await new Promise((r) => setTimeout(r, 800));
    return json(401, { error: 'Wrong password' });
  }
  tries.delete(ip);
  try { return json(200, { ok: true }, { 'Set-Cookie': sessionCookie() }); }
  catch (e) { return json(500, { error: e.message }); }
};
