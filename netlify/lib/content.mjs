// The content autopilot: keeps the next week of Instagram posts planned and drafted in a schedule, posts approved ones
// at their time, and learns from real results. Every post needs a person's approval before it can go out.
import { store, melbToDate, melbToday, currentUser } from './util.mjs';
import { claudeJSON } from './claude.mjs';
import { SKILLS } from './instagram-data.mjs';
import { humanize, detect } from './instagram.mjs';
import { captionLint, rankHooks, beatSheet } from './instagram-tools.mjs';
import { igStatus, recentPosts, publishPost } from './instagram-api.mjs';
import { pylonReady, pylon, pylonProject, pylonDesign, DESIGN_FIELDS } from './tools.mjs';
import { addTodo } from './todos.mjs';
import { reviewDue, reviewLog } from './improve.mjs';
import crypto from 'node:crypto';

const KEY = 'content', DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULTS = { days: [1, 3, 5, 0], time: '18:30', reelsPerWeek: 1, aheadDays: 8, paused: false };
export const FORMATS = ['photo', 'carousel', 'reel', 'story'];
const uid = () => crypto.randomBytes(5).toString('hex');

export async function loadContent() {
  const d = (await store().get(KEY, { type: 'json' })) || {};
  return { settings: { ...DEFAULTS, ...(d.settings || {}) }, items: Array.isArray(d.items) ? d.items : [], learnings: d.learnings || null, removed: Array.isArray(d.removed) ? d.removed : [], edits: d.edits || [], log: d.log || [], lastRun: d.lastRun || null };
}
const saveContent = (d) => {
  const cut = Date.now() - 42 * 864e5;
  d.items = d.items.filter((x) => !['posted', 'skipped', 'manual'].includes(x.status) || Date.parse(x.at || x.createdAt) > cut);
  d.removed = (d.removed || []).filter((x) => Date.parse(x.removedAt) > cut).slice(-100);
  return store().setJSON(KEY, d);
};
// slots deleted from the schedule: the automatic fill leaves their date empty and doesn't reuse their topic
const removedDates = (d) => new Set((d.removed || []).map((x) => x.date));
const sameTopic = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const note = (d, msg) => { d.log = [{ at: new Date().toISOString(), msg }].concat(d.log || []).slice(0, 30); };

// the posting slots for the next `aheadDays` days that have nothing in them yet
function openSlots(d) {
  const out = [], taken = new Set(d.items.filter((x) => x.status !== 'skipped').map((x) => x.date).concat([...removedDates(d)]));
  for (let i = 1; i <= d.settings.aheadDays; i++) {
    const date = melbToday(i), dow = new Date(date + 'T12:00:00Z').getUTCDay();
    if (d.settings.days.includes(dow) && !taken.has(date)) out.push(date);
  }
  return out;
}
const slotTime = (date, time) => melbToDate(date + 'T' + time).toISOString();

async function context(d) {
  const ctx = {};
  const voice = await store().get('ig-voice', { type: 'json' }).catch(() => null); ctx.voice = voice && voice.text ? voice.text.slice(0, 3000) : 'Not filled in yet: plain, friendly, local Melbourne solar and battery installer. Australian English.';
  ctx.learnings = d.learnings && d.learnings.text ? d.learnings.text : 'None yet.';
  ctx.recentTopics = d.items.slice(-16).map((x) => x.date + ' ' + x.format + ': ' + x.topic).concat((d.removed || []).slice(-10).map((x) => 'Deleted, don\'t use again: ' + x.topic));
  ctx.jobs = [];
  if (pylonReady()) {
    try {
      const p = await pylon('/solar_projects?sort=created_at.desc&filter[is_archived]=false&filter[acceptance]=is_accepted');
      for (const raw of (p.data || []).slice(0, 6)) {
        const pr = pylonProject(raw), suburb = ((raw.attributes || {}).site_address || {}).city || '';
        let sys = '';
        if (pr.primary_design_id || pr.signed_design_id) {
          const ds = await pylon('/solar_designs/' + (pr.signed_design_id || pr.primary_design_id) + '?fields[solar_designs]=' + DESIGN_FIELDS).catch(() => null);
          if (ds && ds.data) { const x = pylonDesign(ds.data); sys = [x.solar_kw ? x.solar_kw + 'kW solar' : '', x.battery_kwh ? x.battery_kwh + 'kWh battery (' + x.batteries.join(', ') + ')' : '', x.inverters.join(', ')].filter(Boolean).join(', '); }
        }
        ctx.jobs.push((suburb ? suburb + ': ' : '') + (sys || 'system details not in Pylon') + ' (signed ' + (pr.created || '') + ')');
      }
    } catch {}
  }
  return ctx;
}
const SYSTEM = (ctx) => ['You write Instagram content for Eltra Energy, a Melbourne solar and battery installer (Sigenergy, Anker, AlphaESS, GoodWe). Australian English.',
  'Brand voice:\n' + ctx.voice, 'What has worked for this account so far:\n' + ctx.learnings,
  'Never invent numbers, results, customer names or addresses. Use real job details given to you, without names or street addresses. Where a number is needed but unknown, write {{number}} so a person fills it in.'].join('\n\n');

// 1. plan the empty slots for the coming week
export async function planSlots(d) {
  const slots = openSlots(d); if (!slots.length) return 0;
  const ctx = await context(d);
  const ans = await claudeJSON({
    system: SYSTEM(ctx) + '\n\nPlanning guide (ig-plan):\n' + SKILLS['ig-plan'].body.slice(0, 3500),
    prompt: 'Plan one post for each of these dates: ' + slots.map((x) => x + ' (' + DAYS[new Date(x + 'T12:00:00Z').getUTCDay()] + ')').join(', ') + '.\nFormats: "carousel" (most posts, can be posted automatically), "photo" (a single photo post, when a real job photo tells the story best; Ethan attaches the photo and Eltra posts it), "reel" (about ' + d.settings.reelsPerWeek + ' a week, Ethan films it), "story" (occasionally).\nRecent jobs to draw on:\n' + (ctx.jobs.join('\n') || 'none listed') + '\nRecent topics (don\'t repeat):\n' + (ctx.recentTopics.join('\n') || 'none') + '\nMix: real installs and results, explaining batteries/solar/rebates/bills, myths, behind the scenes. Each needs a specific angle.',
    schema: { type: 'object', properties: { posts: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, format: { type: 'string', enum: FORMATS }, topic: { type: 'string', description: 'short title' }, angle: { type: 'string', description: 'the specific point or story, one or two sentences' } }, required: ['date', 'format', 'topic', 'angle'] } } }, required: ['posts'] }
  });
  let n = 0;
  for (const p of ans.posts || []) {
    if (!slots.includes(p.date) || d.items.some((x) => x.date === p.date && x.status !== 'skipped')) continue;
    if ((d.removed || []).some((x) => x.date === p.date || sameTopic(x.topic, p.topic))) continue;
    d.items.push({ id: uid(), date: p.date, at: slotTime(p.date, d.settings.time), format: FORMATS.includes(p.format) ? p.format : 'carousel', topic: String(p.topic).slice(0, 120), angle: String(p.angle).slice(0, 400), status: 'planned', createdAt: new Date().toISOString() }); n++;
  }
  if (n) note(d, 'Planned ' + n + ' post' + (n > 1 ? 's' : ''));
  return n;
}

// 2. draft the next planned post (one per run, so each run stays short)
export async function draftOne(d, id) {
  const it = id ? d.items.find((x) => x.id === id) : d.items.filter((x) => x.status === 'planned').sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!it) return null;
  const ctx = await context(d), sys = SYSTEM(ctx);
  if (it.format === 'carousel') {
    const a = await claudeJSON({ system: sys + '\n\nCarousel guide:\n' + SKILLS['ig-carousel'].body.slice(0, 3500) + '\n\nCaption guide:\n' + SKILLS['ig-caption'].body.slice(0, 3000),
      prompt: 'Write the carousel for ' + it.date + '. Topic: ' + it.topic + '. Angle: ' + it.angle + (it.feedback ? '\nChanges asked for: ' + it.feedback : '') + '\nRecent jobs:\n' + (ctx.jobs.join('\n') || 'none') + '\n4-7 slides: a cover that earns the swipe, short slides (heading plus one or two lines), a final slide with the one ask. Then the caption (first line works before "… more", one ask, up to 5 specific hashtags at the end).',
      schema: { type: 'object', properties: { slides: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['heading'] } }, caption: { type: 'string' } }, required: ['slides', 'caption'] }, maxTokens: 2200 });
    const h = humanize(a.caption);
    it.slides = (a.slides || []).slice(0, 10).map((s) => ({ heading: humanize(s.heading).text, body: s.body ? humanize(s.body).text : '' }));
    it.caption = h.text; it.check = { verdict: detect(h.text).verdict, caption: captionLint(h.text).verdict, flags: h.flags.slice(0, 4) };
  } else if (it.format === 'photo') {
    const a = await claudeJSON({ system: sys + '\n\nCaption guide:\n' + SKILLS['ig-caption'].body.slice(0, 3500),
      prompt: 'Write a single-photo Instagram post for ' + it.date + '. Topic: ' + it.topic + '. Angle: ' + it.angle + (it.feedback ? '\nChanges asked for: ' + it.feedback : '') + '\nRecent jobs:\n' + (ctx.jobs.join('\n') || 'none') + '\nThis is one photo, not a carousel: no slides and no text on the image. Say what photo to use (one or two lines, e.g. a real install shot), then the caption (first line works before "… more", one ask, up to 5 specific hashtags at the end).',
      schema: { type: 'object', properties: { photo: { type: 'string', description: 'what photo to use' }, caption: { type: 'string' } }, required: ['photo', 'caption'] }, maxTokens: 1500 });
    const h = humanize(a.caption);
    it.photo = String(a.photo || '').slice(0, 400);
    it.caption = h.text; it.check = { verdict: detect(h.text).verdict, caption: captionLint(h.text).verdict, flags: h.flags.slice(0, 4) };
  } else if (it.format === 'reel') {
    const a = await claudeJSON({ system: sys + '\n\nReel guide:\n' + SKILLS['ig-reel'].body.slice(0, 4000),
      prompt: 'Write the Reel for ' + it.date + '. Topic: ' + it.topic + '. Angle: ' + it.angle + (it.feedback ? '\nChanges asked for: ' + it.feedback : '') + '\nGive 3 hook options (said in the first 3 seconds), the script one line per beat (20-40 seconds), what to film for each beat, and the caption.',
      schema: { type: 'object', properties: { hooks: { type: 'array', items: { type: 'string' } }, script: { type: 'string', description: 'one line per beat' }, shots: { type: 'string' }, caption: { type: 'string' } }, required: ['hooks', 'script', 'caption'] }, maxTokens: 2000 });
    const ranked = rankHooks(a.hooks || []), best = ranked.ranked[0];
    const script = (best ? best.hook + '\n' : '') + humanize(a.script).text, beats = beatSheet(script, 165, 30);
    it.hooks = ranked.ranked.map((r) => r.score + ' ' + r.verdict + ': ' + r.hook); it.script = script; it.shots = a.shots || ''; it.beats = beats.notes;
    it.caption = humanize(a.caption).text; it.check = { hook: best ? best.score + ' ' + best.verdict : '', caption: captionLint(it.caption).verdict };
  } else {
    const a = await claudeJSON({ system: sys + '\n\nStory guide:\n' + SKILLS['ig-story'].body.slice(0, 3500),
      prompt: 'Plan the story sequence for ' + it.date + '. Topic: ' + it.topic + '. Angle: ' + it.angle + '. 3-6 frames: what to show, the words on each, and which sticker (poll, question, quiz, link) where.',
      schema: { type: 'object', properties: { frames: { type: 'array', items: { type: 'string' } } }, required: ['frames'] }, maxTokens: 1500 });
    it.frames = (a.frames || []).map((f) => humanize(f).text); it.caption = '';
  }
  it.status = 'draft'; it.draftedAt = new Date().toISOString(); delete it.feedback;
  note(d, 'Drafted ' + it.format + ' for ' + it.date + ': ' + it.topic);
  return it;
}

// 3. post approved carousels when their time comes; remind about photos, Reels and stories on the day
export async function publishDue(d) {
  const now = Date.now(), done = [];
  for (const it of d.items) {
    if (it.status === 'scheduled' && Date.parse(it.at) <= now) {
      try { const r = await publishPost({ image_urls: it.image_urls, caption: it.caption }); if (r.posted) { it.status = 'posted'; it.link = r.link; it.postedAt = new Date().toISOString(); done.push(it.topic); } else { it.status = 'failed'; it.error = r.note; } }
      catch (e) { it.status = 'failed'; it.error = e.message; await addTodo({ section: 'Socials', text: 'Instagram post didn’t go out: ' + it.topic + ' (' + e.message.slice(0, 80) + ')', due: melbToday(0), owner: 'ethan', ref: 'auto' }).catch(() => {}); }
    }
    if (it.status === 'manual' && !it.reminded && it.date <= melbToday(0)) {
      it.reminded = true;
      await addTodo({ section: 'Socials', text: (it.format === 'reel' ? 'Film and post the Reel: ' : it.format === 'photo' ? 'Post the photo (Content schedule › Post to Instagram): ' : 'Post the story: ') + it.topic, due: it.date, owner: 'ethan', ref: 'auto' }).catch(() => {});
    }
  }
  if (done.length) note(d, 'Posted: ' + done.join(', '));
  return done.length;
}

// 4. once a week, learn from real results and from how people edited the drafts
export async function updateLearnings(d) {
  const ig = await igStatus().catch(() => ({}));
  if (!ig.connected) return false;
  const r = await recentPosts(15);
  const ans = await claudeJSON({ system: 'You analyse an Instagram account for a Melbourne solar and battery installer and keep a short, practical "what works for us" note.',
    prompt: 'Current note:\n' + (d.learnings && d.learnings.text || 'none') + '\n\nRecent posts and their numbers (reach, saves, shares, views, likes, comments):\n' + JSON.stringify(r.posts.map((p) => ({ when: p.when, type: p.type, caption: p.caption, reach: p.reach, saved: p.saved, shares: p.shares, views: p.views, likes: p.likes, comments: p.comments }))) + '\n\nHow people changed Eltra\'s drafts before approving (original → final):\n' + JSON.stringify((d.edits || []).slice(-8)) + '\n\nRewrite the note: at most 10 short bullets on what formats, topics, hooks, lengths and times work or don\'t for THIS account, judged mainly by saves and shares. Keep earlier points that still hold. Say when there is too little data.',
    schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] }, maxTokens: 1200 });
  d.learnings = { text: String(ans.note || '').slice(0, 2500), updatedAt: new Date().toISOString(), basedOn: r.posts.length };
  note(d, 'Updated “what works” from ' + r.posts.length + ' posts');
  return true;
}

// One short background cycle (every 15 minutes): post anything due, then do at most one slow job.
// Images for posts are only needed until a little after they're posted (links last up to 30 days). Weekly, delete older ones.
async function cleanMedia(d) {
  if (d.mediaCleanedAt && Date.now() - Date.parse(d.mediaCleanedAt) < 7 * 864e5) return;
  d.mediaCleanedAt = new Date().toISOString();
  const st = store(), cut = Date.now() - 35 * 864e5;
  let removed = 0;
  try {
    const { blobs } = await st.list({ prefix: 'media/' });
    for (const b of blobs || []) {
      const id = b.key.slice(6); let born = id.length > 16 ? parseInt(id.slice(0, id.length - 16), 16) : null;
      if (!born) { const m = await st.get(b.key, { type: 'json' }).catch(() => null); born = m && m.created ? Date.parse(m.created) : 0; }
      if (born < cut) { await st.delete(b.key); removed++; }
    }
  } catch {}
  if (removed) note(d, 'Cleared ' + removed + ' old post image' + (removed > 1 ? 's' : ''));
}

export async function runCycle({ force } = {}) {
  const d = await loadContent();
  await publishDue(d);
  await cleanMedia(d);
  try {
    const stale = !d.learnings || Date.now() - Date.parse(d.learnings.updatedAt || 0) > 7 * 864e5;
    if (await reviewDue()) { const n = await reviewLog(); if (n) note(d, 'Suggested ' + n + ' improvement' + (n > 1 ? 's' : '') + ' to Eltra'); }
    else if (d.settings.paused && !force) {}
    else if (stale && (await igStatus().catch(() => ({}))).connected && (await updateLearnings(d))) {}
    else if (openSlots(d).length) await planSlots(d);
    else await draftOne(d);
  } catch (e) { note(d, 'Problem: ' + e.message.slice(0, 160)); }
  d.lastRun = new Date().toISOString();
  await saveContent(d);
  return d;
}

// ---- changes from the dashboard and from Eltra ----
export async function updateItem(id, patch, by = currentUser()) {
  const d = await loadContent(), it = d.items.find((x) => x.id === id); if (!it) throw new Error('That post is no longer in the schedule');
  if (patch.caption !== undefined && it.caption && patch.caption !== it.caption) d.edits = (d.edits || []).concat([{ topic: it.topic, before: it.caption.slice(0, 300), after: String(patch.caption).slice(0, 300) }]).slice(-20);
  for (const k of ['caption', 'topic', 'angle', 'date', 'feedback']) if (patch[k] !== undefined) it[k] = String(patch[k]).slice(0, 2200);
  if (patch.slides) it.slides = patch.slides.slice(0, 10).map((s) => ({ heading: String(s.heading || '').slice(0, 120), body: String(s.body || '').slice(0, 300) }));
  if (patch.date || patch.time) it.at = slotTime(it.date, patch.time || d.settings.time);
  // a new format means a new draft: drop the old format's parts and redraft it in the new one
  if (patch.format !== undefined && patch.format !== it.format) {
    if (!FORMATS.includes(patch.format)) throw new Error('Format must be one of: ' + FORMATS.join(', '));
    if (it.status === 'posted') throw new Error('That post has already gone out');
    it.format = patch.format; it.status = 'planned';
    for (const k of ['slides', 'photo', 'hooks', 'script', 'shots', 'beats', 'frames', 'image_urls', 'check', 'approvedBy', 'approvedAt', 'reminded', 'error']) delete it[k];
    if (patch.action === 'approve') delete patch.action;
  }
  if (patch.action === 'approve') {
    if (it.format === 'carousel') { if (!patch.image_urls || !patch.image_urls.length) throw new Error('No slide images'); it.image_urls = patch.image_urls.slice(0, 10); it.status = 'scheduled'; }
    else it.status = 'manual';
    it.approvedBy = by; it.approvedAt = new Date().toISOString(); delete it.error;
  }
  if (patch.action === 'unapprove') { it.status = 'draft'; delete it.image_urls; }
  if (patch.action === 'skip') it.status = 'skipped';
  if (patch.action === 'redraft') { it.status = 'planned'; it.feedback = patch.feedback || ''; }
  if (patch.action === 'retry') it.status = 'scheduled';
  await saveContent(d); return it;
}
// Delete posts from the schedule for good: one by id, or every skipped one (skipped: true). Nothing is posted or
// changed on Instagram. The dates and topics are remembered so the automatic fill doesn't put them straight back.
export async function deleteItems({ id, skipped } = {}, by = currentUser()) {
  const d = await loadContent();
  const gone = d.items.filter((x) => (id && x.id === id) || (skipped && x.status === 'skipped'));
  if (id && !gone.length) throw new Error('That post is no longer in the schedule');
  if (!gone.length) return [];
  const ids = new Set(gone.map((x) => x.id)), now = new Date().toISOString();
  d.items = d.items.filter((x) => !ids.has(x.id));
  d.removed = (d.removed || []).concat(gone.map((x) => ({ date: x.date, topic: x.topic, removedAt: now, by })));
  note(d, gone.length === 1 ? 'Deleted ' + gone[0].format + ' for ' + gone[0].date + ': ' + gone[0].topic : 'Deleted ' + gone.length + ' skipped posts');
  await saveContent(d); return gone;
}
export async function saveSettings(patch) {
  const d = await loadContent(), s = d.settings;
  if (Array.isArray(patch.days)) s.days = [...new Set(patch.days.map(Number).filter((n) => n >= 0 && n <= 6))].slice(0, 7);
  if (/^\d{2}:\d{2}$/.test(patch.time || '')) s.time = patch.time;
  if (patch.reelsPerWeek !== undefined) s.reelsPerWeek = Math.max(0, Math.min(5, +patch.reelsPerWeek || 0));
  if (patch.paused !== undefined) s.paused = !!patch.paused;
  await saveContent(d); return s;
}
// a photo slot posted from the chat with instagram_post
export async function markPosted(id, link) {
  const d = await loadContent(), it = d.items.find((x) => x.id === id); if (!it) return null;
  it.status = 'posted'; it.link = link || it.link; it.postedAt = new Date().toISOString(); delete it.error;
  note(d, 'Posted: ' + it.topic);
  await saveContent(d); return it;
}
export { saveContent };
