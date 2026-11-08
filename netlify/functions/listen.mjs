// Speech to text with ElevenLabs Scribe. POST the recorded audio (raw bytes, Content-Type audio/...) and get back {text}.
// Uses ELEVENLABS_API_KEY.
import { json, guard } from '../lib/util.mjs';

export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  if (req.method !== 'POST') return json(405, { error: 'Not allowed' });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return json(503, { error: 'ElevenLabs isn’t set up' });
  const type = (req.headers.get('content-type') || 'audio/webm').split(';')[0];
  if (!/^audio\//.test(type)) return json(400, { error: 'Send audio' });
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 800) return json(200, { text: '' });
  if (buf.byteLength > 5.5e6) return json(413, { error: 'That recording is too long. Keep it under a minute.' });
  const ext = type.includes('mp4') || type.includes('m4a') || type.includes('aac') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');
  form.append('language_code', 'en');
  form.append('tag_audio_events', 'false');
  form.append('file', new Blob([buf], { type }), 'speech.' + ext);
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return json(502, { error: 'ElevenLabs: ' + String((d.detail && (d.detail.message || d.detail.status || d.detail)) || res.status).slice(0, 200) });
  return json(200, { text: String(d.text || '').trim() });
};
