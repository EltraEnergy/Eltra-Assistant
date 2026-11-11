// Shared bits for the Eltra agent functions: JSON replies, the login session and the storage.
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
});

export const store = () => getStore({ name: 'eltra-agent', consistency: 'strong' });

const COOKIE = 'eltra_s';
const DAYS = 30;
function sign(text) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error('SESSION_SECRET is not set (needs 16+ characters)');
  return createHmac('sha256', secret).update(text).digest('base64url');
}
function same(a, b) {
  const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export function checkPassword(pw) {
  const real = process.env.AGENT_PASSWORD;
  return !!real && real.length >= 8 && same(pw || '', real);
}
export function sessionCookie() {
  const exp = Date.now() + DAYS * 864e5;
  const val = exp + '.' + sign('s:' + exp);
  return COOKIE + '=' + val + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + DAYS * 86400;
}
export const clearCookie = () => COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

export function loggedIn(req) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  try { return same(sig, sign('s:' + exp)); } catch { return false; }
}
// Every request that changes anything must come from the app itself (with the session cookie and this header).
export function guard(req) {
  if (!loggedIn(req)) return json(401, { error: 'Please log in' });
  if (req.method === 'POST' && req.headers.get('x-eltra') !== '1') return json(403, { error: 'Bad request' });
  return null;
}
export const signState = (text) => sign('state:' + text);

export const tz = 'Australia/Melbourne';
export function melbNow() {
  return new Date().toLocaleString('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
// Start of "today" in Melbourne as a UTC Date
export function melbDayStart(offsetDays = 0) {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  const localMidnightAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  const offsetMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - Math.floor(now.getTime() / 60000) * 60000;
  return new Date(localMidnightAsUtc - offsetMs + offsetDays * 864e5);
}
export const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

// "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" in Melbourne time -> Date (handles daylight saving)
export function melbToDate(local) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return new Date(local);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  const off = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = guess - off(guess);
  t = guess - off(t);
  return new Date(t);
}
export const melbToday = (plusDays = 0) => new Date(Date.now() + plusDays * 864e5).toLocaleDateString('en-CA', { timeZone: tz });
