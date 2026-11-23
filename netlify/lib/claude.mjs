// One-off Claude calls for background jobs (planning, drafting, reviewing). Returns parsed JSON.
let model = null;
export async function claudeModel(key) {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  if (model) return model;
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
  const d = await r.json().catch(() => ({})), ids = (d.data || []).map((m) => m.id);
  return (model = ids.find((x) => /sonnet/.test(x)) || ids.find((x) => /opus/.test(x)) || ids[0]);
}
// Ask for a JSON object shaped by `schema` (JSON Schema) via an `answer` tool call. Newer models reject a forced
// tool_choice ("tool"/"any"), so we use "auto", tell the model to call the tool, and retry once if it replies with text.
// If it still replies with text, we accept a JSON object written in the reply. `timeoutMs` covers both attempts.
const USE_TOOL = 'Always give your answer by calling the `answer` tool exactly once, with every required field filled in. Do not reply with plain text.';
export async function claudeJSON({ system, prompt, schema, maxTokens = 2000, timeoutMs = 24000 }) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  const tools = [{ name: 'answer', description: 'Give your answer. Always call this tool to reply.', input_schema: schema }];
  const sys = (system ? system + '\n\n' : '') + USE_TOOL;
  try {
    const mdl = await claudeModel(key);
    let messages = [{ role: 'user', content: prompt }], text = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctl.signal, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: mdl, max_tokens: maxTokens, system: sys, tools, tool_choice: { type: 'auto' }, messages })
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('Claude: ' + ((out.error && out.error.message) || res.status));
      const b = (out.content || []).find((c) => c.type === 'tool_use' && c.name === 'answer');
      if (b) return b.input;
      text = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (attempt === 0) messages = [...messages, { role: 'assistant', content: text.trim() || '(no answer)' }, { role: 'user', content: 'Please give that answer by calling the `answer` tool now.' }];
    }
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a >= 0 && z > a) { try { const j = JSON.parse(text.slice(a, z + 1)); if (j && typeof j === 'object') return j; } catch {} }
    throw new Error('Claude gave no answer');
  } finally { clearTimeout(t); }
}
