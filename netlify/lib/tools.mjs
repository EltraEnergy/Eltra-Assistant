// The agent's tools. "action" tools change something (send, move, create) and only run after Will taps Approve.
import { g, GMAIL, CAL, DRIVE, DRIVE_UP } from './google.mjs';
import { tz, clip, melbToDate, melbToday } from './util.mjs';

// ---------------- helpers ----------------
const b64urlDecode = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hdr = (m, name) => { const h = ((m.payload && m.payload.headers) || []).find((x) => x.name.toLowerCase() === name.toLowerCase()); return h ? h.value : ''; };
const strip = (html) => String(html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
function bodyText(payload) {
  let plain = '', html = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data && !p.filename) plain += b64urlDecode(p.body.data).toString('utf8');
    else if (p.mimeType === 'text/html' && p.body && p.body.data && !p.filename) html += b64urlDecode(p.body.data).toString('utf8');
    (p.parts || []).forEach(walk);
  })(payload);
  return (plain || strip(html)).trim();
}
function attachments(payload) {
  const out = [];
  (function walk(p) { if (!p) return; if (p.filename && p.body && p.body.attachmentId) out.push({ filename: p.filename, mime_type: p.mimeType, size_kb: Math.round((p.body.size || 0) / 1024), attachment_id: p.body.attachmentId }); (p.parts || []).forEach(walk); })(payload);
  return out;
}
const mimeWord = (s) => /[^\x20-\x7e]/.test(s) ? '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=' : s;
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const melbDate = (d) => new Date(d).toLocaleString('en-AU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,parents,modifiedTime,webViewLink,size';
const ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives';
const fileOut = (f) => ({ id: f.id, name: f.name, type: f.mimeType === FOLDER ? 'folder' : (f.mimeType || '').split('/').pop(), modified: f.modifiedTime ? melbDate(f.modifiedTime) : null, link: f.webViewLink, parent_id: (f.parents || [])[0] || null });

// GoHighLevel (LeadConnector API v2). GHL_TOKEN = a Private Integration token for the sub-account, GHL_LOCATION_ID = its location id.
export const ghlReady = () => !!(process.env.GHL_TOKEN && process.env.GHL_LOCATION_ID);
export async function ghl(path, opts = {}) {
  const res = await fetch('https://services.leadconnectorhq.com' + path, {
    ...opts, headers: { Authorization: 'Bearer ' + process.env.GHL_TOKEN, Version: '2021-07-28', Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
  });
  const text = await res.text(); let d; try { d = JSON.parse(text); } catch { d = text; }
  if (!res.ok) throw new Error('GoHighLevel error ' + res.status + ': ' + String((d && (d.message || d.error)) || text).slice(0, 200));
  return d;
}
let pipeCache = null;
export async function ghlPipelines() {
  if (pipeCache && pipeCache.t > Date.now() - 600000) return pipeCache.p;
  const d = await ghl('/opportunities/pipelines?locationId=' + encodeURIComponent(process.env.GHL_LOCATION_ID));
  pipeCache = { t: Date.now(), p: (d.pipelines || []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })) })) };
  return pipeCache.p;
}
async function stageName(id) { const ps = await ghlPipelines().catch(() => []); for (const p of ps) for (const s of p.stages) if (s.id === id) return p.name + ' › ' + s.name; return id; }
export async function ghlOpps(params) {
  const sp = new URLSearchParams({ location_id: process.env.GHL_LOCATION_ID, limit: String(params.limit || 20) });
  if (params.query) sp.set('q', params.query);
  if (params.status) sp.set('status', params.status);
  if (params.pipeline_stage_id) sp.set('pipeline_stage_id', params.pipeline_stage_id);
  if (params.pipeline_id) sp.set('pipeline_id', params.pipeline_id);
  const d = await ghl('/opportunities/search?' + sp);
  const names = {}; (await ghlPipelines().catch(() => [])).forEach((p) => p.stages.forEach((s) => { names[s.id] = s.name; }));
  return (d.opportunities || []).map((o) => ({
    id: o.id, name: o.name, stage: names[o.pipelineStageId] || o.pipelineStageId, status: o.status, value: o.monetaryValue || null,
    contact_id: o.contactId || (o.contact && o.contact.id), contact: o.contact ? { name: o.contact.name, phone: o.contact.phone, email: o.contact.email } : null,
    source: o.source || null, created: o.createdAt ? melbDate(o.createdAt) : null, updated: o.updatedAt ? melbDate(o.updatedAt) : null
  }));
}

// ServiceM8. SERVICEM8_API_KEY = an API key from ServiceM8 (Settings > API Keys).
export const sm8Ready = () => !!process.env.SERVICEM8_API_KEY;
export async function sm8(path, opts = {}) {
  const res = await fetch('https://api.servicem8.com/api_1.0/' + path, {
    ...opts, headers: { 'X-API-Key': process.env.SERVICEM8_API_KEY, Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
  });
  const text = await res.text(); let d; try { d = JSON.parse(text); } catch { d = text; }
  if (!res.ok) throw new Error('ServiceM8 error ' + res.status + ': ' + String(text).slice(0, 200));
  return { data: d, uuid: res.headers.get('x-record-uuid') };
}
const sm8Job = (j) => ({ uuid: j.uuid, job_no: j.generated_job_id, status: j.status, address: j.job_address, description: clip(j.job_description, 300), date: j.date, quote_total: j.total_invoice_amount || null });

// GoHighLevel booking invites carry the customer under "Invitee:" (name, email, phone, address)
export function invitee(desc) {
  const t = strip(String(desc || '').replace(/<br\s*\/?>|<\/div>|<\/p>/gi, '\n'));
  const m = t.match(/Invitee:\s*\n([\s\S]*?)(?:\n\s*\n|Need to make a change|$)/i);
  if (!m) return null;
  const lines = m[1].split('\n').map((x) => x.trim()).filter(Boolean), out = { name: lines[0] || '' };
  for (const l of lines.slice(1)) { if (/@/.test(l)) out.email = l; else if (/^[+\d][\d\s()-]{7,}$/.test(l)) out.phone = l; else if (!out.address) out.address = l; }
  return out;
}
export function eventOut(e) {
  const allDay = !!(e.start && e.start.date && !e.start.dateTime);
  const who = invitee(e.description);
  return {
    id: e.id, title: e.summary || '(no title)', all_day: allDay,
    start_iso: allDay ? e.start.date : e.start && e.start.dateTime, end_iso: e.end && (e.end.dateTime || e.end.date),
    start: e.start && (e.start.dateTime ? melbDate(e.start.dateTime) : e.start.date + ' (all day)'),
    location: e.location || (who && who.address) || null, customer: who,
    sales_visit: /appointment details|assessment|site visit|consult/i.test((e.summary || '') + ' ' + (e.description || '')),
    description: who ? null : clip(strip(e.description || ''), 300) || null, link: e.htmlLink
  };
}
// Recent conversations, one row per thread, with who sent the last message
export async function gmailThreads(query, max) {
  const list = await g(GMAIL + '/threads?maxResults=' + Math.min(20, max || 10) + '&q=' + encodeURIComponent(query));
  const ts = await Promise.all((list.threads || []).map((t) => g(GMAIL + '/threads/' + t.id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date').catch(() => null)));
  return ts.filter(Boolean).map((t) => {
    const msgs = t.messages || [], m = msgs[msgs.length - 1] || {}, first = msgs[0] || m, labels = m.labelIds || [];
    return { thread_id: t.id, message_id: m.id, from: hdr(m, 'From'), subject: hdr(first, 'Subject') || hdr(m, 'Subject'), date_iso: m.internalDate ? new Date(+m.internalDate).toISOString() : null, date: m.internalDate ? melbDate(+m.internalDate) : hdr(m, 'Date'),
      snippet: m.snippet ? strip(m.snippet) : '', messages: msgs.length, unread: msgs.some((x) => (x.labelIds || []).includes('UNREAD')), last_from_will: labels.includes('SENT'), link: 'https://mail.google.com/mail/u/0/#all/' + t.id };
  });
}

// ---------------- tools ----------------
const T = [];
const tool = (def) => T.push(def);

tool({
  name: 'gmail_search', group: 'google',
  description: 'Search Will’s Gmail with Gmail search syntax (e.g. "is:unread in:inbox newer_than:2d", "from:smith quote", "has:attachment bill"). Returns one row per conversation: thread_id, latest message_id, sender, subject, date, snippet, and whether Will sent the last message.',
  input_schema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer', description: 'Up to 20, default 10' } }, required: ['query'] },
  run: ({ query, max }) => gmailThreads(query, max)
});
tool({
  name: 'gmail_read', group: 'google',
  description: 'Read email in full. Pass thread_id to read the whole conversation (last 6 messages), or message_id for one message. Returns sender, recipients, date, body text and attachment names, with message_ids to reply to.',
  input_schema: { type: 'object', properties: { thread_id: { type: 'string' }, message_id: { type: 'string' } } },
  async run({ thread_id, message_id }) {
    const one = (m) => ({ message_id: m.id, thread_id: m.threadId, from: hdr(m, 'From'), to: hdr(m, 'To'), cc: hdr(m, 'Cc'), date: m.internalDate ? melbDate(+m.internalDate) : hdr(m, 'Date'), subject: hdr(m, 'Subject'), body: clip(bodyText(m.payload), thread_id ? 3000 : 7000), attachments: attachments(m.payload).map((a) => ({ filename: a.filename, size_kb: a.size_kb })) });
    if (thread_id) { const t = await g(GMAIL + '/threads/' + encodeURIComponent(thread_id) + '?format=full'); return (t.messages || []).slice(-6).map(one); }
    if (!message_id) throw new Error('Pass thread_id or message_id');
    return one(await g(GMAIL + '/messages/' + encodeURIComponent(message_id) + '?format=full'));
  }
});
const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Will's default Gmail signature (Settings > Signature). Needs no extra permission: gmail.modify can read it.
async function gmailSignature() {
  try {
    const r = await g(GMAIL + '/settings/sendAs');
    const list = r.sendAs || [];
    const a = list.find((x) => x.isDefault) || list.find((x) => x.isPrimary) || list[0];
    const html = a && a.signature ? a.signature : '';
    const text = html ? html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|tr)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim() : '';
    return { html, text };
  } catch (e) { return { html: '', text: '' }; }
}
tool({
  name: 'gmail_create_draft', group: 'google',
  description: 'Create an email DRAFT in Will’s Gmail (nothing is sent). To reply in an existing conversation, pass reply_to_message_id and the draft goes into that thread. Write in Will’s voice: friendly, plain Australian English, short. End the body with a short sign-off such as "Cheers," or "Thanks," and nothing after it: Will’s Gmail signature (name, details and logo) is added automatically underneath.',
  input_schema: { type: 'object', properties: { to: { type: 'string', description: 'Comma-separated addresses' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text' }, reply_to_message_id: { type: 'string' } }, required: ['to', 'body'] },
  async run({ to, cc, subject, body, reply_to_message_id }) {
    let threadId, extra = '';
    if (reply_to_message_id) {
      const o = await g(GMAIL + '/messages/' + encodeURIComponent(reply_to_message_id) + '?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=References');
      threadId = o.threadId;
      const mid = hdr(o, 'Message-ID'), refs = hdr(o, 'References');
      if (mid) extra = 'In-Reply-To: ' + mid + '\r\nReferences: ' + (refs ? refs + ' ' : '') + mid + '\r\n';
      if (!subject) { const s = hdr(o, 'Subject'); subject = /^re:/i.test(s) ? s : 'Re: ' + s; }
    }
    // Gmail doesn't add the signature to drafts made through the API, so add Will's default signature here
    // (HTML, with a plain-text copy) and send the email as text + HTML like Gmail does.
    const sig = await gmailSignature();
    const textBody = body.replace(/\s+$/, '') + (sig.text ? '\n\n' + sig.text : '\nWill\nEltra Energy');
    const htmlBody = '<div dir="ltr">' + escHtml(body.replace(/\s+$/, '')).replace(/\r?\n/g, '<br>') + (sig.html ? '<br><br><div class="gmail_signature" data-smartmail="gmail_signature">' + sig.html + '</div>' : '<br>Will<br>Eltra Energy') + '</div>';
    const bnd = 'eltra_' + Date.now().toString(36);
    const part = (type, txt) => '--' + bnd + '\r\nContent-Type: ' + type + '; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(txt).toString('base64').replace(/.{76}/g, '$&\r\n') + '\r\n';
    const raw = 'To: ' + to + '\r\n' + (cc ? 'Cc: ' + cc + '\r\n' : '') + 'Subject: ' + mimeWord(subject || '') + '\r\n' + extra +
      'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="' + bnd + '"\r\n\r\n' + part('text/plain', textBody) + part('text/html', htmlBody) + '--' + bnd + '--';
    const d = await g(GMAIL + '/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: b64url(raw), ...(threadId ? { threadId } : {}) } }) });
    return { draft_id: d.id, saved: 'Draft saved in Gmail. It has NOT been sent.', to, subject };
  }
});
tool({
  name: 'gmail_send_draft', group: 'google', action: true,
  description: 'Send a Gmail draft. Only when Will has clearly asked to send it. Will approves it on screen first.',
  input_schema: { type: 'object', properties: { draft_id: { type: 'string' } }, required: ['draft_id'] },
  async describe({ draft_id }) {
    const d = await g(GMAIL + '/drafts/' + encodeURIComponent(draft_id) + '?format=full');
    const m = d.message || {};
    return { title: 'Send this email', lines: ['To: ' + hdr(m, 'To'), hdr(m, 'Cc') ? 'Cc: ' + hdr(m, 'Cc') : null, 'Subject: ' + hdr(m, 'Subject')].filter(Boolean), preview: clip(bodyText(m.payload), 1500) };
  },
  async run({ draft_id }) { const d = await g(GMAIL + '/drafts/send', { method: 'POST', body: JSON.stringify({ id: draft_id }) }); return { sent: true, message_id: d.id }; }
});
tool({
  name: 'gmail_archive', group: 'google', action: true,
  description: 'Archive emails (take them out of the inbox; they stay in All Mail).',
  input_schema: { type: 'object', properties: { message_ids: { type: 'array', items: { type: 'string' } } }, required: ['message_ids'] },
  async describe({ message_ids }) {
    const ms = await Promise.all(message_ids.slice(0, 20).map((id) => g(GMAIL + '/messages/' + id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject').catch(() => null)));
    return { title: 'Archive ' + message_ids.length + ' email' + (message_ids.length === 1 ? '' : 's'), lines: ms.filter(Boolean).map((m) => hdr(m, 'From').replace(/<.*>/, '').trim() + ': ' + hdr(m, 'Subject')) };
  },
  async run({ message_ids }) { await g(GMAIL + '/messages/batchModify', { method: 'POST', body: JSON.stringify({ ids: message_ids, removeLabelIds: ['INBOX'] }) }); return { archived: message_ids.length }; }
});
tool({
  name: 'gmail_save_attachments', group: 'google', action: true,
  description: 'Save an email’s attachments into a Google Drive folder (e.g. a customer’s bill into their quote folder). Optionally only some files by name.',
  input_schema: { type: 'object', properties: { message_id: { type: 'string' }, folder_id: { type: 'string' }, filenames: { type: 'array', items: { type: 'string' } } }, required: ['message_id', 'folder_id'] },
  async describe({ message_id, folder_id, filenames }) {
    const [m, f] = await Promise.all([g(GMAIL + '/messages/' + encodeURIComponent(message_id) + '?format=full'), g(DRIVE + '/files/' + encodeURIComponent(folder_id) + '?supportsAllDrives=true&fields=name')]);
    const atts = attachments(m.payload).filter((a) => !filenames || !filenames.length || filenames.includes(a.filename));
    return { title: 'Save attachments to Drive', lines: ['From: ' + hdr(m, 'Subject'), 'Into folder: ' + f.name].concat(atts.map((a) => '• ' + a.filename)) };
  },
  async run({ message_id, folder_id, filenames }) {
    const m = await g(GMAIL + '/messages/' + encodeURIComponent(message_id) + '?format=full');
    const atts = attachments(m.payload).filter((a) => !filenames || !filenames.length || filenames.includes(a.filename));
    const saved = [];
    for (const a of atts) {
      const data = await g(GMAIL + '/messages/' + m.id + '/attachments/' + a.attachment_id);
      const boundary = 'eltra' + Date.now();
      const body = Buffer.concat([
        Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: a.filename, parents: [folder_id] }) + '\r\n--' + boundary + '\r\nContent-Type: ' + (a.mime_type || 'application/octet-stream') + '\r\n\r\n'),
        b64urlDecode(data.data), Buffer.from('\r\n--' + boundary + '--')
      ]);
      const f = await g(DRIVE_UP + '/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink', { method: 'POST', raw: true, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
      saved.push({ name: f.name, link: f.webViewLink });
    }
    return { saved };
  }
});

tool({
  name: 'calendar_events', group: 'google',
  description: 'List events on Will’s Google Calendar. Defaults to today and the next 6 days. Dates are YYYY-MM-DD in Melbourne time.',
  input_schema: { type: 'object', properties: { from_date: { type: 'string' }, days: { type: 'integer', description: '1 to 31, default 7' }, query: { type: 'string', description: 'Optional text to search for' } } },
  async run({ from_date, days, query }) {
    const day0 = from_date || melbToday(), n = Math.min(31, days || 7);
    const start = melbToDate(day0), end = melbToDate(new Date(melbToDate(day0).getTime() + (n + 0.5) * 864e5).toLocaleDateString('en-CA', { timeZone: tz }));
    const sp = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50', timeZone: tz });
    if (query) sp.set('q', query);
    const d = await g(CAL + '/events?' + sp);
    return (d.items || []).filter((e) => e.status !== 'cancelled').map(eventOut);
  }
});
tool({
  name: 'calendar_create_event', group: 'google', action: true,
  description: 'Add an event to Will’s Google Calendar. Times are Melbourne local time as YYYY-MM-DDTHH:MM.',
  input_schema: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite (they get an invitation)' } }, required: ['title', 'start', 'end'] },
  async describe(i) { return { title: 'Add to calendar', lines: [i.title, i.start.replace('T', ' ') + ' to ' + i.end.replace('T', ' '), i.location, i.attendees && i.attendees.length ? 'Invites: ' + i.attendees.join(', ') : null].filter(Boolean) }; },
  async run(i) {
    const e = await g(CAL + '/events?sendUpdates=' + (i.attendees && i.attendees.length ? 'all' : 'none'), { method: 'POST', body: JSON.stringify({ summary: i.title, location: i.location, description: i.description, start: { dateTime: i.start.length === 16 ? i.start + ':00' : i.start, timeZone: tz }, end: { dateTime: i.end.length === 16 ? i.end + ':00' : i.end, timeZone: tz }, attendees: (i.attendees || []).map((email) => ({ email })) }) });
    return { created: true, link: e.htmlLink };
  }
});

tool({
  name: 'drive_search', group: 'google',
  description: 'Find files or folders in Google Drive by name (and optionally by text inside the file). Customer quote folders live in ELTRA ENERGY > Customer Quotes (folder id 1yRS0IDyBgfe_TVnE1V7wKnT8oapZPKyw), named "YYYY-MM-DD Name – Address".',
  input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Part of the file or folder name' }, text: { type: 'string', description: 'Text inside the file' }, folders_only: { type: 'boolean' }, in_folder_id: { type: 'string' }, max: { type: 'integer' } } },
  async run({ name, text, folders_only, in_folder_id, max }) {
    const parts = ['trashed = false'];
    if (name) parts.push("name contains '" + q(name) + "'");
    if (text) parts.push("fullText contains '" + q(text) + "'");
    if (folders_only) parts.push("mimeType = '" + FOLDER + "'");
    if (in_folder_id) parts.push("'" + q(in_folder_id) + "' in parents");
    const d = await g(DRIVE + '/files?' + ALL + '&pageSize=' + Math.min(50, max || 20) + '&orderBy=modifiedTime desc&fields=files(' + FILE_FIELDS + ')&q=' + encodeURIComponent(parts.join(' and ')));
    return (d.files || []).map(fileOut);
  }
});
tool({
  name: 'drive_list_folder', group: 'google',
  description: 'List what is inside a Google Drive folder.',
  input_schema: { type: 'object', properties: { folder_id: { type: 'string' } }, required: ['folder_id'] },
  async run({ folder_id }) {
    const d = await g(DRIVE + '/files?' + ALL + '&pageSize=100&orderBy=folder,name&fields=files(' + FILE_FIELDS + ')&q=' + encodeURIComponent("'" + q(folder_id) + "' in parents and trashed = false"));
    return (d.files || []).map(fileOut);
  }
});
async function names(ids) { return Promise.all(ids.map((id) => g(DRIVE + '/files/' + encodeURIComponent(id) + '?supportsAllDrives=true&fields=name').then((f) => f.name).catch(() => id))); }
tool({
  name: 'drive_move', group: 'google', action: true,
  description: 'Move files or folders into another Google Drive folder.',
  input_schema: { type: 'object', properties: { file_ids: { type: 'array', items: { type: 'string' } }, folder_id: { type: 'string' } }, required: ['file_ids', 'folder_id'] },
  async describe({ file_ids, folder_id }) { const [fs, [to]] = await Promise.all([names(file_ids.slice(0, 30)), names([folder_id])]); return { title: 'Move ' + file_ids.length + ' item' + (file_ids.length === 1 ? '' : 's') + ' in Drive', lines: ['Into: ' + to].concat(fs.map((n) => '• ' + n)) }; },
  async run({ file_ids, folder_id }) {
    const done = [];
    for (const id of file_ids) {
      const f = await g(DRIVE + '/files/' + encodeURIComponent(id) + '?supportsAllDrives=true&fields=name,parents');
      await g(DRIVE + '/files/' + encodeURIComponent(id) + '?supportsAllDrives=true&addParents=' + encodeURIComponent(folder_id) + '&removeParents=' + encodeURIComponent((f.parents || []).join(',')), { method: 'PATCH', body: '{}' });
      done.push(f.name);
    }
    return { moved: done };
  }
});
tool({
  name: 'drive_create_folder', group: 'google', action: true,
  description: 'Create a folder in Google Drive.',
  input_schema: { type: 'object', properties: { name: { type: 'string' }, parent_id: { type: 'string' } }, required: ['name', 'parent_id'] },
  async describe({ name, parent_id }) { const [p] = await names([parent_id]); return { title: 'Create a Drive folder', lines: [name, 'Inside: ' + p] }; },
  async run({ name, parent_id }) { const f = await g(DRIVE + '/files?supportsAllDrives=true&fields=id,name,webViewLink', { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent_id] }) }); return { folder_id: f.id, link: f.webViewLink }; }
});
tool({
  name: 'drive_rename', group: 'google', action: true,
  description: 'Rename a file or folder in Google Drive.',
  input_schema: { type: 'object', properties: { file_id: { type: 'string' }, name: { type: 'string' } }, required: ['file_id', 'name'] },
  async describe({ file_id, name }) { const [old] = await names([file_id]); return { title: 'Rename in Drive', lines: [old, '→ ' + name] }; },
  async run({ file_id, name }) { await g(DRIVE + '/files/' + encodeURIComponent(file_id) + '?supportsAllDrives=true', { method: 'PATCH', body: JSON.stringify({ name }) }); return { renamed: name }; }
});

tool({
  name: 'ghl_pipelines', group: 'ghl',
  description: 'List the GoHighLevel pipelines and their stages (with ids).',
  input_schema: { type: 'object', properties: {} },
  run: () => ghlPipelines()
});
tool({
  name: 'ghl_search_opportunities', group: 'ghl',
  description: 'Find leads/opportunities in GoHighLevel. Filter by a name/phone/email search, a pipeline stage id (from ghl_pipelines) or status (open, won, lost, abandoned).',
  input_schema: { type: 'object', properties: { query: { type: 'string' }, pipeline_stage_id: { type: 'string' }, status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned', 'all'] }, limit: { type: 'integer' } } },
  run: (i) => ghlOpps({ ...i, status: i.status === 'all' ? null : i.status, limit: Math.min(50, i.limit || 20) })
});
tool({
  name: 'ghl_search_contacts', group: 'ghl',
  description: 'Find contacts in GoHighLevel by name, phone or email.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  async run({ query }) {
    const d = await ghl('/contacts/search', { method: 'POST', body: JSON.stringify({ locationId: process.env.GHL_LOCATION_ID, query, pageLimit: 10 }) });
    return (d.contacts || []).map((c) => ({ id: c.id, name: [c.firstName || c.firstNameLowerCase, c.lastName || c.lastNameLowerCase].filter(Boolean).join(' ') || c.contactName, phone: c.phone, email: c.email, address: [c.address1, c.city, c.postalCode].filter(Boolean).join(', '), tags: c.tags, added: c.dateAdded ? melbDate(c.dateAdded) : null }));
  }
});
tool({
  name: 'ghl_move_opportunity', group: 'ghl', action: true,
  description: 'Move a GoHighLevel opportunity to another pipeline stage (and optionally mark it won/lost). Use stage ids from ghl_pipelines.',
  input_schema: { type: 'object', properties: { opportunity_id: { type: 'string' }, pipeline_stage_id: { type: 'string' }, status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] } }, required: ['opportunity_id'] },
  async describe({ opportunity_id, pipeline_stage_id, status }) {
    const o = await ghl('/opportunities/' + encodeURIComponent(opportunity_id)).catch(() => null);
    const opp = o && (o.opportunity || o);
    return { title: 'Update a lead in GoHighLevel', lines: [(opp && opp.name) || opportunity_id, pipeline_stage_id ? 'Move to: ' + await stageName(pipeline_stage_id) : null, status ? 'Mark as: ' + status : null].filter(Boolean) };
  },
  async run({ opportunity_id, pipeline_stage_id, status }) {
    const body = {}; if (pipeline_stage_id) body.pipelineStageId = pipeline_stage_id; if (status) body.status = status;
    await ghl('/opportunities/' + encodeURIComponent(opportunity_id), { method: 'PUT', body: JSON.stringify(body) });
    return { updated: true };
  }
});
tool({
  name: 'ghl_add_note', group: 'ghl', action: true,
  description: 'Add a note to a GoHighLevel contact.',
  input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, note: { type: 'string' } }, required: ['contact_id', 'note'] },
  async describe({ contact_id, note }) { const c = await ghl('/contacts/' + encodeURIComponent(contact_id)).catch(() => null); const ct = c && (c.contact || c); return { title: 'Add a note in GoHighLevel', lines: ['Contact: ' + ((ct && (ct.contactName || [ct.firstName, ct.lastName].filter(Boolean).join(' '))) || contact_id)], preview: note }; },
  async run({ contact_id, note }) { await ghl('/contacts/' + encodeURIComponent(contact_id) + '/notes', { method: 'POST', body: JSON.stringify({ body: note }) }); return { added: true }; }
});
tool({
  name: 'ghl_add_task', group: 'ghl', action: true,
  description: 'Create a follow-up task on a GoHighLevel contact. due is Melbourne local time YYYY-MM-DDTHH:MM.',
  input_schema: { type: 'object', properties: { contact_id: { type: 'string' }, title: { type: 'string' }, due: { type: 'string' }, details: { type: 'string' } }, required: ['contact_id', 'title', 'due'] },
  async describe({ contact_id, title, due }) { const c = await ghl('/contacts/' + encodeURIComponent(contact_id)).catch(() => null); const ct = c && (c.contact || c); return { title: 'Add a follow-up task in GoHighLevel', lines: [title, 'Due: ' + due.replace('T', ' '), 'Contact: ' + ((ct && (ct.contactName || [ct.firstName, ct.lastName].filter(Boolean).join(' '))) || contact_id)] }; },
  async run({ contact_id, title, due, details }) {
    const iso = melbToDate(due).toISOString();
    await ghl('/contacts/' + encodeURIComponent(contact_id) + '/tasks', { method: 'POST', body: JSON.stringify({ title, body: details || '', dueDate: iso, completed: false }) });
    return { added: true };
  }
});

tool({
  name: 'sm8_jobs', group: 'sm8',
  description: 'List ServiceM8 jobs, newest first. status: Quote, Work Order, Completed or Unsuccessful. Optional search matches the address, description or job number.',
  input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['Quote', 'Work Order', 'Completed', 'Unsuccessful'] }, search: { type: 'string' }, limit: { type: 'integer' } } },
  async run({ status, search, limit }) {
    const filter = ['active eq 1']; if (status) filter.push("status eq '" + status + "'");
    const { data } = await sm8('job.json?%24filter=' + encodeURIComponent(filter.join(' and ')));
    let jobs = (Array.isArray(data) ? data : []).sort((a, b) => String(b.date || b.edit_date).localeCompare(String(a.date || a.edit_date)));
    if (search) { const s = search.toLowerCase(); jobs = jobs.filter((j) => [j.job_address, j.job_description, j.generated_job_id].join(' ').toLowerCase().includes(s)); }
    return { total: jobs.length, jobs: jobs.slice(0, Math.min(40, limit || 15)).map(sm8Job) };
  }
});
export async function sm8Schedule(days) {
  const from = melbToday(), to = melbToday(days || 7);
  const { data } = await sm8('jobactivity.json?%24filter=' + encodeURIComponent("start_date gt '" + from + " 00:00:00' and start_date lt '" + to + " 23:59:59' and activity_was_scheduled eq 1 and active eq 1"));
  const acts = (Array.isArray(data) ? data : []).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))).slice(0, 25);
  const ids = [...new Set(acts.map((a) => a.job_uuid))];
  const [jobs, staff] = await Promise.all([
    Promise.all(ids.map((id) => sm8('job/' + id + '.json').then((r) => r.data).catch(() => null))),
    sm8('staff.json').then((r) => r.data).catch(() => [])
  ]);
  const jm = {}; jobs.filter(Boolean).forEach((j) => { jm[j.uuid] = j; });
  const sn = {}; (Array.isArray(staff) ? staff : []).forEach((s) => { sn[s.uuid] = [s.first, s.last].filter(Boolean).join(' '); });
  return acts.map((a) => ({ start: a.start_date, end: a.end_date, staff: sn[a.staff_uuid] || null, job: jm[a.job_uuid] ? sm8Job(jm[a.job_uuid]) : { uuid: a.job_uuid } }));
}
tool({
  name: 'sm8_schedule', group: 'sm8',
  description: 'Scheduled ServiceM8 job bookings from today for the next few days (installs and site visits), with the staff member.',
  input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Default 7' } } },
  run: ({ days }) => sm8Schedule(Math.min(31, days || 7))
});
tool({
  name: 'sm8_add_job_note', group: 'sm8', action: true,
  description: 'Add a note to a ServiceM8 job.',
  input_schema: { type: 'object', properties: { job_uuid: { type: 'string' }, note: { type: 'string' } }, required: ['job_uuid', 'note'] },
  async describe({ job_uuid, note }) { const j = await sm8('job/' + job_uuid + '.json').then((r) => r.data).catch(() => null); return { title: 'Add a note in ServiceM8', lines: ['Job: ' + (j ? '#' + j.generated_job_id + ' ' + (j.job_address || '') : job_uuid)], preview: note }; },
  async run({ job_uuid, note }) { await sm8('note.json', { method: 'POST', body: JSON.stringify({ related_object: 'job', related_object_uuid: job_uuid, note }) }); return { added: true }; }
});
tool({
  name: 'sm8_create_job', group: 'sm8', action: true,
  description: 'Create a new ServiceM8 job (usually status Quote for a new lead, or Work Order once sold).',
  input_schema: { type: 'object', properties: { client_name: { type: 'string' }, address: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['Quote', 'Work Order'] } }, required: ['client_name', 'address', 'description'] },
  async describe(i) { return { title: 'Create a ServiceM8 job', lines: [i.client_name, i.address, 'Status: ' + (i.status || 'Quote')], preview: i.description }; },
  async run(i) {
    const found = await sm8('company.json?%24filter=' + encodeURIComponent("name eq '" + String(i.client_name).replace(/'/g, "''") + "'")).then((r) => r.data).catch(() => []);
    let company = Array.isArray(found) && found[0] ? found[0].uuid : null;
    if (!company) company = (await sm8('company.json', { method: 'POST', body: JSON.stringify({ name: i.client_name, address: i.address }) })).uuid;
    const r = await sm8('job.json', { method: 'POST', body: JSON.stringify({ status: i.status || 'Quote', job_address: i.address, job_description: i.description, company_uuid: company }) });
    return { created: true, job_uuid: r.uuid };
  }
});

// Tools available right now (only the systems that are set up)
export function activeTools() {
  return T.filter((t) => t.group === 'google' ? !!process.env.GOOGLE_CLIENT_ID : t.group === 'ghl' ? ghlReady() : t.group === 'sm8' ? sm8Ready() : true);
}
export const toolByName = (n) => T.find((t) => t.name === n);
