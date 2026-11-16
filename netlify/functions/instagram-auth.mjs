// Connect Instagram (Facebook Login for Business with the "Instagram API (unified login)" configuration).
// Start:    /.netlify/functions/instagram-auth?start=1
// Callback: Meta sends people back here with ?code=…&state=… (this exact URL is registered as the redirect URL)
import { sessionUser, signState, store, USERS } from '../lib/util.mjs';
import { igSetUp } from '../lib/instagram-api.mjs';

const page = (title, body) => new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;text-align:center;color:#14263D"><h1 style="font-size:22px">' + title + '</h1><p>' + body + '</p><p><a href="/" style="color:#1F6FE0">Back to the dashboard</a></p></body>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const url = new URL(req.url), redirect = url.origin + url.pathname;
  if (!igSetUp()) return page('Instagram isn’t set up', 'Add META_APP_ID, META_APP_SECRET and META_CONFIG_ID in Netlify first.');
  const appId = process.env.META_APP_ID, secret = process.env.META_APP_SECRET;

  if (url.searchParams.get('start')) {
    const user = sessionUser(req);
    if (!user) return page('Please log in first', 'Log in to the dashboard, then tap Connect Instagram again.');
    const raw = user + '.' + Date.now();
    const q = new URLSearchParams({ client_id: appId, config_id: process.env.META_CONFIG_ID, override_default_response_type: 'true', response_type: 'code', redirect_uri: redirect, state: raw + '.' + signState(raw) });
    return Response.redirect('https://www.facebook.com/dialog/oauth?' + q.toString(), 302);
  }

  if (url.searchParams.get('error')) return page('Instagram didn’t connect', (url.searchParams.get('error_description') || url.searchParams.get('error')).replace(/\+/g, ' ') + '.');
  const code = url.searchParams.get('code'), [user, ts, sig] = (url.searchParams.get('state') || '').split('.');
  if (!code || !USERS[user] || !sig || sig !== signState(user + '.' + ts) || Date.now() - +ts > 15 * 60000) return page('That link has expired', 'Go back to the dashboard and tap Connect Instagram again.');

  const tr = await fetch('https://graph.facebook.com/oauth/access_token?' + new URLSearchParams({ client_id: appId, client_secret: secret, redirect_uri: redirect, code }));
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.access_token) return page('Instagram didn’t connect', (tok.error && tok.error.message) || 'No access was granted.');

  // which Instagram account was granted: read it from the token's granted scopes
  const dbg = await (await fetch('https://graph.facebook.com/debug_token?' + new URLSearchParams({ input_token: tok.access_token, access_token: appId + '|' + secret }))).json().catch(() => ({}));
  const scopes = (dbg.data && dbg.data.granular_scopes) || [];
  const ids = [...new Set(scopes.filter((s) => /^instagram_/.test(s.scope)).flatMap((s) => s.target_ids || []))];
  let igId = ids[0] || null, username = null;
  if (!igId) {   // fallback: an Instagram account linked through a Facebook Page
    const pg = await (await fetch('https://graph.facebook.com/me/accounts?' + new URLSearchParams({ fields: 'instagram_business_account{id,username}', access_token: tok.access_token }))).json().catch(() => ({}));
    const hit = (pg.data || []).find((p) => p.instagram_business_account);
    if (hit) { igId = hit.instagram_business_account.id; username = hit.instagram_business_account.username; }
  }
  if (!igId) return page('No Instagram account was shared', 'When Meta asks which accounts to give access to, tick the Eltra Energy Instagram account, then try again.');
  if (!username) { const u = await (await fetch('https://graph.facebook.com/' + igId + '?' + new URLSearchParams({ fields: 'username', access_token: tok.access_token }))).json().catch(() => ({})); username = u.username || null; }
  await store().setJSON('instagram', { token: tok.access_token, igId, username, connectedBy: user, connectedAt: new Date().toISOString() });
  return new Response(null, { status: 302, headers: { Location: '/?instagram=connected' } });
};
