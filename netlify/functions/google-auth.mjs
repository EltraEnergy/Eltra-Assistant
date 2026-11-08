// Connect Will's Google account once. GET ?start=1 sends him to Google; Google sends him back here with a code,
// which is swapped for a refresh token and kept in Netlify Blobs (never shown anywhere).
import { json, loggedIn, signState, store } from '../lib/util.mjs';
import { SCOPES } from '../lib/google.mjs';

const page = (msg) => new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:-apple-system,Arial,sans-serif;padding:30px;max-width:520px;margin:auto"><p>' + msg + '</p><p><a href="/">Back to the dashboard</a></p></body>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

export default async (req) => {
  const url = new URL(req.url), id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect = url.origin + '/.netlify/functions/google-auth';
  if (!id || !secret) return page('Google isn’t set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Netlify.');
  if (!loggedIn(req)) return page('Please log in to the dashboard first.');

  if (url.searchParams.get('start')) {
    const nonce = Date.now().toString(36);
    const state = nonce + '.' + signState(nonce);
    const p = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + p } });
  }

  const code = url.searchParams.get('code'), state = url.searchParams.get('state') || '';
  if (url.searchParams.get('error')) return page('Google said: ' + url.searchParams.get('error') + '. Nothing was changed.');
  const [nonce, sig] = state.split('.');
  if (!code || !nonce || sig !== signState(nonce) || Date.now() - parseInt(nonce, 36) > 15 * 60000) return page('That link has expired. Go back and tap Connect Google again.');
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.refresh_token) return page('Couldn’t connect Google (' + (out.error_description || out.error || 'no refresh token') + '). Try again.');
  let email = null;
  try { email = JSON.parse(Buffer.from(String(out.id_token).split('.')[1], 'base64url').toString()).email; } catch {}
  await store().setJSON('google', { refresh_token: out.refresh_token, email, at: Date.now() });
  return new Response(null, { status: 302, headers: { Location: '/?google=connected' } });
};
