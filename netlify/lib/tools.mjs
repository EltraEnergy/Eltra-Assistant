// The agent's tools. "action" tools change something (send, move, create) and only run after Will taps Approve.
import { g, GMAIL, CAL, DRIVE, DRIVE_UP, accessToken } from './google.mjs';
import { loadTodos, addTodo, updateTodo } from './todos.mjs';
import { currentUser } from './util.mjs';
import { loadPrefs, portalFor } from './prefs.mjs';
import { loadContent, updateItem } from './content.mjs';
import { addProposal, decide, loadImprove } from './improve.mjs';
import { loadJobs, saveJobs, setInstall, parseDay } from './jobs.mjs';
import { SKILLS, HOOKS, VOICE_TEMPLATE, RUBRIC } from './instagram-data.mjs';
import { humanize, detect } from './instagram.mjs';
import { rankHooks, beatSheet, swipeFile, captionLint } from './instagram-tools.mjs';
import { igSetUp, publishPost, finishPost, recentPosts, listComments, replyComment, hideComment, researchAccounts } from './instagram-api.mjs';
import { store as blobStore } from './util.mjs';
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


// Pylon (solar design and proposals). PYLON_API_TOKEN = a token from Pylon Settings > API (Read + Create).
export const pylonReady = () => !!process.env.PYLON_API_TOKEN;
const PYLON = 'https://api.getpylon.com/v1';
export async function pylon(path, opts = {}) {
  const res = await fetch(PYLON + path, {
    ...opts, headers: { Authorization: 'Bearer ' + process.env.PYLON_API_TOKEN, Accept: 'application/vnd.api+json', ...(opts.body ? { 'Content-Type': 'application/vnd.api+json' } : {}) }
  });
  const text = await res.text(); let d; try { d = text ? JSON.parse(text) : {}; } catch { d = text; }
  if (!res.ok) {
    const why = d && (d.title || d.code) ? (d.title || d.code) + (d.errors ? ' ' + JSON.stringify(d.errors).slice(0, 200) : '') : String(text).slice(0, 200);
    throw new Error('Pylon error ' + res.status + ': ' + why);
  }
  return d;
}
const cents = (c) => c == null ? null : '$' + (c / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pylonAddr = (a) => a ? [a.line1, a.line2, a.city, a.state, a.zip].filter(Boolean).join(', ') : null;
export const pylonProject = (p) => {
  const a = p.attributes || {}, r = p.relationships || {}, acc = a.acceptance || {};
  return {
    id: p.id, reference: a.reference_number, customer: a.customer_details || null, address: pylonAddr(a.site_address),
    sold: !!acc.is_accepted, signed: !!acc.latest_esignature, marked_sold: !!acc.manually_sold,
    status: !a.is_committed ? 'Awaiting activation in Pylon (location not confirmed yet)' : acc.is_accepted ? (acc.latest_esignature ? 'Signed' : 'Sold') : 'Proposal stage',
    phases: a.site_details && a.site_details.power_phases, created: a.created_at ? melbDate(a.created_at) : null, updated: a.updated_at ? melbDate(a.updated_at) : null,
    primary_design_id: r.primary_design && r.primary_design.data ? r.primary_design.data.id : null,
    signed_design_id: r.latest_signed_design && r.latest_signed_design.data ? r.latest_signed_design.data.id : null
  };
};
export const DESIGN_FIELDS = 'title,label,is_primary,summary,pricing,proposal_quote,locale,module_types,inverter_types,storage_types,created_at,updated_at';
export const pylonDesign = (d) => {
  const a = d.attributes || {}, s = a.summary || {}, q = a.proposal_quote || {}, au = (a.locale && a.locale.au) || {};
  const parts = (list) => (list || []).map((x) => (x.quantity && x.quantity !== 1 ? x.quantity + ' × ' : '') + x.description);
  return {
    id: d.id, title: a.label || a.title, primary: !!a.is_primary, solar_kw: s.dc_output_kw, battery_kwh: s.storage_kwh, description: s.description,
    total: q.total_price_formatted || cents(a.pricing && a.pricing.total), amount_payable: q.amount_payable_formatted || null, deposit: q.deposit_amount_formatted || null,
    stcs: au.stc_quantity != null ? au.stc_quantity + (au.battery_stc_quantity ? ' solar + ' + au.battery_stc_quantity + ' battery' : '') : null,
    panels: parts(a.module_types), inverters: parts(a.inverter_types), batteries: parts(a.storage_types),
    proposal_link: s.web_proposal_url || null, pdf_link: s.pdf_proposal_url || null, updated: a.updated_at ? melbDate(a.updated_at) : null
  };
};

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
    // a sales appointment, never an install or other job booking
    sales_visit: /appointment details|assessment|site visit|consult|quote|sales/i.test((e.summary || '') + ' ' + (e.description || '')) && !/install|commission|inspection|service call|maintenance/i.test(e.summary || ''),
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
  name: 'gmail_create_draft', group: 'google', action: true,
  // shown in full for approval first; it only goes into Gmail once approved
  async describe(i) { return { title: 'Put this email in Gmail as a draft' + (i.reply_to_message_id ? ' (reply)' : ''), lines: ['To: ' + (i.to || '(same thread)') + (i.cc ? '  ·  Cc: ' + i.cc : ''), 'Subject: ' + (i.subject || '(same as the thread)')], preview: i.body || '' }; },
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
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const PRICING_ID = '12VOySK_Rx0-v7oiRR6nM2W8pWESgVcCMzroURWZOKE8';
// Accepts a sheet id, a docs.google.com link or part of the file name.
async function findSheet(which) {
  const w = String(which || '').trim();
  if (!w || /^(pricing|price list|system pricing|prices)$/i.test(w)) return PRICING_ID;
  const m = w.match(/\/d\/([A-Za-z0-9_-]{20,})/); if (m) return m[1];
  if (/^[A-Za-z0-9_-]{30,}$/.test(w)) return w;
  const d = await g(DRIVE + '/files?' + ALL + '&pageSize=5&orderBy=modifiedTime desc&fields=files(id,name)&q=' + encodeURIComponent("trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet' and name contains '" + q(w) + "'"));
  if (!d.files || !d.files.length) throw new Error('No Google Sheet found matching "' + w + '"');
  return d.files[0].id;
}
tool({
  name: 'sheets_read', group: 'google',
  description: 'Read a Google Sheet. Eltra’s price list is the "System Pricing" sheet (pass sheet "pricing"). Its tabs: "Solar Only Single Phase", "Solar Only Three Phase", "Battery Only Single Phase", "Battery Only Three Phase" (cost build-up: inverter, panels or modules, labour, accessories, totals ex and incl GST, before rebates), "Rebates" (STC price) and "App feed" (what the quote app uses: final prices incl GST before rebates, settings, extras). Without a range it lists the tabs and returns the first part of the first tab; with a range (e.g. "\'Battery Only Single Phase\'!A1:J20" or just a tab name) it returns those cells. Read-only.',
  input_schema: { type: 'object', properties: { sheet: { type: 'string', description: 'Sheet name, link or id. "pricing" for the System Pricing sheet.' }, range: { type: 'string', description: 'A1 range or tab name' } }, required: ['sheet'] },
  async run({ sheet, range }) {
    const id = await findSheet(sheet);
    const meta = await g(SHEETS + '/' + id + '?fields=properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))');
    const tabs = (meta.sheets || []).map((x) => x.properties.title);
    let r = range || ("'" + (tabs[0] || 'Sheet1').replace(/'/g, "''") + "'!A1:Z60");
    if (range && !/!/.test(range) && tabs.indexOf(range.replace(/^'|'$/g, '')) >= 0) r = "'" + range.replace(/^'|'$/g, '').replace(/'/g, "''") + "'!A1:Z200";
    const v = await g(SHEETS + '/' + id + '/values/' + encodeURIComponent(r) + '?valueRenderOption=FORMATTED_VALUE');
    let rows = (v.values || []).filter((row) => row.some((c) => String(c).trim() !== ''));
    const total = rows.length; rows = rows.slice(0, 200);
    return { title: meta.properties && meta.properties.title, tabs, range: v.range, rows, note: total > 200 ? 'Showing the first 200 of ' + total + ' rows; ask for a smaller range.' : undefined };
  }
});
tool({
  name: 'drive_read_file', group: 'google',
  description: 'Read the text of a Google Doc, a Google Sheet (first tab, as CSV) or a plain text/CSV file in Drive, by file id. Use drive_search first to get the id. For a sheet with several tabs, sheets_read is better.',
  input_schema: { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'] },
  async run({ file_id }) {
    const f = await g(DRIVE + '/files/' + encodeURIComponent(file_id) + '?supportsAllDrives=true&fields=id,name,mimeType');
    const ex = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }[f.mimeType];
    let text;
    if (ex) text = await g(DRIVE + '/files/' + encodeURIComponent(file_id) + '/export?mimeType=' + encodeURIComponent(ex));
    else if (/^text\/|json|csv/.test(f.mimeType)) text = await g(DRIVE + '/files/' + encodeURIComponent(file_id) + '?alt=media&supportsAllDrives=true');
    else return { name: f.name, mime_type: f.mimeType, note: 'This file type can’t be read as text here (e.g. PDF or image).' };
    text = typeof text === 'string' ? text : JSON.stringify(text);
    return { name: f.name, text: clip(text, 20000) };
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


tool({
  name: 'pylon_find_projects', group: 'pylon',
  description: 'Find Pylon projects (solar/battery designs and proposals), newest first. search matches the customer name, address, email, phone or reference number. sold_only shows accepted/signed ones. Each project shows whether it is sold or signed and its primary design id.',
  input_schema: { type: 'object', properties: { search: { type: 'string' }, sold_only: { type: 'boolean' }, days: { type: 'integer', description: 'only projects created in the last N days' } } },
  async run({ search, sold_only, days }) {
    let url = '/solar_projects?sort=created_at.desc&filter[is_archived]=false' + (sold_only ? '&filter[acceptance]=is_accepted' : '') + (days ? '&filter[created_at.within]=P' + Math.max(1, Math.min(365, days)) + 'D' : '');
    const out = [], q = String(search || '').toLowerCase().trim();
    for (let page = 0; url && page < (q ? 6 : 2); page++) {
      const d = await pylon(url.replace(PYLON, ''));
      for (const p of d.data || []) {
        const x = pylonProject(p), hay = JSON.stringify([x.reference, x.customer, x.address]).toLowerCase();
        if (!q || q.split(/\s+/).every((w) => hay.includes(w))) out.push(x);
      }
      if (out.length >= 15) break;
      url = d.links && d.links.next;
    }
    return { projects: out.slice(0, 15), note: out.length ? undefined : 'No matching Pylon projects found.' };
  }
});
tool({
  name: 'pylon_project', group: 'pylon',
  description: 'Full details of one Pylon project and its designs: system size, panels, inverter, battery, price, STCs, deposit, whether it is sold or signed, and the proposal links. Use after pylon_find_projects.',
  input_schema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  async run({ project_id }) {
    const p = await pylon('/solar_projects/' + encodeURIComponent(project_id));
    const proj = pylonProject(p.data);
    const ds = await pylon('/solar_designs?filter[project]=' + encodeURIComponent(project_id) + '&fields[solar_designs]=' + DESIGN_FIELDS).catch(() => ({ data: [] }));
    const designs = (ds.data || []).map(pylonDesign).map((d) => ({ ...d, signed: d.id === proj.signed_design_id }));
    return { project: proj, designs, note: 'The proposal link is the customer-facing page and includes their details; only share it with that customer.' };
  }
});
tool({
  name: 'pylon_create_project', group: 'pylon', action: true,
  description: 'Set up a new Pylon project for a customer (for example from a GoHighLevel booking or calendar appointment). It is created UNCOMMITTED, so it costs no credits: it waits in Pylon under "Awaiting activation" until Will confirms the location there. Give the full street address split into parts. Checks for an existing project with the same reference first.',
  input_schema: { type: 'object', properties: {
    customer_name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
    street: { type: 'string', description: 'street line, e.g. 14 Grevillea Cres' }, suburb: { type: 'string' }, state: { type: 'string', description: 'e.g. Victoria' }, postcode: { type: 'string' },
    reference: { type: 'string', description: 'optional; defaults to an ELTRA- reference' },
    phases: { type: 'string', enum: ['one', 'three'] }, storeys: { type: 'integer' }, roof_type: { type: 'string' }
  }, required: ['customer_name', 'street', 'suburb', 'postcode'] },
  async describe(i) { return { title: 'Set up a Pylon project', lines: [i.customer_name, [i.street, i.suburb, i.state || 'Victoria', i.postcode].join(', '), [i.phone, i.email].filter(Boolean).join(' · '), 'Created as "Awaiting activation", so no credits are used until you confirm the location in Pylon.'].filter(Boolean) }; },
  async run(i) {
    const ref = i.reference || ('ELTRA-' + String(i.customer_name).replace(/[^A-Za-z]/g, '').slice(0, 10).toUpperCase() + '-' + String(i.postcode || '').replace(/\D/g, ''));
    const dupe = await pylon('/solar_projects?filter[reference_number]=' + encodeURIComponent(ref) + '&filter[is_archived]=any&filter[is_committed]=any').catch(() => ({ data: [] }));
    if (dupe.data && dupe.data.length) return { created: false, already_exists: pylonProject(dupe.data[0]) };
    const site = {}; if (i.phases) site.power_phases = i.phases; if (i.storeys) site.number_of_storeys = i.storeys; if (i.roof_type) site.roof_type = i.roof_type;
    const attrs = { is_committed: false, reference_number: ref,
      site_address: { line1: i.street, line2: '', city: i.suburb, state: i.state || 'Victoria', zip: String(i.postcode), country: 'Australia' },
      customer_details: { name: i.customer_name, phone: i.phone || '', email: i.email || '' } };
    if (Object.keys(site).length) attrs.site_details = site;
    const d = await pylon('/solar_projects', { method: 'POST', body: JSON.stringify({ data: { type: 'solar_projects', attributes: attrs } }) });
    return { created: true, project: pylonProject(d.data), next_step: 'Open Pylon > Project Library > Awaiting activation, check the pin is on the right roof and confirm it to start designing.' };
  }
});
tool({
  name: 'pylon_new_project_link', group: 'pylon',
  description: 'Make a link that opens Pylon on a customer\'s address with their details filled in, ready for Will to confirm and start a design himself. Nothing is created until he confirms in Pylon.',
  input_schema: { type: 'object', properties: { address: { type: 'string' }, customer_name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } }, required: ['address'] },
  async run(i) {
    const q = new URLSearchParams({ search: i.address, country: 'AU' });
    if (i.customer_name) q.set('customer_name', i.customer_name); if (i.email) q.set('customer_email', i.email); if (i.phone) q.set('customer_phone', i.phone);
    return { link: 'https://app.getpylon.com/map/address?' + q.toString() };
  }
});


// ---------- To-do list (sections like DNSP, Quoting, Order stock) ----------
tool({
  name: 'todo_list', group: 'core',
  description: 'Show the to-do list. By default only the ones for the person you are talking to (and shared ones); whose: "everyone" shows the whole team\'s, "will" or "ethan" one person\'s. Optionally one section (e.g. "DNSP", "Quoting", "Order stock", "Install dates", "Accounts", "Socials", "Admin"). Includes ids for ticking things off.',
  input_schema: { type: 'object', properties: { section: { type: 'string' }, include_done: { type: 'boolean' }, whose: { type: 'string', enum: ['mine', 'everyone', 'will', 'ethan'] } } },
  async run({ section, include_done, whose }) {
    const d = await loadTodos(), low = String(section || '').toLowerCase(), me = currentUser();
    const want = whose === 'everyone' ? null : whose === 'will' || whose === 'ethan' ? whose : me;
    const items = d.items.filter((x) => (include_done || !x.done) && (!want || x.owner === want || x.owner === 'both') && (!low || x.section.toLowerCase().includes(low) || low.includes(x.section.toLowerCase())));
    return { sections: d.sections, items: items.map((x) => ({ id: x.id, section: x.section, text: x.text, for: x.owner, due: x.due || undefined, done: x.done || undefined, ref: x.ref || undefined })) };
  }
});
tool({
  name: 'todo_add', group: 'core',
  description: 'Add a to-do. section: DNSP (pre-approvals, grid connections), Quoting, Order stock, Install dates (booking installs in), Accounts (invoicing, Xero/MYOB), Socials (Facebook/Instagram), Admin, or a new section name. Ethan looks after Order stock, Install dates, Accounts and Socials; Will does DNSP, Quoting and the rest, so if for is not given and the task clearly belongs to the other person, set for to them. for: "me" (default, the person you are talking to), "will", "ethan" or "both". due: YYYY-MM-DD if a day was given. ref: customer or job it relates to.',
  input_schema: { type: 'object', properties: { text: { type: 'string' }, section: { type: 'string' }, for: { type: 'string', enum: ['me', 'will', 'ethan', 'both'] }, due: { type: 'string' }, ref: { type: 'string' } }, required: ['text'] },
  async run(i) { const it = await addTodo({ ...i, owner: i.for }); return { added: it }; }
});
tool({
  name: 'todo_update', group: 'core',
  description: 'Tick off (done: true), reopen, rename, move or re-date a to-do by id (get ids from todo_list).',
  input_schema: { type: 'object', properties: { id: { type: 'string' }, done: { type: 'boolean' }, text: { type: 'string' }, section: { type: 'string' }, due: { type: 'string' }, for: { type: 'string', enum: ['will', 'ethan', 'both'] } }, required: ['id'] },
  async run({ id, for: f, ...patch }) { if (f) patch.owner = f; const it = await updateTodo(id, patch); return { updated: it }; }
});

// ---------- Read a power bill, CES or other PDF/photo (Drive file or email attachment) ----------
const DOC_FIELDS = {
  bill: { customer_name: 'account holder name', supply_address: 'supply / site address', nmi: 'NMI (10 or 11 characters)', meter_number: 'meter number(s)', retailer: 'energy retailer', distributor: 'distribution network (Powercor, CitiPower, Jemena, AusNet Services or United Energy), from the bill or worked out from the NMI', phases: 'single or three phase if shown', tariff: 'tariff name', solar_feed_in: 'true if there is an existing solar feed-in on the bill' },
  ces: { ces_number: 'Certificate of Electrical Safety number', completion_date: 'date the work was completed, YYYY-MM-DD', site_address: 'address of the work', customer_name: 'customer / owner name', electrician: 'licensed electrician name and licence number', work_description: 'short description of the work', inverter: 'inverter make, model and serial number(s) if listed', battery: 'battery make, model and serial number(s) if listed', solar: 'panel make/model/quantity or kW if listed', export_limit: 'export limit if listed', test_results_ok: 'true if the tests shown passed' },
  other: { document_type: 'what the document is', key_details: 'the important names, numbers, dates and amounts, as short "label: value" lines' }
};
async function claudeModel(key) {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
  const d = await r.json().catch(() => ({})), ids = (d.data || []).map((m) => m.id);
  return ids.find((x) => /sonnet/.test(x)) || ids.find((x) => /opus/.test(x)) || ids[0];
}
tool({
  name: 'read_document', group: 'google',
  description: 'Read a PDF or photo and pull out the details: kind "bill" (power bill: NMI, meter number, retailer, distributor, account name, address), kind "ces" (Certificate of Electrical Safety: CES number, completion date, serial numbers, electrician) or "other". Give a Drive file_id (find it with drive_search, e.g. in the customer\'s Customer Quotes folder) or a Gmail message_id plus the attachment filename. Use this to fill DNSP pre-approval and commissioning packs instead of asking Will.',
  input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['bill', 'ces', 'other'] }, file_id: { type: 'string' }, message_id: { type: 'string' }, filename: { type: 'string' } }, required: ['kind'] },
  async run({ kind, file_id, message_id, filename }) {
    const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    let b64, mime, name;
    if (file_id) {
      const meta = await g(DRIVE + '/files/' + encodeURIComponent(file_id) + '?supportsAllDrives=true&fields=name,mimeType,size');
      if (+meta.size > 15e6) throw new Error('That file is too big to read (over 15 MB)');
      const res = await fetch(DRIVE + '/files/' + encodeURIComponent(file_id) + '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + (await accessToken()) } });
      if (!res.ok) throw new Error('Could not download that file from Drive (' + res.status + ')');
      b64 = Buffer.from(await res.arrayBuffer()).toString('base64'); mime = meta.mimeType; name = meta.name;
    } else if (message_id) {
      const m = await g(GMAIL + '/messages/' + encodeURIComponent(message_id) + '?format=full');
      const atts = attachments(m.payload).filter((a) => /pdf|image\//.test(a.mime_type));
      const a = (filename && atts.find((x) => x.filename === filename)) || atts[0];
      if (!a) throw new Error('That email has no PDF or image attachment');
      const d = await g(GMAIL + '/messages/' + m.id + '/attachments/' + a.attachment_id);
      b64 = String(d.data).replace(/-/g, '+').replace(/_/g, '/'); mime = a.mime_type; name = a.filename;
    } else throw new Error('Give a Drive file_id or an email message_id');
    const isPdf = /pdf/.test(mime), isImg = /^image\/(jpeg|png|gif|webp)$/.test(mime);
    if (!isPdf && !isImg) return { name, note: 'Can only read PDFs and JPEG/PNG photos (this is ' + mime + ').' };
    const fields = DOC_FIELDS[kind] || DOC_FIELDS.other, props = {};
    Object.keys(fields).forEach((k) => { props[k] = { type: ['string', 'null'], description: fields[k] }; });
    const model = await claudeModel(key);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, tools: [{ name: 'details', description: 'Details read from the document', input_schema: { type: 'object', properties: props } }], tool_choice: { type: 'tool', name: 'details' },
        messages: [{ role: 'user', content: [
          isPdf ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } } : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          { type: 'text', text: 'Read this ' + (kind === 'bill' ? 'Australian electricity bill' : kind === 'ces' ? 'Victorian Certificate of Electrical Safety' : 'document') + ' and fill in the details. Copy numbers exactly as printed. Use null for anything not shown; never guess.' }
        ] }] })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Could not read the document: ' + ((out.error && out.error.message) || res.status));
    const t = (out.content || []).find((c) => c.type === 'tool_use');
    return { file: name, kind, details: t ? t.input : null };
  }
});

// ---------- DNSP browser tasks: pre-approval and commissioning (filled in by Claude in Chrome) ----------
tool({
  name: 'dnsp_task_pack', group: 'pylon',
  description: 'Prepare a DNSP portal task for a Pylon project, ready for Will to hand to Claude in Chrome: task "preapproval" (solar/battery pre-approval application) or "commissioning" (notify the distributor the system is installed and the inverter is commissioned). Pulls the customer, site, NMI, meter, retailer, phases and system (signed design, else primary) from Pylon, lists anything missing, and returns the Chrome instruction plus the distributor portal link. Before calling it, gather the details yourself: find the customer\'s power bill (their Customer Quotes folder in Drive, or an email from them) and read it with read_document kind "bill" for NMI, meter number, retailer and distributor; for commissioning also find the CES (Drive or email) and read it with kind "ces" for the CES number, completion date and serial numbers. Pass everything you found as the inputs below, plus anything Will tells you. Only ask Will for what you could not find. The dashboard shows Copy and Open portal buttons, so just summarise and flag what is still missing.',
  input_schema: { type: 'object', properties: {
    project_id: { type: 'string' }, task: { type: 'string', enum: ['preapproval', 'commissioning'] },
    distributor: { type: 'string' }, export_limit_kw: { type: 'number' },
    nmi: { type: 'string' }, meter_number: { type: 'string' }, retailer: { type: 'string' }, phases: { type: 'string', description: 'single or three' },
    preapproval_number: { type: 'string' }, install_date: { type: 'string', description: 'YYYY-MM-DD the install was completed' },
    inverter_serials: { type: 'string' }, battery_serials: { type: 'string' }, ces_number: { type: 'string', description: 'Certificate of Electrical Safety number' }
  }, required: ['project_id', 'task'] },
  async run(i) {
    const p = await pylon('/solar_projects/' + encodeURIComponent(i.project_id));
    const a = p.data.attributes || {}, site = a.site_details || {}, cust = a.customer_details || {}, proj = pylonProject(p.data);
    const ds = await pylon('/solar_designs?filter[project]=' + encodeURIComponent(i.project_id) + '&fields[solar_designs]=' + DESIGN_FIELDS).catch(() => ({ data: [] }));
    const designs = (ds.data || []).map(pylonDesign);
    const d = designs.find((x) => x.id === proj.signed_design_id) || designs.find((x) => x.primary) || designs[0] || null;
    // details read from the bill / CES (or given by Will) win over blanks in Pylon
    if (i.nmi) site.nmi = i.nmi; if (i.meter_number) site.meter_number = i.meter_number; if (i.retailer) site.energy_retailer = i.retailer;
    const prefs = await loadPrefs(), portal = portalFor(prefs, i.distributor || site.energy_distributor);
    const phases = (i.phases ? String(i.phases).replace(/ ?phase$/i, '') : '') || { one: 'single', two: 'two', three: 'three', split: 'split' }[site.power_phases] || site.power_phases || '';
    const pre = i.preapproval_number || site.dnsp_preapproval_number || '';
    const commissioning = i.task === 'commissioning';
    const missing = [];
    if (!site.nmi) missing.push('NMI');
    if (!portal.name) missing.push('distributor');
    if (!d) missing.push('a design in Pylon'); else if (!d.inverters.length) missing.push('inverter model');
    if (!commissioning) { if (!site.meter_number) missing.push('meter number'); if (!site.energy_retailer) missing.push('retailer'); if (!phases) missing.push('phases'); if (!i.export_limit_kw) missing.push('export limit to request'); }
    else { if (!pre) missing.push('pre-approval reference number'); if (!i.install_date) missing.push('install completion date'); if (!i.inverter_serials) missing.push('inverter serial number(s)'); if (d && d.battery_kwh && !i.battery_serials) missing.push('battery serial number(s)'); if (!i.ces_number) missing.push('CES number'); if (!i.export_limit_kw) missing.push('export limit set on the inverter'); }
    const sys = d ? d.solar_kw + ' kW DC solar' + (d.panels.length ? ' (' + d.panels.join('; ') + ')' : '') + (d.inverters.length ? ', inverter ' + d.inverters.join('; ') : '') + (d.battery_kwh ? ', battery ' + (d.batteries.join('; ') || '') + ' ' + d.battery_kwh + ' kWh' : '') : '[no design yet]';
    const lines = [
      'Go to the ' + (portal.name || '[distributor]') + ' connections portal (I am logged in) and ' + (commissioning
        ? 'complete the post-installation / commissioning notification for this solar' + (d && d.battery_kwh ? ' and battery' : '') + ' system (installation completed, inverter commissioned):'
        : 'start a new solar' + (d && d.battery_kwh ? ' and battery' : '') + ' pre-approval / embedded generation application with these details:'),
      'Customer: ' + [cust.name, cust.phone, cust.email].filter(Boolean).join(', '),
      'Site: ' + (proj.address || '[address]') + ' · NMI ' + (site.nmi || '[missing]') + (site.meter_number ? ' · meter ' + site.meter_number : '') + (site.energy_retailer ? ' · retailer ' + site.energy_retailer : '') + (phases ? ' · ' + phases + ' phase' : ''),
      'System: ' + sys,
      commissioning ? 'Pre-approval reference: ' + (pre || '[ask Will]') : null,
      commissioning ? 'Installation completed: ' + (i.install_date || '[ask Will]') : null,
      commissioning ? 'Inverter serial number(s): ' + (i.inverter_serials || '[ask Will]') + (d && d.battery_kwh ? ' · Battery serial number(s): ' + (i.battery_serials || '[ask Will]') : '') : null,
      commissioning ? 'Inverter set to AS/NZS 4777.2 Australia A region settings.' : null,
      commissioning ? 'Certificate of Electrical Safety number: ' + (i.ces_number || '[ask Will]') : null,
      (commissioning ? 'Export limit set on the inverter: ' : 'Export limit requested: ') + (i.export_limit_kw ? i.export_limit_kw + ' kW' : '[confirm with Will]'),
      'Installer company: Eltra Energy. Use the installer and accreditation details already saved in the portal.',
      'Fill in every field you can. If the form asks for something not listed here (photos, documents, other numbers), list it for me. STOP before submitting so I can check it.'
    ].filter(Boolean);
    return {
      browser_task: { title: (commissioning ? 'Commissioning notice' : 'Pre-approval') + ' – ' + (cust.name || proj.address || 'customer'), distributor: portal.name, portal_url: portal.url, instruction: lines.join('\n'), missing },
      missing, note: 'The dashboard shows a card with Copy and Open portal buttons. Tell Will what is missing in one or two lines; offer a DNSP to-do.' + (portal.name && !portal.url ? ' No portal link is saved for ' + portal.name + ' yet: Will can add it under Settings > DNSP portals.' : '')
    };
  }
});


// ---------- Instagram (the instagram-agent skill pack, adapted to run inside Eltra) ----------
const IG_NAMES = Object.keys(SKILLS);
tool({
  name: 'instagram_skill', group: 'core',
  description: 'Load one of the Instagram skill guides before doing Instagram work, then follow it: ig-caption (captions), ig-carousel (swipe posts), ig-reel (Reel scripts with scored hooks), ig-story (stories), ig-plan (the week\'s posts), ig-comment (comments on others\' posts), ig-reply (replies under our posts), ig-dm (DMs), ig-repurpose (one piece into many), ig-profile (score and rewrite the profile), ig-audit (review past posts from screenshots or numbers Ethan gives), ig-viral (what is working in the niche; needs examples from Ethan since you can\'t browse Instagram), ig-human (making text sound human). Also returns Eltra Energy\'s saved Instagram voice.',
  input_schema: { type: 'object', properties: { skill: { type: 'string', enum: IG_NAMES } }, required: ['skill'] },
  async run({ skill }) {
    const sk = SKILLS[skill]; if (!sk) throw new Error('Unknown skill ' + skill);
    const vs = await blobStore().get('ig-voice', { type: 'json' }).catch(() => null), voice = vs && vs.text;
    const out = {
      guide: sk.body,
      how_to_use_here: 'Every tool the guide mentions runs here under a different name: humanize.py and detect.py = instagram_humanize (run it on every draft before showing it); caption.py = instagram_humanize with is_caption true (add keywords for the search terms); hookscore.py = instagram_hooks; beats.py = instagram_beats; swipe.py = instagram_swipe; the carousel "1080x1350 files" = instagram_carousel (Ethan downloads the slide images from the chat). For the ig-viral "go and look" step: use instagram_research to read the chosen accounts directly (engagement, no views), or instagram_research_in_browser to have Claude in Chrome read real view counts in Ethan\'s logged-in browser; web_search helps find accounts; Ethan can also attach screenshots. You can\'t post: Ethan posts. Never invent numbers, results or customer stories: use real ones from Pylon, jobs or what Ethan tells you, and never name a customer or show their address without their OK.',
      brand_voice: voice || 'Not saved yet. Before drafting, offer to fill it in with Ethan (instagram_voice) using this template:\n' + VOICE_TEMPLATE
    };
    if (skill === 'ig-profile') out.rubric = RUBRIC;
    if (skill === 'ig-reel') out.hook_formulas = (HOOKS.hooks || []).map((h) => h.name + ': ' + h.template + ' (e.g. ' + h.example + ')');
    return out;
  }
});
tool({
  name: 'instagram_humanize', group: 'core',
  description: 'Clean an Instagram draft (caption, script, comment, reply, DM) exactly as the skill pack\'s humanizer does: strips em dashes, invisible characters and stock AI phrases, flags structural tells to rewrite by hand, and scores it on five checks (PASS / REVIEW / FLAGGED). With is_caption it also runs the caption check (what shows before "… more", hashtags, links, one ask, emoji, search terms). Run it on every draft; if it is not PASS, rewrite the flagged lines and run it again (two rounds is normal). Show Ethan the cleaned text, not just the score.',
  input_schema: { type: 'object', properties: { text: { type: 'string' }, is_caption: { type: 'boolean' }, keywords: { type: 'array', items: { type: 'string' }, description: 'search terms the caption should contain' } }, required: ['text'] },
  async run({ text, is_caption, keywords }) {
    const h = humanize(text), before = detect(text), after = detect(h.text);
    return { cleaned: h.text, changed: h.changes, rewrite_by_hand: h.flags, score_before: before.human_score + ' ' + before.verdict, score_after: after, caption: is_caption ? captionLint(h.text, keywords || []) : undefined,
      honesty: 'These are local checks modelled on what AI detectors look for. They are not GPTZero or similar and can\'t promise a result.' };
  }
});
tool({
  name: 'instagram_hooks', group: 'core',
  description: 'Score and rank Reel hooks (the first line, said in the first ~3 seconds) on length, specificity, stakes, front-loading and who it speaks to, with dealbreakers (greetings, "stop scrolling", preambles, hashtags, emoji). Pass 3 or more options and shoot the top one.',
  input_schema: { type: 'object', properties: { hooks: { type: 'array', items: { type: 'string' } } }, required: ['hooks'] },
  async run({ hooks }) { return rankHooks(hooks); }
});
tool({
  name: 'instagram_beats', group: 'core',
  description: 'Turn a Reel script (one line per beat) into a timed beat sheet: timecodes, hook/mid/CTA, beats that run too long, runs with nothing concrete, whether it loops, and length against a target.',
  input_schema: { type: 'object', properties: { script: { type: 'string' }, wpm: { type: 'number', description: 'speaking pace, default 165 (or the voice file\'s pace)' }, target_seconds: { type: 'number' } }, required: ['script'] },
  async run({ script, wpm, target_seconds }) { return beatSheet(script, wpm || 165, target_seconds || null); }
});
tool({
  name: 'instagram_swipe', group: 'core',
  description: 'Rank reels Ethan has found (or you found with web_search) by how far each beat its own account (views ÷ the account\'s typical views, or followers), name the hook formula each used and score the hooks. This is the research step of ig-viral.',
  input_schema: { type: 'object', properties: { reels: { type: 'array', items: { type: 'object', properties: { account: { type: 'string' }, followers: { type: 'string' }, median: { type: 'string', description: 'the account\'s typical views per reel' }, views: { type: 'string' }, hook: { type: 'string' } }, required: ['views', 'hook'] } } }, required: ['reels'] },
  async run({ reels }) { return swipeFile(reels); }
});
tool({
  name: 'instagram_carousel', group: 'core',
  description: 'Make the slide images for a carousel (1080×1350, Eltra Energy branding). Give the cover and each slide\'s words (keep each slide short: a heading and one or two lines). Ethan downloads the images from the card in the chat and posts them. Run the slide text through instagram_humanize first.',
  input_schema: { type: 'object', properties: { slides: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['heading'] }, description: 'first is the cover, last is usually the ask' } }, required: ['slides'] },
  async run({ slides }) { const s = (slides || []).slice(0, 10).map((x) => ({ heading: String(x.heading || '').slice(0, 120), body: String(x.body || '').slice(0, 300) })); return { carousel: { slides: s }, note: 'The dashboard shows the slides with a Download button. Tell Ethan they are ready.' }; }
});
tool({
  name: 'instagram_voice', group: 'core',
  description: 'Read or save Eltra Energy\'s Instagram voice (who we are, how we sound, words we use and avoid, positions, off-limits topics, proof we can use, the call to action). Every Instagram skill uses it. To save, pass the full filled-in text.',
  input_schema: { type: 'object', properties: { save: { type: 'string', description: 'the complete voice text to save (replaces the old one)' } } },
  async run({ save }) {
    if (save) { await blobStore().setJSON('ig-voice', { text: String(save).slice(0, 5000), savedAt: new Date().toISOString() }); return { saved: true }; }
    const v = await blobStore().get('ig-voice', { type: 'json' }).catch(() => null);
    return v && v.text ? { voice: v.text } : { voice: null, template: VOICE_TEMPLATE };
  }
});


// ---------- Instagram account (posting, insights, comments) ----------
tool({
  name: 'instagram_post', group: 'instagram', action: true,
  description: 'Post to the Eltra Energy Instagram: one photo or a carousel of 2-10 images, with the caption. image_urls must be public JPEG links: use the "saved for posting" links on photos Ethan attached, or the slide links sent from a carousel card\'s "Post to Instagram" button. Run the caption through instagram_humanize (is_caption) first. Will or Ethan approves before it goes live.',
  input_schema: { type: 'object', properties: { image_urls: { type: 'array', items: { type: 'string' } }, caption: { type: 'string' } }, required: ['image_urls', 'caption'] },
  async describe(i) { const n = (i.image_urls || []).length; return { title: 'Post to Instagram' + (n > 1 ? ' (carousel, ' + n + ' slides)' : ''), lines: [String(i.caption || '').slice(0, 400) + (String(i.caption || '').length > 400 ? '…' : '')] }; },
  async run(i) { return publishPost(i); }
});
tool({
  name: 'instagram_finish_post', group: 'instagram',
  description: 'Finish publishing an Instagram post that was still processing (use the container_id instagram_post returned).',
  input_schema: { type: 'object', properties: { container_id: { type: 'string' } }, required: ['container_id'] },
  async run({ container_id }) { return finishPost(container_id); }
});
tool({
  name: 'instagram_insights', group: 'instagram',
  description: 'The Eltra Energy Instagram account (followers, posts) and its recent posts with likes, comments, reach, saves, shares and views. Use for ig-audit, weekly reviews and "how did that post do?".',
  input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'how many recent posts, default 10' } } },
  async run({ limit }) { return recentPosts(limit || 10); }
});
tool({
  name: 'instagram_comments', group: 'instagram',
  description: 'Recent comments on the Eltra Energy Instagram posts (or one post by media_id), newest first, with comment ids for replying. Use with the ig-reply guide: sort into keyword / lead / substance / question / support / noise, then draft replies in that order.',
  input_schema: { type: 'object', properties: { media_id: { type: 'string' } } },
  async run(i) { return listComments(i); }
});
tool({
  name: 'instagram_reply', group: 'instagram', action: true,
  description: 'Reply to a comment on an Eltra Energy Instagram post (by comment_id). Run the reply through instagram_humanize first. Approved before it posts.',
  input_schema: { type: 'object', properties: { comment_id: { type: 'string' }, message: { type: 'string' }, to: { type: 'string', description: 'who you are replying to and what they said, for the approval card' } }, required: ['comment_id', 'message'] },
  async describe(i) { return { title: 'Reply on Instagram' + (i.to ? ' to ' + i.to : ''), lines: [i.message] }; },
  async run(i) { return replyComment(i); }
});
tool({
  name: 'instagram_hide_comment', group: 'instagram', action: true,
  description: 'Hide (or unhide) a spam or abusive comment on an Eltra Energy Instagram post.',
  input_schema: { type: 'object', properties: { comment_id: { type: 'string' }, hide: { type: 'boolean' }, text: { type: 'string', description: 'the comment, for the approval card' } }, required: ['comment_id'] },
  async describe(i) { return { title: (i.hide === false ? 'Unhide' : 'Hide') + ' an Instagram comment', lines: [i.text || i.comment_id] }; },
  async run(i) { return hideComment(i); }
});


tool({
  name: 'instagram_research', group: 'instagram',
  description: 'The ig-viral research step, done directly: look up 6-12 other Instagram business or creator accounts (handles), pull their recent posts, and rank every post by how far it beat that account\'s own normal (likes + comments vs the account\'s median), with the hook formula and hook score. Pick accounts per the ig-viral guide (4 direct competitors slightly ahead, 4 adjacent with the same audience, 2-4 much bigger for format only), or ask Ethan for them. Meta does not share view counts here; for views, use instagram_research_in_browser.',
  input_schema: { type: 'object', properties: { accounts: { type: 'array', items: { type: 'string' } }, per_account: { type: 'integer', description: 'recent posts per account, default 12' }, reels_only: { type: 'boolean' } }, required: ['accounts'] },
  async run({ accounts, per_account, reels_only }) {
    const r = await researchAccounts(accounts, per_account || 12);
    const rows = reels_only ? r.rows.filter((x) => x.type === 'Reel') : r.rows;
    const ranked = swipeFile(rows);
    const extra = Object.fromEntries(rows.map((x) => [x.hook + '|' + x.account, x]));
    if (ranked.reels) ranked.reels = ranked.reels.slice(0, 25).map((x) => { const e = extra[x.hook + '|' + x.account] || {}; return { multiple: x.multiple, account: x.account, engagement: x.views, type: e.type, when: e.when, formula: x.formula, hook_score: x.hook_score, hook: x.hook, link: e.link }; });
    const blocked = !r.rows.length && r.problems.some((p) => /permission|\(#10\)|\(#200\)|not authorized|advanced access/i.test(p));
    if (blocked) return { could_not_read: r.problems, next_step: 'Meta hasn\'t switched on looking up other accounts for this app yet (it needs Meta\'s App Review). Tell Ethan in one line, then straight away prepare the Claude in Chrome version with instagram_research_in_browser for the same accounts.' };
    return { ...ranked, measured_on: 'likes + comments against each account\'s median (Meta doesn\'t share other accounts\' views). Over 3x is a signal; under 1.5x is a normal day.', could_not_read: r.problems.length ? r.problems : undefined };
  }
});
tool({
  name: 'instagram_research_in_browser', group: 'core',
  description: 'For ig-viral with real view counts: prepare a Claude in Chrome task that reads the chosen accounts\' Reels in Ethan\'s own logged-in browser (read only, at human pace) and returns a table to paste back here, which you then rank with instagram_swipe. The dashboard shows Copy and Open Instagram buttons.',
  input_schema: { type: 'object', properties: { accounts: { type: 'array', items: { type: 'string' } } }, required: ['accounts'] },
  async run({ accounts }) {
    const list = (accounts || []).map((a) => '@' + String(a).replace(/^@/, '').trim()).filter((a) => a.length > 1).slice(0, 12);
    const instruction = ['I am logged in to Instagram in this browser. Research these accounts, reading only (do not like, follow, comment, message or save anything, and go at a normal human pace):', list.join(', '), '',
      'For each account: open its profile, note the follower count, open the Reels tab and read the view counts on its last 12 Reels. The median is the middle one of those 12.',
      'List every Reel with views of at least 3 times that account\'s median. For each, open it and copy the first line exactly as said or shown on screen (the hook), plus the first on-screen text if different.',
      'Give me the result as a table with one row per Reel and these columns: account | followers | median | views | hook | on-screen text | link.',
      'If a profile needs anything other than reading, or something asks you to log in, stop and tell me.'].join('\n');
    return { browser_task: { title: 'Instagram research – ' + list.length + ' accounts', distributor: 'Instagram', portal_url: 'https://www.instagram.com/', instruction, missing: list.length ? [] : ['accounts to research'] }, note: 'Tell Ethan to paste Claude in Chrome\'s table back here; then rank it with instagram_swipe and write the swipe file.' };
  }
});


// ---------- Content schedule (the weekly Instagram autopilot) ----------
tool({
  name: 'content_schedule', group: 'core',
  description: 'The Instagram content schedule Eltra keeps filled for the coming week: each slot\'s date, format (carousel, reel, story), topic, status (planned → draft → scheduled/manual → posted; or skipped/failed) and id. Drafts need Will or Ethan to approve them in the Content schedule panel on the dashboard before anything is posted.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    const d = await loadContent(), cut = Date.now() - 7 * 864e5;
    return { settings: d.settings, what_works: d.learnings && d.learnings.text, items: d.items.filter((x) => Date.parse(x.at || x.createdAt) > cut).map((x) => ({ id: x.id, date: x.date, format: x.format, topic: x.topic, status: x.status, caption: x.caption ? x.caption.slice(0, 300) : undefined, link: x.link, error: x.error })) };
  }
});
tool({
  name: 'content_edit', group: 'core',
  description: 'Change a post in the content schedule: move it (date YYYY-MM-DD), change its topic or angle, edit the caption, skip it, or send it back to be redrafted with feedback (action "redraft" plus feedback). Approving still happens on the dashboard.',
  input_schema: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['edit', 'redraft', 'skip'] }, date: { type: 'string' }, topic: { type: 'string' }, angle: { type: 'string' }, caption: { type: 'string' }, feedback: { type: 'string' } }, required: ['id'] },
  async run(i) { const it = await updateItem(i.id, { ...i, action: i.action === 'edit' ? undefined : i.action }); return { updated: { id: it.id, date: it.date, topic: it.topic, status: it.status }, note: i.action === 'redraft' ? 'Eltra will redraft it within about 10 minutes.' : undefined }; }
});

// ---------- Improving Eltra (proposals need approval) ----------
tool({
  name: 'suggest_improvement', group: 'core',
  description: 'Propose an improvement to yourself (Eltra) for Will or Ethan to approve on the dashboard. Use it when you were asked for something you can\'t do, when a tool keeps failing, or when you notice a better way of working. kind "behaviour": a change to how you work, written as one clear instruction to yourself in change; it goes live when approved. kind "feature": needs new code or a new connection; put a short build brief in change. Don\'t propose things already possible.',
  input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['behaviour', 'feature'] }, title: { type: 'string' }, why: { type: 'string' }, change: { type: 'string' } }, required: ['kind', 'title', 'why', 'change'] },
  async run(i) { const it = await addProposal(i, 'chat'); return { proposed: { id: it.id, title: it.title, kind: it.kind }, note: 'It\'s waiting for approval in the Improvements panel on the dashboard.' }; }
});


// ---------- Signed jobs and install dates ----------
tool({
  name: 'jobs_list', group: 'core',
  description: 'Signed jobs Eltra is tracking: customer, kit, install date (and where it came from), and which after-sale reminders have gone out (stock a week before, CES on the day, DNSP commissioning 2 weeks after).',
  input_schema: { type: 'object', properties: {} },
  async run() { const d = await loadJobs(); return { jobs: d.list.filter((x) => !x.closed).map((x) => ({ customer: x.name, install_date: x.installDate || 'not set', set_by: x.installSource, kit: x.kit, reminders_sent: x.flags })) }; }
});
tool({
  name: 'job_install_date', group: 'core',
  description: 'Record or move a job\'s install date. Use it whenever Will or Ethan says when an install is, books one, or moves one ("Sarah\'s install is Tuesday", "move Mark to the 3rd"). The stock order (a week before), CES (on the day) and DNSP commissioning (2 weeks after) reminders run from this date. date: YYYY-MM-DD.',
  input_schema: { type: 'object', properties: { customer: { type: 'string' }, date: { type: 'string' } }, required: ['customer', 'date'] },
  async run({ customer, date }) {
    const day = parseDay(date); if (!day) throw new Error('Give the date as YYYY-MM-DD');
    const d = await loadJobs(), j = setInstall(d, customer, day, 'eltra'); await saveJobs(d);
    return { saved: { customer: j.name, install_date: j.installDate, previous: j.previousDate }, note: j.unsigned ? 'No signed job by that name yet; the date is saved and the reminders will still run.' : undefined };
  }
});


// ---------- Learning how to work (rules Will or Ethan teach her) ----------
tool({
  name: 'learn_rule', group: 'core', action: true,
  description: 'Learn a lasting rule about how to work, whenever Will or Ethan corrects you or says how things should be done from now on ("don\'t create the draft in Gmail, show me here first", "always copy Ethan on supplier emails", "never book installs on Fridays", "remember our deposit is 20%"). Write the rule as one clear instruction to yourself. They approve it in the chat, then you follow it in every future conversation. If it needs a new ability or connection rather than a change in how you work, use suggest_improvement with kind "feature" instead.',
  input_schema: { type: 'object', properties: { rule: { type: 'string', description: 'one clear instruction to yourself' }, why: { type: 'string', description: 'what they said, in a few words' } }, required: ['rule'] },
  async describe(i) { return { title: 'Teach Eltra this for good', lines: [i.rule].concat(i.why ? ['Because: ' + i.why] : []) }; },
  async run({ rule, why }) {
    const it = await addProposal({ kind: 'behaviour', title: String(rule).slice(0, 110), why: why || 'Taught in chat', change: rule }, 'taught in chat');
    await decide(it.id, 'approve');
    return { learned: rule, note: 'Saved for good. It applies from your next message, in every chat, for Will and Ethan.' };
  }
});
tool({
  name: 'learned_rules', group: 'core',
  description: 'The rules Eltra has been taught or has approved for how she works, with ids, so one can be changed or removed when asked ("stop doing that", "forget that rule").',
  input_schema: { type: 'object', properties: {} },
  async run() { const d = await loadImprove(); return { rules: d.items.filter((x) => x.kind === 'behaviour' && x.status === 'live').map((x) => ({ id: x.id, rule: x.change })) }; }
});
tool({
  name: 'unlearn_rule', group: 'core', action: true,
  description: 'Stop following a learned rule (by id from learned_rules), when Will or Ethan asks.',
  input_schema: { type: 'object', properties: { id: { type: 'string' }, rule: { type: 'string', description: 'the rule text, for the approval card' } }, required: ['id'] },
  async describe(i) { return { title: 'Stop following this rule', lines: [i.rule || i.id] }; },
  async run({ id }) { await decide(id, 'reject'); return { removed: true }; }
});

// Tools available right now (only the systems that are set up)
export function activeTools() {
  return T.filter((t) => t.group === 'google' ? !!process.env.GOOGLE_CLIENT_ID : t.group === 'ghl' ? ghlReady() : t.group === 'sm8' ? sm8Ready() : t.group === 'pylon' ? pylonReady() : t.group === 'instagram' ? igSetUp() : true);
}
export const toolByName = (n) => T.find((t) => t.name === n);
