// ElevenLabs voice.
// GET: the voices on your ElevenLabs account (with sample links), the models you can pick and this person's saved voice settings.
// POST {save: {engine, voice, model, stability, speed}}: saves the voice settings for the logged-in person, so every device sounds the same.
// POST {text, voice_id?, model?, stability?, speed?}: streams the spoken reply back as MP3 (settings default to the saved ones).
// Needs ELEVENLABS_API_KEY (server-side only, never sent to the browser). Optional: ELEVENLABS_VOICE_ID (default voice), ELEVENLABS_MODEL (default model).
// English is locked in. Expressive models (eleven_v3 / eleven_v4) aren't offered because they swing in pitch and volume.
import { json, guard, store, currentUser } from '../lib/util.mjs';

let voiceCache = null;
const API = 'https://api.elevenlabs.io/v1';
const MODELS = [
  { id: 'eleven_flash_v2_5', name: 'Flash (fastest)' },
  { id: 'eleven_turbo_v2_5', name: 'Turbo (fast, a bit richer)' },
  { id: 'eleven_multilingual_v2', name: 'Multilingual v2 (best quality, slower)' }
];
const MODEL_IDS = MODELS.map((m) => m.id);
const envModel = () => (MODEL_IDS.includes(process.env.ELEVENLABS_MODEL) ? process.env.ELEVENLABS_MODEL : 'eleven_turbo_v2_5');
const isVoiceId = (v) => /^[A-Za-z0-9]{10,40}$/.test(String(v || ''));
const num = (v, lo, hi, d) => { const n = +v; return Number.isFinite(n) && v !== '' && v !== null ? Math.max(lo, Math.min(hi, n)) : d; };

async function listVoices(key) {
  if (voiceCache && voiceCache.t > Date.now() - 3600e3) return voiceCache.v;
  const res = await fetch(API + '/voices', { headers: { 'xi-api-key': key } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('ElevenLabs: ' + ((d.detail && (d.detail.message || d.detail)) || res.status));
  const v = (d.voices || []).map((x) => ({ id: x.voice_id, name: x.name, accent: (x.labels && x.labels.accent) || '', gender: (x.labels && x.labels.gender) || '', age: (x.labels && x.labels.age) || '', use: (x.labels && (x.labels.use_case || x.labels['use case'])) || '', category: x.category || '', preview: /^https:\/\//.test(x.preview_url || '') ? x.preview_url : '' }));
  voiceCache = { t: Date.now(), v };
  return v;
}
function defaultVoice(voices) {
  if (process.env.ELEVENLABS_VOICE_ID) return process.env.ELEVENLABS_VOICE_ID;
  const au = voices.find((v) => /austral/i.test(v.accent));
  return (au || voices[0] || {}).id || null;
}

// Saved voice settings, one set per person (Will and Ethan each pick their own)
const settingsKey = () => 'voice-settings/' + currentUser();
function tidy(b = {}) {
  return {
    engine: b.engine === 'device' ? 'device' : 'eleven',
    voice: isVoiceId(b.voice) ? b.voice : '',
    voice_name: String(b.voice_name || '').slice(0, 80),
    model: MODEL_IDS.includes(b.model) ? b.model : envModel(),
    stability: num(b.stability, 0, 1, 0.8),
    speed: num(b.speed, 0.7, 1.2, 1)
  };
}
async function loadSettings() {
  const s = await store().get(settingsKey(), { type: 'json' }).catch(() => null);
  return s ? { ...tidy(s), saved: true } : { ...tidy({}), saved: false };
}

// Read-aloud text: no markdown, links, emoji or stray symbols, and not too long.
function speakable(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/^[ \t]*>[ \t]?/gm, '').replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, '').replace(/^[ \t]*\|(.*?)\|?[ \t]*$/gm, '$1').replace(/\s*\|\s*/g, ', ')
    .replace(/(\*\*|__|~~|\*|_)(\S[\s\S]*?\S|\S)\1/g, '$2')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[#*_`~<>{}\[\]^\\]/g, '')
    .replace(/([^\s.!?,:;])[ \t]*\n+/g, '$1.\n').replace(/\s+/g, ' ').replace(/\s+([.,!?])/g, '$1').replace(/([.!?])\s*\.(?!\.)/g, '$1')
    .trim().slice(0, 1200);
}

export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  const key = process.env.ELEVENLABS_API_KEY;
  if (req.method === 'GET') {
    const settings = await loadSettings();
    if (!key) return json(200, { configured: false, models: MODELS, settings });
    try { const voices = await listVoices(key); return json(200, { configured: true, voices, default: defaultVoice(voices), models: MODELS, settings }); }
    catch (e) { return json(200, { configured: true, voices: [], default: process.env.ELEVENLABS_VOICE_ID || null, models: MODELS, settings, error: e.message }); }
  }
  if (req.method !== 'POST') return json(405, { error: 'Not allowed' });
  let b = {}; try { b = await req.json(); } catch {}

  if (b.save) {
    const s = tidy(b.save);
    await store().setJSON(settingsKey(), s);
    return json(200, { ...s, saved: true });
  }

  if (!key) return json(503, { error: 'ElevenLabs isn’t set up (no API key)' });
  const text = speakable(b.text);
  if (!text) return json(400, { error: 'Nothing to say' });
  const saved = await loadSettings();
  let voice = isVoiceId(b.voice_id) ? b.voice_id : saved.voice;
  if (!voice) voice = defaultVoice(await listVoices(key).catch(() => []));
  if (!voice) return json(400, { error: 'No ElevenLabs voice found. Add one to your ElevenLabs account.' });
  const model = MODEL_IDS.includes(b.model) ? b.model : saved.model;
  const stability = num(b.stability, 0, 1, saved.stability);
  const speed = num(b.speed, 0.7, 1.2, saved.speed);
  const call = (m, plain) => fetch(API + '/text-to-speech/' + voice + '/stream?output_format=mp3_44100_128', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(plain
      ? { text, model_id: m, voice_settings: { stability, similarity_boost: 0.75 } }
      : { text, model_id: m, voice_settings: { stability, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed }, seed: 4242, apply_text_normalization: 'auto',
          ...(/v2_5/.test(m) ? { language_code: 'en' } : {}) })
  });
  let res = await call(model), note = '';
  // an option or the model isn't available on this account: try plainer settings, then Flash, and say so (never change silently)
  if (res.status === 400 || res.status === 422) { res = await call(model, true); if (res.ok) note = 'Some voice settings weren’t accepted by ElevenLabs, so I used the defaults.'; }
  if ((res.status === 400 || res.status === 422) && model !== 'eleven_flash_v2_5') { res = await call('eleven_flash_v2_5', true); if (res.ok) note = 'Your chosen ElevenLabs model wasn’t available, so I used Flash.'; }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let msg = t; try { const d = JSON.parse(t); msg = (d.detail && (d.detail.message || d.detail.status || d.detail)) || t; } catch {}
    return json(502, { error: 'ElevenLabs: ' + String(msg || res.status).slice(0, 200) });
  }
  // stream the audio straight through so playback starts while the rest is still arriving
  const headers = { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' };
  if (note) headers['X-Eltra-Voice-Note'] = encodeURIComponent(note);
  return new Response(res.body, { status: 200, headers });
};
