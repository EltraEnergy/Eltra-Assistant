// One-off Claude calls for background jobs (planning, drafting, reviewing). Returns parsed JSON.
let model = null;
export async function claudeModel(key) {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  if (model) return model;
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
  const d = await r.json().catch(() => ({})), ids = (d.data || []).map((m) => m.id);
  return (model = ids.find((x) => /sonnet/.test(x)) || ids.find((x) => /opus/.test(x)) || ids[0]);
}
// Ask for a JSON object shaped by `schema` (JSON Schema), using a forced tool call so the answer always parses.
export async function claudeJSON({ system, prompt, schema, maxTokens = 2000, timeoutMs = 24000 }) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: await claudeModel(key), max_tokens: maxTokens, system, tools: [{ name: 'answer', description: 'Your answer', input_schema: schema }], tool_choice: { type: 'tool', name: 'answer' }, messages: [{ role: 'user', content: prompt }] })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Claude: ' + ((out.error && out.error.message) || res.status));
    const b = (out.content || []).find((c) => c.type === 'tool_use');
    if (!b) throw new Error('Claude gave no answer');
    return b.input;
  } finally { clearTimeout(t); }
}
