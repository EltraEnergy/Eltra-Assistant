// Google (Gmail, Calendar, Drive) for whoever is logged in: Will's account for Will, Ethan's for Ethan.
// Each person's refresh token is stored after they connect once through google-auth. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
import { store, currentUser } from './util.mjs';

// Will's token keeps its original key so his existing connection carries on working
export const googleKey = (user = currentUser()) => (user === 'will' ? 'google' : 'google:' + user);

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'openid', 'email'
];

const cache = {}; // per person: { token, exp }

export async function googleStatus() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return { setUp: false, connected: false };
  const g = await store().get(googleKey(), { type: 'json' }).catch(() => null);
  return { setUp: true, connected: !!(g && g.refresh_token), email: g && g.email };
}

export async function accessToken() {
  const u = currentUser(), c = cache[u];
  if (c && c.exp > Date.now() + 60000) return c.token;
  const g = await store().get(googleKey(u), { type: 'json' });
  if (!g || !g.refresh_token) throw new Error('Google isn’t connected yet. Tap Connect Google on the dashboard.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: g.refresh_token, grant_type: 'refresh_token' })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.access_token) {
    if (out.error === 'invalid_grant') throw new Error('Google access has expired. Tap Connect Google on the dashboard to reconnect.');
    throw new Error('Google sign-in failed (' + (out.error_description || out.error || res.status) + ')');
  }
  cache[u] = { token: out.access_token, exp: Date.now() + (out.expires_in || 3600) * 1000 };
  return cache[u].token;
}

// Calls a Google API and returns parsed JSON (or text for non-JSON responses).
export async function g(url, opts = {}) {
  const token = await accessToken();
  const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.body && !opts.raw ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!res.ok) throw new Error('Google error ' + res.status + ': ' + ((data && data.error && (data.error.message || data.error)) || text).toString().slice(0, 200));
  return data;
}

export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
export const DRIVE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';
