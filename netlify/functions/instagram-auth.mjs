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

  // Which Instagram account was granted. System-user tokens don't always say, so try in turn: the token's granted
  // scopes, INSTAGRAM_ACCOUNT_ID from Netlify, then any Facebook Page link. Each candidate is checked against the token.
  const dbg = await (await fetch('https://graph.facebook.com/debug_token?' + new URLSearchParams({ input_token: tok.access_token, access_token: appId + '|' + secret }))).json().catch(() => ({}));
  const scopes = (dbg.data && dbg.data.granular_scopes) || [];
  const cands = [...new Set([
    ...scopes.filter((x) => /^instagram_/.test(x.scope)).flatMap((x) => x.target_ids || []),
    (process.env.INSTAGRAM_ACCOUNT_ID || '').trim(),
    ...scopes.flatMap((x) => x.target_ids || [])
  ].filter(Boolean))];
  const pg = await (await fetch('https://graph.facebook.com/me/accounts?' + new URLSearchParams({ fields: 'instagram_business_account{id,username}', access_token: tok.access_token }))).json().catch(() => ({}));
  (pg.data || []).forEach((p) => { if (p.instagram_business_account) cands.push(p.instagram_business_account.id); });
  let igId = null, username = null;
  for (const c of cands) {
    const u = await (await fetch('https://graph.facebook.com/' + encodeURIComponent(c) + '?' + new URLSearchParams({ fields: 'username', access_token: tok.access_token }))).json().catch(() => ({}));
    if (u && u.username) { igId = c; username = u.username; break; }
  }
  if (!igId) {
    const granted = scopes.map((x) => x.scope + (x.target_ids && x.target_ids.length ? ' (' + x.target_ids.length + ' asset' + (x.target_ids.length > 1 ? 's' : '') + ')' : '')).join(', ') || 'none listed';
    return page('No Instagram account was shared', 'Meta connected, but Eltra couldn’t reach an Instagram account with it. If it isn’t there yet, add INSTAGRAM_ACCOUNT_ID = 17841474006679183 in Netlify, redeploy and connect again. If it already is, send Claude a screenshot of this page. (Granted: ' + granted.replace(/[<>&]/g, '') + ')');
  }
  await store().setJSON('instagram', { token: tok.access_token, igId, username, connectedBy: user, connectedAt: new Date().toISOString() });
  return new Response(null, { status: 302, headers: { Location: '/?instagram=connected' } });
};
