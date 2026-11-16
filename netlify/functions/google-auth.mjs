// Connect Google for the person who's logged in (Will → Will's account, Ethan → Ethan's account).
// Start:    /.netlify/functions/google-auth?start=1
// Callback: Google sends people back here with ?code=…&state=…
// The redirect URI registered in Google Cloud stays: https://<site>/.netlify/functions/google-auth
import { sessionUser, signState, store, USERS } from '../lib/util.mjs';
import { SCOPES, googleKey } from '../lib/google.mjs';

const page = (title, body) => new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;text-align:center;color:#14263D"><h1 style="font-size:22px">' + title + '</h1><p>' + body + '</p><p><a href="/" style="color:#1F6FE0">Back to the dashboard</a></p></body>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const url = new URL(req.url), redirect = url.origin + url.pathname;
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return page('Google isn’t set up', 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Netlify first.');

  if (url.searchParams.get('start')) {
    const user = sessionUser(req);
    if (!user) return page('Please log in first', 'Log in to the dashboard, then tap Connect Google again.');
    const raw = user + '.' + Date.now();
    const q = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state: raw + '.' + signState(raw) });
    return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString(), 302);
  }

  if (url.searchParams.get('error')) return page('Google didn’t connect', 'Google said: ' + url.searchParams.get('error').replace(/_/g, ' ') + '.');
  const code = url.searchParams.get('code'), state = url.searchParams.get('state') || '';
  const [user, ts, sig] = state.split('.');
  if (!code || !USERS[user] || !sig || sig !== signState(user + '.' + ts) || Date.now() - +ts > 15 * 60000) return page('That link has expired', 'Go back to the dashboard and tap Connect Google again.');

  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.refresh_token) return page('Google didn’t connect', (tok.error_description || tok.error || 'No access was granted') + '. Try Connect Google again and tick every permission.');
  let email = null;
  try { email = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString()).email; } catch {}
  await store().setJSON(googleKey(user), { refresh_token: tok.refresh_token, email, connectedAt: new Date().toISOString() });
  return new Response(null, { status: 302, headers: { Location: '/?google=connected' } });
};
