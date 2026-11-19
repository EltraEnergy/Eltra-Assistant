// JavaScript ports of the Instagram skill pack's humanize.py, detect.py and caption.py (see instagram-data.mjs for credit/licence).
import { SLOP } from './instagram-data.mjs';

// Python regex → JavaScript: inline (?i)/(?m) flags become real flags, \UXXXXXXXX becomes \u{…}
function pyRe(src, extra = '') {
  let flags = new Set(extra.split('').filter(Boolean)), s = src;
  const m = s.match(/^\(\?([imsx]+)\)/); if (m) { m[1].split('').forEach((f) => { if (f !== 'x') flags.add(f); }); s = s.slice(m[0].length); }
  s = s.replace(/\\U([0-9A-Fa-f]{8})/g, (_, h) => '\\u{' + parseInt(h, 16).toString(16) + '}');
  flags.add('u');
  try { return new RegExp(s, [...flags].join('')); } catch { return null; }
}
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const URL_RE = /https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/g;
const SENT_RE = /[^.!?\n]+[.!?]*/g;
const LEX = [...SLOP.phrases, ...SLOP.words].sort((a, b) => b.find.length - a.find.length)
  .map((e) => ({ ...e, re: new RegExp('\\b' + esc(e.find).replace(/\\? /g, '\\s+') + '\\b', 'gi') }));
const STRUCT = SLOP.structures.map((s) => ({ ...s, re: pyRe(s.regex, 'gm') })).filter((s) => s.re);
const isFormat = (c) => /\p{Cf}/u.test(c);
const cp = (spec) => { if (spec.includes('-')) { const [a, b] = spec.split('-'); return [parseInt(a.slice(2), 16), parseInt(b.slice(2), 16)]; } return parseInt(spec.slice(2), 16); };
const matchCase = (src, repl) => !repl ? repl : src.length > 1 && src === src.toUpperCase() && /[A-Z]/.test(src) ? repl.toUpperCase() : /^[A-Z]/.test(src) ? repl[0].toUpperCase() + repl.slice(1) : repl;

export function humanize(input) {
  let text = String(input || ''); const original = text, urls = [];
  text = text.replace(URL_RE, (u) => '\u0000URL' + (urls.push(u) - 1) + '\u0000');
  const invisible = [], typographic = [], lexical = [];
  for (const e of SLOP.invisible) {
    const c = cp(e.cp), re = Array.isArray(c) ? new RegExp('[\\u{' + c[0].toString(16) + '}-\\u{' + c[1].toString(16) + '}]', 'gu') : new RegExp('\\u{' + c.toString(16) + '}', 'gu');
    const n = (text.match(re) || []).length; if (n) { invisible.push(e.name + ' ×' + n); text = text.replace(re, e.action === 'delete' ? '' : ' '); }
  }
  const stray = [...text].filter((ch) => ch !== '\u0000' && isFormat(ch)).length;
  if (stray) { invisible.push('other invisible characters ×' + stray); text = [...text].filter((ch) => ch === '\u0000' || !isFormat(ch)).join(''); }
  for (const e of SLOP.typographic) {
    const n = text.split(e.from).length - 1; if (!n) continue;
    typographic.push(e.from + ' ' + e.name + ' ×' + n);
    if (e.from === '—') text = text.replace(/\s*—\s*/g, ', ');
    else if (e.from === '–') text = text.replace(/\s*–\s*(?=\d)/g, '-').replace(/\s+–\s+/g, ', ').replace(/–/g, '-');
    else text = text.split(e.from).join(e.to);
  }
  text = text.replace(/,\s*([,.;:!?])/g, '$1').replace(/,\s*\n/g, '\n');
  for (const e of LEX) {
    const n = (text.match(e.re) || []).length; if (!n) continue;
    lexical.push('"' + e.find + '" → ' + (e.replace ? '"' + e.replace + '"' : '(removed)') + (n > 1 ? ' ×' + n : ''));
    text = text.replace(e.re, (m) => matchCase(m, e.replace));
  }
  // a removed opener can leave its punctuation behind ("Stop scrolling!" → "!"): drop it
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]*(?:[,.;:!?]+[ \t]*)+/gm, '').replace(/^[ \t](?=\S)/gm, '')
    .replace(/\s+([,.;:!?])/g, '$1').replace(/,\s*([,.;:!?])/g, '$1').replace(/\.\.\./g, '\u0001').replace(/\.\s*\.+/g, '.')
    .replace(/([!?])\s*\./g, '$1').replace(/([.?])!+(?=\s|$)/g, '$1').replace(/\u0001/g, '...').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  const starts = original.match(/(?:^|[.!?]\s+|\n)\s*([A-Za-z])/g) || [];
  if (starts.length && starts.filter((x) => /[A-Z]\s*$/.test(x) || /[A-Z]$/.test(x.trim())).length * 2 >= starts.length)
    text = text.replace(/(^|[.!?] |[.!?]\n|\n)(\s*)([a-z])/g, (m, a, b, c) => a + b + c.toUpperCase());
  text = text.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[+i]).trim();
  return { text, changes: { invisible, typographic, words: lexical }, flags: structureFlags(text) };
}
function structureFlags(text) {
  const flags = STRUCT.map((s) => ({ s, n: (text.match(s.re) || []).length })).filter((x) => x.n).map((x) => x.s.name + ': ' + x.s.fix);
  const lens = (text.match(SENT_RE) || []).map((s) => s.trim().split(/\s+/).length).filter((n) => n > 2);
  if (lens.length >= 4) { const mean = lens.reduce((a, b) => a + b, 0) / lens.length, sd = Math.sqrt(lens.reduce((a, n) => a + (n - mean) ** 2, 0) / lens.length); if (sd / mean < 0.35) flags.push('Uniform sentence length: break one sentence in half, let another run long.'); }
  return flags;
}

// the five-check panel from detect.py (local heuristics, not a real AI detector)
const clamp = (n) => Math.max(0, Math.min(100, n)), scale = (v, human, machine) => (human === machine ? 50 : clamp(((v - machine) / (human - machine)) * 100));
export function detect(text) {
  const words = text.match(/[A-Za-z']+/g) || [], sents = (text.match(SENT_RE) || []).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);
  const r = {};
  { const l = sents.map((s) => s.split(/\s+/).length); if (l.length < 4) r.BURSTINESS = [50, 'too short to judge']; else { const m = l.reduce((a, b) => a + b, 0) / l.length, cv = Math.sqrt(l.reduce((a, n) => a + (n - m) ** 2, 0) / l.length) / m; r.BURSTINESS = [scale(cv, 0.7, 0.22), 'variation ' + cv.toFixed(2) + ' (want 0.55+)']; } }
  { if (words.length < 25) r.SPECIFICITY = [50, 'too short to judge']; else { const hits = (text.match(/\b\d[\d,.]*%?\b|\$\d/g) || []).length + new Set(text.match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}\b/gm) || []).size, d = (hits * 100) / words.length; r.SPECIFICITY = [scale(d, 6, 0.5), hits + ' concrete markers, ' + d.toFixed(1) + ' per 100 words (want 4+)']; } }
  { let hits = 0; LEX.forEach((e) => { hits += (text.match(e.re) || []).length; }); const d = words.length ? (hits * 100) / words.length : 0; r['SLOP DENSITY'] = [words.length ? scale(d, 0, 4) : 50, hits + ' stock terms']; }
  { const inv = [...text].filter(isFormat).length, em = text.split('—').length - 1, curly = (text.match(/[‘’“”]/g) || []).length, el = text.split('…').length - 1, nb = (text.match(/[\u00A0\u202F\u2007]/g) || []).length; const per1k = ((inv * 4 + em * 2 + curly + el + nb) * 1000) / Math.max(text.length, 1); r.FINGERPRINT = [scale(per1k, 0, 12), inv + ' invisible, ' + em + ' em dash, ' + curly + ' curly quote']; }
  { if (words.length < 25) r.VOICE = [50, 'too short to judge']; else { const p = 100 / words.length, con = (text.match(/\b\w+'(?:s|t|re|ve|ll|d|m)\b/gi) || []).length * p, per = (text.match(/\b(i|me|my|mine|we|us|our|you|your)\b/gi) || []).length * p; let tells = 0; STRUCT.forEach((s) => { tells += (text.match(s.re) || []).length; }); r.VOICE = [clamp(scale(con, 3, 0) * 0.35 + scale(per, 8, 1) * 0.35 + clamp(100 - tells * 22) * 0.3), con.toFixed(1) + ' contractions, ' + per.toFixed(1) + ' personal words per 100, ' + tells + ' structural tell(s)']; } }
  const scores = Object.values(r).map((x) => x[0]), overall = (scores.reduce((a, b) => a + b, 0) / scores.length) * 0.6 + Math.min(...scores) * 0.4;
  const verdict = overall >= 70 && Math.min(...scores) >= 55 ? 'PASS' : overall >= 50 ? 'REVIEW' : 'FLAGGED';
  const weakest = Object.keys(r).reduce((a, b) => (r[a][0] <= r[b][0] ? a : b));
  return { human_score: Math.round(overall), verdict, checks: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v[0]) + ' – ' + v[1]])), weakest: verdict === 'PASS' ? undefined : weakest };
}

// what the feed shows before "… more", plus the basic caption rules
export function captionCheck(text) {
  const t = String(text || ''), first = t.slice(0, 125), tags = t.match(/#[\p{L}\p{N}_]+/gu) || [], notes = [];
  if (t.length > 2200) notes.push('Over the 2,200 character limit (' + t.length + ').');
  if (tags.length > 5) notes.push(tags.length + ' hashtags: Instagram now allows 5 at most.');
  if (/^\s*(#|\p{Extended_Pictographic})/u.test(t)) notes.push('Starts with a hashtag or emoji: line one should be words.');
  if (/^\s*(hey|hi|hello|good (morning|afternoon|evening))\b/i.test(t)) notes.push('Opens with a greeting: lead with the hook or the ask instead.');
  if (/https?:\/\/|www\./i.test(t)) notes.push('Links in captions aren’t clickable: say "link in bio" instead.');
  return { characters: t.length, shown_before_more: first + (t.length > 125 ? '…' : ''), hashtags: tags.length, notes };
}
