// JavaScript ports of the Instagram skill pack's hookscore.py, beats.py, swipe.py and caption.py
// (Jake Schincariol, MIT; see instagram-data.mjs). Same checks, thresholds and wording as the originals.
import { HOOKS } from './instagram-data.mjs';

const clamp = (n) => Math.max(0, Math.min(100, n));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const WORD_RE = /[A-Za-z0-9$%'’-]+/g;
const words = (t) => String(t).replace(/(?<=\d),(?=\d)/g, '').match(WORD_RE) || [];

// ---------------- hookscore.py ----------------
const NUMBER_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|k\b|x\b|hrs?\b|hours?\b|mins?\b|minutes?\b|days?\b|weeks?\b|months?\b|years?\b)?/gi;
const PROPER_RE = /(?<!^)\b[A-Z][a-z]{2,}\b/g;
const SPOKEN = new Set('zero two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion dozen half twice triple'.split(' '));
const MONEY = new Set('dollars dollar bucks grand percent cents millionaire billionaire revenue profit salary rent'.split(' '));
const STAKES = new Set("stop never wrong mistake mistakes lost lose losing cost costs broke broken failed failure fail nobody no not don't dont doesn't didn't can't won't quit quitting fired deleted delete killed kills kill replaced replaces cut beat free paid charged hired saved first banned illegal worst hate hated wasted waste scam lie lied lying truth secret hidden stole stolen before until instead but except unless problem risk danger warning regret wish should shouldn't still already only without versus vs actually".split(' '));
const WEAK = ['so', 'ok', 'okay', 'hey', 'hi', 'hello', 'guys', 'yo', 'alright', 'welcome', 'today', 'basically', 'honestly', 'look', 'listen', 'um', 'just', 'let', 'lets', "let's", 'i wanted', 'i want', 'one of', 'have you', 'did you', 'do you', 'are you', 'in this', 'in today', 'the thing', 'a lot', 'there is', 'there are', 'this is', 'it is', 'as a', 'when it', "if you've", 'you know'];
const IMPERATIVES = new Set("stop steal copy delete try watch read save use build make write send take start quit never always don't dont do put run check".split(' '));
const DEALBREAKERS = [
  [/^\s*(?:stop scrolling|don'?t scroll)/i, 'Opens with "stop scrolling". Asking for attention proves you have not earned it.'],
  [/\b(?:in (?:this|today'?s) (?:video|reel)|i'?m going to show you|i'?ll show you how)\b/i, 'Video preamble. Delete it and open on the payoff.'],
  [/^\s*(?:hey |hi |what'?s up |welcome )/i, 'Greeting. Nobody came to the feed to be greeted.'],
  [/(?:^|\s)#\w+/, 'Hashtag in the hook. Hashtags belong at the bottom of the caption, if anywhere.'],
  [/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u, 'Emoji in the hook. On-screen text at hook size has room for words or for an emoji, not both.']
];
const low = (w) => w.map((x) => x.toLowerCase().replace(/^['’]+|['’]+$/g, ''));
export function hookScore(text) {
  const w = words(text), lw = low(w), r = {};
  { const n = w.length, chars = text.trim().length; let s = n >= 5 && n <= 12 ? 100 : n < 5 ? clamp(100 - (5 - n) * 20) : clamp(100 - (n - 12) * 11); if (chars > 60) s -= 12; r.LENGTH = [clamp(s), n + ' words, ' + chars + ' chars, ~' + (n / 2.75).toFixed(1) + 's spoken (want 5-12 words)']; }
  { const nums = (text.match(NUMBER_RE) || []).map((x) => x.trim()).filter(Boolean), propers = [...new Set(text.match(PROPER_RE) || [])], spoken = lw.filter((x) => SPOKEN.has(x) || MONEY.has(x)), hits = nums.length + propers.length + spoken.length;
    r.SPECIFICITY = [hits === 0 ? 15 : clamp(45 + hits * 30), hits + ' concrete marker(s)' + (hits ? ': ' + [...nums.slice(0, 2), ...propers.sort().slice(0, 2), ...spoken.slice(0, 2)].join(', ') : ' - no number, no name, nothing checkable')]; }
  { const m = [...new Set(lw.filter((x) => STAKES.has(x)))].sort(); if (/\$\s?\d/.test(text)) m.push('a price'); r.STAKES = [m.length === 0 ? 20 : m.length === 1 ? 70 : 100, m.length + ' tension marker(s)' + (m.length ? ': ' + m.slice(0, 4).join(', ') : ' - nothing is at stake in this line')]; }
  { if (!w.length) r.FRONTLOAD = [0, 'empty']; else {
      const opener = lw.slice(0, 2).join(' '); let pen = 0, hit = null; for (const k of WEAK) { if (opener.startsWith(k) || lw[0] === k) { pen = 30; hit = k; break; } }
      let p = null; for (let i = 0; i < lw.length; i++) { const tok = lw[i]; NUMBER_RE.lastIndex = 0; if (STAKES.has(tok) || SPOKEN.has(tok) || MONEY.has(tok) || new RegExp('^(?:' + NUMBER_RE.source + ')', 'i').test(w[i]) && /\d/.test(w[i]) || (i && /^[A-Z][a-z]{2,}$/.test(w[i]))) { p = i; break; } }
      const base = p === null ? 30 : p <= 3 ? 100 : p <= 6 ? 70 : 40;
      const where = p === null ? 'no payload word anywhere in the line' : 'payload at word ' + (p + 1) + (p <= 3 ? '' : p <= 6 ? ', could move forward' : ', too late');
      r.FRONTLOAD = [clamp(base - pen), where + (hit ? '; weak opener "' + hit + '"' : '')]; } }
  { const l = text.toLowerCase(); r.ADDRESS = /\b(you|your|you're|youre|yourself)\b/.test(l) ? [100, 'speaks to the viewer'] : lw.length && IMPERATIVES.has(lw[0]) ? [90, 'imperative opener ("' + lw[0] + '")'] : /\b(i|my|me|we|our)\b/.test(l) ? [70, 'first person, no viewer named'] : [35, 'third person, nobody in the room']; }
  const flags = DEALBREAKERS.filter(([re]) => re.test(text)).map(([, m]) => m), sc = Object.values(r).map((x) => x[0]);
  const overall = clamp(mean(sc) * 0.6 + Math.min(...sc) * 0.4 - flags.length * 15);
  const verdict = overall >= 70 && Math.min(...sc) >= 55 && !flags.length ? 'STRONG' : overall >= 50 ? 'OK' : 'WEAK';
  const weakest = Object.keys(r).reduce((a, b) => (r[a][0] <= r[b][0] ? a : b));
  return { hook: text.trim(), score: Math.round(overall), verdict, checks: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v[0]) + ' – ' + v[1]])), weakest, dealbreakers: flags };
}
export function rankHooks(list) {
  const rows = list.map((h) => String(h || '').trim()).filter(Boolean).map(hookScore).sort((a, b) => b.score - a.score);
  return { ranked: rows, advice: rows.length && rows[0].score < 50 ? 'The best one is under 50, so none of these is the hook yet.' : 'Shoot the top one.', honesty: 'Scores how a hook reads, not how it will perform. It catches greetings, preambles, vague hooks and hooks too long to say in about 3 seconds; the retention graph is the real judge.' };
}

// ---------------- beats.py ----------------
const SENT_RE = /[^.!?]+[.!?]*/g, CONCRETE_RE = /\$\s?\d|\b\d[\d,.]*\b|(?<!^)\b[A-Z][a-z]{2,}\b/gm;
const STOP = new Set('the a an and or but if of to in on for with that this it is are was were be been you your i my me we our they them he she so just not no do did does have has had will can at as by from out up off one all'.split(' '));
const HOOK_WINDOW = 3, MAX_BEAT = 4, ABSTRACT_RUN = 3;
const tc = (s) => Math.floor(s / 60) + ':' + (s % 60).toFixed(1).padStart(4, '0');
export function beatSheet(raw, wpm = 165, target = null) {
  const wps = wpm / 60, beats = [];
  for (const line of String(raw).split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (words(line).length / wps <= MAX_BEAT * 1.5) { beats.push(line); continue; }
    let buf = '';
    for (const part of (line.match(SENT_RE) || []).map((p) => p.trim()).filter(Boolean)) { const cand = (buf + ' ' + part).trim(); if (buf && words(cand).length / wps > MAX_BEAT) { beats.push(buf); buf = part; } else buf = cand; }
    if (buf) beats.push(buf);
  }
  if (!beats.length) return { error: 'nothing to time' };
  let clock = 0; const rows = beats.map((text, i) => { const n = words(text).length, dur = n / wps, row = { n: i + 1, start: +clock.toFixed(2), dur: +dur.toFixed(2), words: n, text, concrete: (text.match(CONCRETE_RE) || []).length, label: '', flags: [] }; clock += dur; return row; });
  const total = clock;
  rows.forEach((r) => { if (r.n === 1 || r.start + r.dur <= HOOK_WINDOW) r.label = 'HOOK'; });
  rows[rows.length - 1].label = rows[rows.length - 1].label !== 'HOOK' ? 'CTA' : 'HOOK/CTA';
  rows.forEach((r) => { if (!r.label && r.start <= total / 2 && total / 2 < r.start + r.dur) r.label = 'MID'; });
  const notes = [];
  if (rows[0].dur > HOOK_WINDOW) { rows[0].flags.push('hook runs ' + rows[0].dur.toFixed(1) + 's, past the 3s mark'); notes.push('Beat 1 takes ' + rows[0].dur.toFixed(1) + 's to say. Cut it to ' + Math.floor(HOOK_WINDOW * wps) + ' words or fewer, or the hook lands after the decision has been made.'); }
  if (rows[0].concrete === 0) notes.push('Beat 1 has no number and no name in it. Hooks without something checkable are the ones that get scrolled.');
  rows.forEach((r) => { if (r.dur > MAX_BEAT) r.flags.push(r.dur.toFixed(1) + 's on one beat'); });
  const long = rows.filter((r) => r.dur > MAX_BEAT).map((r) => r.n);
  if (long.length) notes.push('Beat(s) ' + long.join(', ') + ' run past 4s. Either split the line or change what is on screen inside it. A static frame is where people leave.');
  let run = 0, start = null; rows.forEach((r) => { if (r.concrete === 0) { run++; if (start === null) start = r.n; if (run === ABSTRACT_RUN) notes.push('Beats ' + start + '-' + r.n + ' have nothing concrete in them. Put a number, a name or a price in one of them.'); } else { run = 0; start = null; } });
  const set = (t) => new Set(words(t).map((x) => x.toLowerCase()).filter((x) => !STOP.has(x))), first = set(rows[0].text), last = set(rows[rows.length - 1].text), loop = [...first].filter((x) => last.has(x)).sort();
  notes.push(loop.length ? 'Loops: the last beat repeats "' + loop.slice(0, 3).join(', ') + '" from the hook. Second watches are free reach.' : 'No loop. The last beat shares no word with the hook, so the video ends flat. Echoing one word from beat 1 is the cheapest replay you get.');
  if (target) { const d = total - target; notes.push(Math.abs(d) <= target * 0.1 ? 'Length is on target (' + total.toFixed(1) + 's against ' + target + 's).' : d > 0 ? d.toFixed(1) + 's over target. Cut about ' + Math.floor(d * wps) + ' words.' : (-d).toFixed(1) + 's under target. Either add ' + Math.floor(-d * wps) + ' words or shoot it short. Short is usually right.'); }
  return { wpm, target, total_seconds: +total.toFixed(1), total_words: rows.reduce((a, r) => a + r.words, 0), beats: rows.map((r) => ({ at: tc(r.start), seconds: r.dur, label: r.label || undefined, text: r.text, flags: r.flags.length ? r.flags : undefined })), notes, honesty: 'Timings are estimated from word count at ' + wpm + ' words a minute; close enough to plan the edit.' };
}

// ---------------- swipe.py ----------------
const FORMULAS = (() => { const by = {}; (HOOKS.hooks || []).forEach((h) => { by[h.id] = h; }); return (HOOKS.classify_order || Object.keys(by).map(Number)).filter((i) => by[i]).map((i) => { let re = null; try { re = new RegExp(by[i].match, 'i'); } catch {} return { id: by[i].id, name: by[i].name, re }; }).filter((f) => f.re); })();
export function swipeFile(rows) {
  const clean = (rows || []).map((r) => ({ account: String(r.account || ''), followers: +String(r.followers || '').replace(/\D/g, '') || null, median: +String(r.median || '').replace(/\D/g, '') || null, views: +String(r.views || '').replace(/\D/g, '') || 0, hook: String(r.hook || '').trim() })).filter((r) => r.views && r.hook);
  if (!clean.length) return { error: 'Give at least one reel with views and its hook (plus the account median views, or followers).' };
  const usedMedian = clean.some((r) => r.median);
  clean.forEach((r) => { const base = r.median || r.followers || 0; r.baseline = base; r.outlier = base ? +(r.views / base).toFixed(2) : null; const f = FORMULAS.find((x) => x.re.test(r.hook)); r.formula = f ? '#' + f.id + ' ' + f.name : 'unclassified'; r.words = (r.hook.match(WORD_RE) || []).length; const h = hookScore(r.hook); r.hook_score = h.score; r.hook_verdict = h.verdict; });
  const ranked = clean.sort((a, b) => (b.outlier || 0) - (a.outlier || 0)), third = Math.max(1, Math.floor(ranked.length / 3)), top = ranked.slice(0, third), bottom = ranked.slice(-third);
  const counts = {}; top.forEach((r) => { counts[r.formula] = (counts[r.formula] || 0) + 1; });
  const med = (a, k) => { const v = a.map((x) => x[k]).filter((x) => x != null); return v.length ? +median(v).toFixed(1) : null; };
  return { baseline: usedMedian ? 'account median' : 'follower count (less reliable: add each account\'s typical views if you can)', reels: ranked.map((r) => ({ multiple: r.outlier ? r.outlier + 'x' : '?', account: r.account, views: r.views, formula: r.formula, hook_score: r.hook_score, hook: r.hook })),
    top_formulas: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => n + ' ×' + c), top_vs_bottom: { hook_score: [med(top, 'hook_score'), med(bottom, 'hook_score')], hook_words: [med(top, 'words'), med(bottom, 'words')] },
    honesty: 'Ranked by how far each reel beat its own account, not raw views. A big account with big views may just have had a normal day.' };
}

// ---------------- caption.py ----------------
const LIMIT = 2200, CUT = 125, TAG_LIMIT = 5;
const HASH = /(?:^|\s)(#[A-Za-z0-9_]+)/g, MENTION = /(?:^|\s)(@[A-Za-z0-9_.]+)/g, LINK = /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|co|io|net|org|ai|app)\/\S*/gi, EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2190-\u21FF\uFE0F]/gu, CONC = /\$\s?\d|\b\d[\d,.]*\b|(?<!^)\b[A-Z][a-z]{2,}\b/gm;
const ASKS = [[/\bcomment (?:the word |")?[A-Z0-9]{2,}\b/i, 'comment a keyword'], [/\b(?:dm|message) me\b/i, 'DM me'], [/\bsave (?:this|it)\b/i, 'save this'], [/\bshare (?:this|it)\b/i, 'share this'], [/\bfollow (?:me|for)\b/i, 'follow'], [/\blink in (?:my )?bio\b/i, 'link in bio'], [/\b(?:swipe|tap) (?:through|left|right|for|to)\b/i, 'swipe or tap'], [/\btell me\b|\bwhat would you\b|\bwhich one\b/i, 'answer a question']];
const FILLER = new Set(['#viral', '#fyp', '#explore', '#explorepage', '#foryou', '#foryoupage', '#trending', '#instagood', '#love', '#follow', '#like4like', '#reels', '#reelsinstagram', '#viralreels', '#instadaily']);
const all = (re, t) => [...String(t).matchAll(re)].map((m) => m[1] || m[0]);
export function captionLint(text, keywords = []) {
  const s = String(text || '').trim(), chars = s.length, first = (s.split('\n')[0] || '').trim(), tags = all(HASH, s), links = all(LINK, s), emoji = s.match(EMOJI) || [];
  const win = chars <= CUT ? s : s.slice(0, CUT), asks = ASKS.filter(([re]) => re.test(s)).map(([, n]) => n), filler = tags.filter((t) => FILLER.has(t.toLowerCase())), checks = [];
  const add = (check, status, detail) => checks.push({ check, status, detail });
  add('LENGTH', chars > LIMIT ? 'FAIL' : 'PASS', chars + ' / ' + LIMIT + ' characters' + (chars > LIMIT ? ', ' + (chars - LIMIT) + ' over the limit' : ''));
  if (!first) add('FIRST LINE', 'FAIL', 'the caption opens on a blank line');
  else if (/^[#@]/.test(first)) add('FIRST LINE', 'FAIL', 'opens on a hashtag or a mention, which is the one position worth a sentence');
  else if (first.length > CUT) add('FIRST LINE', 'WARN', first.length + ' characters, so it gets cut at ' + CUT + ' mid-thought. Fine if the cut is a cliffhanger, bad if it is a subordinate clause');
  else add('FIRST LINE', 'PASS', first.length + ' characters, lands whole');
  const cw = win.match(CONC) || []; add('HOOK IS CONCRETE', cw.length ? 'PASS' : 'WARN', cw.length + ' number(s) or name(s) in the visible window' + (cw.length ? '' : ' - nothing checkable before the tap'));
  if (tags.length > TAG_LIMIT) add('HASHTAGS', 'FAIL', tags.length + ' tags, over Instagram\'s cap of 5. Tags past the fifth do not count and the block reads as old');
  else if (tags.length === TAG_LIMIT && filler.length) add('HASHTAGS', 'WARN', tags.length + ' tags, at the cap, and ' + filler.length + ' of them generic. Spend the five on topics');
  else if (filler.length) add('HASHTAGS', 'WARN', tags.length + ' tags, ' + filler.length + ' of them generic (' + filler.slice(0, 3).join(', ') + '). Those describe nothing');
  else add('HASHTAGS', 'PASS', tags.length + ' tag(s)' + (tags.length ? ': ' + tags.join(' ') : ''));
  add('TAG PLACEMENT', !tags.length ? 'PASS' : tags.some((t) => new RegExp('(?:^|\\s)' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(win)) ? 'WARN' : 'PASS', !tags.length ? 'no tags to place' : tags.some((t) => win.includes(t)) ? 'a hashtag is inside the visible window, spending feed space on a label' : 'tags are below the fold');
  add('LINKS', links.length ? 'WARN' : 'PASS', links.length ? links.length + ' link(s) in the caption, and captions are not clickable. Move it to the bio or the DM' : 'no dead links in the body');
  add('ONE ASK', asks.length === 1 ? 'PASS' : 'WARN', asks.length === 1 ? 'one call to action: ' + asks[0] : !asks.length ? 'no call to action. Decide what this post is for' : asks.length + ' asks (' + asks.join(', ') + '). Two asks is the same as none');
  const dens = (emoji.length * 100) / Math.max(chars, 1); add('EMOJI', dens > 4 ? 'WARN' : 'PASS', emoji.length + ' emoji, ' + dens.toFixed(1) + ' per 100 characters' + (dens > 4 ? ' - reads as decoration' : ''));
  const kw = (keywords || []).map((k) => String(k).trim()).filter(Boolean);
  if (kw.length) { const l = s.toLowerCase(), found = kw.filter((k) => l.includes(k.toLowerCase())), missing = kw.filter((k) => !l.includes(k.toLowerCase())), inw = found.filter((k) => win.toLowerCase().includes(k.toLowerCase())); add('SEARCH TERMS', !missing.length ? 'PASS' : found.length ? 'WARN' : 'FAIL', found.length + '/' + kw.length + ' present' + (found.length ? ', ' + inw.length + ' in the visible window' : '') + (missing.length ? '. Missing: ' + missing.join(', ') : '')); }
  const fails = checks.filter((c) => c.status === 'FAIL').length, warns = checks.filter((c) => c.status === 'WARN').length;
  return { verdict: fails ? 'FIX' : warns ? 'REVIEW' : 'READY', visible_before_more: win + (chars > CUT ? '… more' : ''), characters: chars, checks: checks.map((c) => c.status + ' ' + c.check + ': ' + c.detail) };
}
