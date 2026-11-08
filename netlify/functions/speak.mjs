// ElevenLabs voice. GET lists the voices on your ElevenLabs account; POST {text, voice_id} returns the spoken reply as MP3.
// Needs ELEVENLABS_API_KEY. Optional: ELEVENLABS_VOICE_ID (default voice), ELEVENLABS_MODEL (default eleven_flash_v2_5).
import { json, guard } from '../lib/util.mjs';

let voiceCache = null;
const API = 'https://api.elevenlabs.io/v1';

async function listVoices(key) {
  if (voiceCache && voiceCache.t > Date.now() - 3600e3) return voiceCache.v;
  const res = await fetch(API + '/voices', { headers: { 'xi-api-key': key } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('ElevenLabs: ' + ((d.detail && (d.detail.message || d.detail)) || res.status));
  const v = (d.voices || []).map((x) => ({ id: x.voice_id, name: x.name, accent: (x.labels && x.labels.accent) || '', gender: (x.labels && x.labels.gender) || '', age: (x.labels && x.labels.age) || '', use: (x.labels && (x.labels.use_case || x.labels['use case'])) || '', category: x.category || '' }));
  voiceCache = { t: Date.now(), v };
  return v;
}
function defaultVoice(voices) {
  if (process.env.ELEVENLABS_VOICE_ID) return process.env.ELEVENLABS_VOICE_ID;
  const au = voices.find((v) => /austral/i.test(v.accent));
  return (au || voices[0] || {}).id || null;
}

export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  const key = process.env.ELEVENLABS_API_KEY;
  if (req.method === 'GET') {
    if (!key) return json(200, { configured: false });
    try { const voices = await listVoices(key); return json(200, { configured: true, voices, default: defaultVoice(voices) }); }
    catch (e) { return json(200, { configured: true, voices: [], default: process.env.ELEVENLABS_VOICE_ID || null, error: e.message }); }
  }
  if (req.method !== 'POST') return json(405, { error: 'Not allowed' });
  if (!key) return json(503, { error: 'ElevenLabs isn’t set up' });
  let b = {}; try { b = await req.json(); } catch {}
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!text) return json(400, { error: 'Nothing to say' });
  let voice = /^[A-Za-z0-9]{10,40}$/.test(String(b.voice_id || '')) ? b.voice_id : null;
  if (!voice) voice = defaultVoice(await listVoices(key).catch(() => []));
  if (!voice) return json(400, { error: 'No ElevenLabs voice found. Add one to your ElevenLabs account.' });
  const speed = Math.max(0.7, Math.min(1.2, +b.speed || 1));
  const call = (model) => fetch(API + '/text-to-speech/' + voice + '?output_format=mp3_44100_128', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true, speed } })
  });
  let res = await call(process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5');
  if (res.status === 400 || res.status === 422) res = await call('eleven_multilingual_v2'); // model name not available on this account
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let msg = t; try { const d = JSON.parse(t); msg = (d.detail && (d.detail.message || d.detail.status || d.detail)) || t; } catch {}
    return json(502, { error: 'ElevenLabs: ' + String(msg).slice(0, 200) });
  }
  return new Response(await res.arrayBuffer(), { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
};
