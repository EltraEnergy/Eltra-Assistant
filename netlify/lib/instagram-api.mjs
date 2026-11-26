// Instagram for Eltra Energy through Meta's Instagram API (Facebook Login for Business, "unified login").
// Netlify env: META_APP_ID, META_APP_SECRET, META_CONFIG_ID. The never-expiring system-user token and the
// Instagram account id are saved once someone taps Connect Instagram. Shared by Will and Ethan (it's the business account).
import { store } from './util.mjs';

const FB = 'https://graph.facebook.com', IGG = 'https://graph.instagram.com';
// Two ways in: the Connect Instagram button (saved token), or a token generated in the Meta developer dashboard and put in
// Netlify as INSTAGRAM_ACCESS_TOKEN (+ INSTAGRAM_ACCOUNT_ID). Instagram-style tokens ("IG…") use graph.instagram.com and
// are refreshed automatically before their 60 days run out; Facebook-style tokens use graph.facebook.com.
const envToken = () => (process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();
export const igSetUp = () => !!(envToken() || (process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_CONFIG_ID));
const baseFor = (tok) => (/^IG/.test(tok || '') ? IGG : FB);
async function envAccount() {
  const env = envToken(); if (!env) return null;
  const tag = env.slice(-12), saved = await store().get('instagram-env', { type: 'json' }).catch(() => null);
  let token = saved && saved.tag === tag && saved.token ? saved.token : env, refreshed = saved && saved.tag === tag ? saved.refreshedAt : null, username = saved && saved.tag === tag ? saved.username : null;
  if (/^IG/.test(token) && (!refreshed || Date.now() - Date.parse(refreshed) > 20 * 864e5)) {
    const r = await fetch(IGG + '/refresh_access_token?' + new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })).then((x) => x.json()).catch(() => ({}));
    if (r.access_token) token = r.access_token;
    refreshed = new Date().toISOString();
  }
  const igId = (process.env.INSTAGRAM_ACCOUNT_ID || '').trim() || 'me';
  if (!username) { const u = await fetch(baseFor(token) + '/' + (baseFor(token) === IGG ? 'me' : igId) + '?' + new URLSearchParams({ fields: 'username', access_token: token })).then((x) => x.json()).catch(() => ({})); username = u.username || null; }
  if (!saved || saved.token !== token || saved.refreshedAt !== refreshed || saved.username !== username) await store().setJSON('instagram-env', { tag, token, refreshedAt: refreshed, username });
  return { token, igId, username, source: 'netlify' };
}
export async function igAccount() {
  if (!igSetUp()) return null;
  return (await envAccount().catch(() => null)) || (await store().get('instagram', { type: 'json' }).catch(() => null));
}
export async function igStatus() { const a = await igAccount().catch(() => null); return { setUp: igSetUp(), connected: !!(a && a.token && a.igId), username: a && a.username, via: a && a.source }; }

export async function graph(path, { method = 'GET', params = {}, token } = {}) {
  const acc = token ? null : await igAccount();
  const tok = token || (acc && acc.token);
  if (!tok) throw new Error('Instagram isn’t connected yet. Open Settings and tap Connect Instagram.');
  const q = new URLSearchParams({ ...params, access_token: tok });
  const res = await fetch(baseFor(tok) + '/' + path.replace(/^\//, '') + (method === 'GET' ? '?' + q : ''), method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: q });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new Error('Instagram: ' + ((d.error && (d.error.error_user_msg || d.error.message)) || 'error ' + res.status));
  return d;
}
const igId = async () => { const a = await igAccount(); if (!a || !a.igId) throw new Error('Instagram isn’t connected yet. Open Settings and tap Connect Instagram.'); return baseFor(a.token) === IGG ? 'me' : a.igId; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(container, maxMs = 7000) {
  const end = Date.now() + maxMs;
  for (;;) {
    const s = await graph(container, { params: { fields: 'status_code' } }).catch(() => ({}));
    if (s.status_code === 'FINISHED') return 'FINISHED';
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram couldn’t process the media (' + s.status_code + '). Check the images are JPEGs under 8 MB.');
    if (Date.now() > end) return s.status_code || 'IN_PROGRESS';
    await sleep(1200);
  }
}

// Fetch an image link the way Instagram will (no login, no redirects) and check it's a JPEG under 8 MB.
// Returns null when it's fine, or a plain-English problem.
export async function checkImageLink(u) {
  try {
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
    if (res.status >= 300 && res.status < 400) return 'the link redirects (Instagram needs the image directly)';
    if (res.status === 404) return 'the link has expired or was copied wrongly (not found)';
    if (!res.ok) return 'the link answered with error ' + res.status;
    const type = res.headers.get('content-type') || '', buf = Buffer.from(await res.arrayBuffer());
    if (!/^image\/jpe?g/i.test(type) || !(buf[0] === 0xff && buf[1] === 0xd8)) return 'the link isn’t a JPEG image (' + (type || 'unknown type') + ')';
    if (buf.length > 8e6) return 'the image is over 8 MB';
    return null;
  } catch (e) { return 'the link couldn’t be reached (' + (e && e.name === 'TimeoutError' ? 'timed out' : e.message) + ')'; }
}

// Post one photo or a carousel (2–10 images). Image URLs must be public JPEGs: Eltra's own /media links are.
export async function publishPost({ image_urls, caption }) {
  const id = await igId(), urls = (image_urls || []).filter(Boolean).slice(0, 10);
  if (!urls.length) throw new Error('No images to post');
  // Check every link first, so a broken one gets a clear reason instead of Instagram's "media could not be fetched"
  const probs = await Promise.all(urls.map(checkImageLink));
  const bad = probs.map((p, i) => (p ? 'Image ' + (i + 1) + ': ' + p : null)).filter(Boolean);
  if (bad.length) throw new Error('Not posted, Instagram wouldn’t be able to fetch the photo. ' + bad.join('; ') + '. Use the exact "saved for posting" link, or ask for the photo to be attached again.');
  let container;
  if (urls.length === 1) container = (await graph(id + '/media', { method: 'POST', params: { image_url: urls[0], caption: caption || '' } })).id;
  else {
    const kids = [];
    for (const u of urls) kids.push((await graph(id + '/media', { method: 'POST', params: { image_url: u, is_carousel_item: 'true' } })).id);
    container = (await graph(id + '/media', { method: 'POST', params: { media_type: 'CAROUSEL', children: kids.join(','), caption: caption || '' } })).id;
  }
  const st = await waitReady(container);
  if (st !== 'FINISHED') return { posted: false, container_id: container, note: 'Instagram is still processing it. Call instagram_finish_post with this container_id in a moment.' };
  const pub = await graph(id + '/media_publish', { method: 'POST', params: { creation_id: container } });
  const m = await graph(pub.id, { params: { fields: 'permalink' } }).catch(() => ({}));
  return { posted: true, media_id: pub.id, link: m.permalink };
}
export async function finishPost(container_id) {
  const id = await igId(), st = await waitReady(container_id);
  if (st !== 'FINISHED') return { posted: false, status: st, note: 'Still processing. Try again in a minute.' };
  const pub = await graph(id + '/media_publish', { method: 'POST', params: { creation_id: container_id } });
  const m = await graph(pub.id, { params: { fields: 'permalink' } }).catch(() => ({}));
  return { posted: true, media_id: pub.id, link: m.permalink };
}

// Recent posts with their numbers. Metric names have changed over time, so fall back to fewer if Meta rejects some.
export async function recentPosts(limit = 10) {
  const id = await igId();
  const acct = await graph(id, { params: { fields: 'username,followers_count,follows_count,media_count' } }).catch(() => ({}));
  const media = await graph(id + '/media', { params: { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count', limit: String(Math.min(25, limit)) } });
  const sets = ['reach,saved,shares,views,total_interactions', 'reach,saved,shares,total_interactions', 'reach,saved'];
  const posts = await Promise.all((media.data || []).map(async (m) => {
    let ins = {};
    for (const metric of sets) { try { const r = await graph(m.id + '/insights', { params: { metric } }); (r.data || []).forEach((x) => { ins[x.name] = x.values ? x.values[0].value : x.total_value && x.total_value.value; }); break; } catch {} }
    return { id: m.id, when: (m.timestamp || '').slice(0, 10), type: m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Post', caption: String(m.caption || '').slice(0, 120), likes: m.like_count, comments: m.comments_count, ...ins, link: m.permalink };
  }));
  return { account: acct, posts };
}
export async function listComments({ media_id, limit = 10 }) {
  const id = await igId();
  const media = media_id ? [{ id: media_id }] : ((await graph(id + '/media', { params: { fields: 'id,caption,timestamp', limit: String(limit) } })).data || []);
  const out = [];
  const lists = await Promise.all(media.map((m) => graph(m.id + '/comments', { params: { fields: 'id,text,username,timestamp,hidden,replies{id,text,username,timestamp}', limit: '50' } }).catch(() => ({ data: [] })).then((c) => ({ m, c }))));
  lists.forEach(({ m, c }) => (c.data || []).forEach((x) => out.push({ comment_id: x.id, post: m.caption ? String(m.caption).slice(0, 60) : m.id, from: x.username, text: x.text, when: x.timestamp, hidden: x.hidden || undefined, replies: (x.replies && x.replies.data || []).map((r) => r.username + ': ' + r.text) })));
  return { comments: out.sort((a, b) => (b.when || '').localeCompare(a.when || '')).slice(0, 40) };
}
export const replyComment = ({ comment_id, message }) => graph(comment_id + '/replies', { method: 'POST', params: { message } }).then((r) => ({ replied: true, id: r.id }));
export const hideComment = ({ comment_id, hide = true }) => graph(comment_id, { method: 'POST', params: { hide: hide ? 'true' : 'false' } }).then(() => ({ hidden: !!hide }));

// Research other business/creator accounts (Meta's Business Discovery). Gives followers and each post's likes and
// comments, but not views, so "how far it beat the account" is measured on engagement (likes + comments).
export async function researchAccounts(handles, perAccount = 12) {
  const id = await igId(), out = [], problems = [];
  if (id === 'me') return { rows: [], problems: ['Looking up other accounts isn’t available with this kind of Instagram token. Use instagram_research_in_browser (Claude in Chrome) instead.'] };
  await Promise.all((handles || []).slice(0, 12).map(async (raw) => {
    const h = String(raw || '').replace(/^@/, '').trim(); if (!h) return;
    try {
      const d = await graph(id, { params: { fields: 'business_discovery.username(' + h + '){username,followers_count,media.limit(' + Math.min(25, perAccount) + '){caption,like_count,comments_count,media_type,media_product_type,timestamp,permalink}}' } });
      const bd = d.business_discovery || {}, posts = (bd.media && bd.media.data) || [];
      const eng = posts.map((m) => (m.like_count || 0) + (m.comments_count || 0)).sort((a, b) => a - b);
      const med = eng.length ? (eng.length % 2 ? eng[(eng.length - 1) / 2] : (eng[eng.length / 2 - 1] + eng[eng.length / 2]) / 2) : 0;
      posts.forEach((m) => out.push({ account: '@' + (bd.username || h), followers: String(bd.followers_count || ''), median: String(Math.max(1, Math.round(med))), views: String((m.like_count || 0) + (m.comments_count || 0)), hook: String(m.caption || '').split('\n').find((l) => l.trim()) || '(no caption)', type: m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Post', when: (m.timestamp || '').slice(0, 10), link: m.permalink }));
    } catch (e) { problems.push('@' + h + ': ' + e.message.replace(/^Instagram: /, '') + (/(cannot be found|does not exist|invalid user)/i.test(e.message) ? ' (only business and creator accounts can be looked up; check the handle)' : '')); }
  }));
  return { rows: out, problems };
}
