// The agent's tools. "action" tools change something (send, move, create) and only run after Will taps Approve.
import { g, GMAIL, CAL, DRIVE, DRIVE_UP, accessToken } from './google.mjs';
import { loadTodos, addTodo, updateTodo, addTodos, updateTodos, urgencyFor } from './todos.mjs';
import { currentUser } from './util.mjs';
import { loadPrefs, portalFor } from './prefs.mjs';
import { loadContent, updateItem, deleteItems, markPosted } from './content.mjs';
import { addProposal, decide, loadImprove, refreshBuilds } from './improve.mjs';
import { loadJobs, saveJobs, setInstall, parseDay, findJob, normName, syncPreApprovals } from './jobs.mjs';
import { jobFolderReport } from './jobfolders.mjs';
import { smsReady, smsProvider, smsSender, sendSms, auMobile, auMobileLocal } from './sms.mjs';
import { SKILLS, HOOKS, VOICE_TEMPLATE, RUBRIC } from './instagram-data.mjs';
import { humanize, detect } from './instagram.mjs';
import { rankHooks, beatSheet, swipeFile, captionLint } from './instagram-tools.mjs';
import { igSetUp, publishPost, finishPost, recentPosts, listComments, replyComment, hideComment, researchAccounts } from './instagram-api.mjs';
import { store as blobStore } from './util.mjs';
import { tz, clip, melbToDate, melbToday } from './util.mjs';

// ---------------- helpers ----------------
const b64urlDecode = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const hdr = (m, name) => { const h = ((m.payload && m.payload.headers) || []).find((x) => x.name.toLowerCase() === name.toLowerCase()); return h ? h.value : ''; };
const strip = (html) => String(html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
export function bodyText(payload) {
  let plain = '', html = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data && !p.filename) plain += b64urlDecode(p.body.data).toString('utf8');
    else if (p.mimeType === 'text/html' && p.body && p.body.data && !p.filename) html += b64urlDecode(p.body.data).toString('utf8');
    (p.parts || []).forEach(walk);
  })(payload);
  return (plain || strip(html)).trim();
}
export function attachments(payload) {
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
// Will's default send-as address and Gmail signature (Settings > Signature). Needs no extra permission: gmail.modify can read it.
async function gmailSendAs() {
  try {
    const r = await g(GMAIL + '/settings/sendAs');
    const list = r.sendAs || [];
    const a = list.find((x) => x.isDefault) || list.find((x) => x.isPrimary) || list[0];
    const html = a && a.signature ? a.signature : '';
    const text = html ? html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|tr)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim() : '';
    return { html, text, email: (a && a.sendAsEmail) || '', name: (a && a.displayName) || '' };
  } catch (e) { return { html: '', text: '', email: '', name: '' }; }
}
const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();   // keeps header values to one line
// The message being replied to: the one named, or the latest real message in the thread (not a draft)
async function replyTarget(reply_to_message_id, thread_id) {
  const H = 'format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=References';
  if (reply_to_message_id) return g(GMAIL + '/messages/' + encodeURIComponent(reply_to_message_id) + '?' + H);
  if (!thread_id) return null;
  const t = await g(GMAIL + '/threads/' + encodeURIComponent(thread_id) + '?' + H);
  const msgs = (t.messages || []).filter((m) => !(m.labelIds || []).includes('DRAFT'));
  return msgs[msgs.length - 1] || { threadId: t.id, payload: { headers: [] } };
}
const replySubject = (o) => { const s = hdr(o, 'Subject'); return /^re:/i.test(s) ? s : 'Re: ' + s; };
// Builds the email (text + HTML, with Will's signature underneath, threaded when it is a reply) as Gmail wants it
async function buildEmail({ to, cc, subject, body, reply_to_message_id, thread_id }, sa) {
  let threadId, extra = '';
  const o = await replyTarget(reply_to_message_id, thread_id);
  if (o) {
    threadId = o.threadId || thread_id;
    const mid = hdr(o, 'Message-ID'), refs = hdr(o, 'References');
    if (mid) extra = 'In-Reply-To: ' + mid + '\r\nReferences: ' + (refs ? refs + ' ' : '') + mid + '\r\n';
    if (!subject) subject = replySubject(o);
  }
  // Gmail doesn't add the signature to emails made through the API, so add Will's default signature here
  // (HTML, with a plain-text copy) and send the email as text + HTML like Gmail does.
  const sig = sa || await gmailSendAs();
  body = String(body || '');
  const textBody = body.replace(/\s+$/, '') + (sig.text ? '\n\n' + sig.text : '\nWill\nEltra Energy');
  const htmlBody = '<div dir="ltr">' + escHtml(body.replace(/\s+$/, '')).replace(/\r?\n/g, '<br>') + (sig.html ? '<br><br><div class="gmail_signature" data-smartmail="gmail_signature">' + sig.html + '</div>' : '<br>Will<br>Eltra Energy') + '</div>';
  const bnd = 'eltra_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const part = (type, txt) => '--' + bnd + '\r\nContent-Type: ' + type + '; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(txt).toString('base64').replace(/.{76}/g, '$&\r\n') + '\r\n';
  const from = sig.email ? 'From: ' + (sig.name ? mimeWord('"' + oneLine(sig.name).replace(/"/g, '') + '"') + ' ' : '') + '<' + sig.email + '>\r\n' : '';
  const raw = from + 'To: ' + oneLine(to) + '\r\n' + (cc ? 'Cc: ' + oneLine(cc) + '\r\n' : '') + 'Subject: ' + mimeWord(oneLine(subject)) + '\r\n' + extra +
    'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="' + bnd + '"\r\n\r\n' + part('text/plain', textBody) + part('text/html', htmlBody) + '--' + bnd + '--';
  return { raw: b64url(raw), threadId, subject: oneLine(subject) };
}
tool({
  name: 'gmail_create_draft', group: 'google', action: true,
  // shown in full for approval first; it only goes into Gmail once approved
  async describe(i) { return { title: 'Put this email in Gmail as a draft' + (i.reply_to_message_id ? ' (reply)' : ''), lines: ['To: ' + (i.to || '(same thread)') + (i.cc ? '  ·  Cc: ' + i.cc : ''), 'Subject: ' + (i.subject || '(same as the thread)')], preview: i.body || '' }; },
  description: 'Create an email DRAFT in Will’s Gmail (nothing is sent). Only use this when Will asks for a draft; to send an email use gmail_send. To reply in an existing conversation, pass reply_to_message_id and the draft goes into that thread. Write in Will’s voice: friendly, plain Australian English, short. End the body with a short sign-off such as "Cheers," or "Thanks," and nothing after it: Will’s Gmail signature (name, details and logo) is added automatically underneath.',
  input_schema: { type: 'object', properties: { to: { type: 'string', description: 'Comma-separated addresses' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text' }, reply_to_message_id: { type: 'string' } }, required: ['to', 'body'] },
  async run({ to, cc, subject, body, reply_to_message_id }) {
    const e = await buildEmail({ to, cc, subject, body, reply_to_message_id });
    const d = await g(GMAIL + '/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: e.raw, ...(e.threadId ? { threadId: e.threadId } : {}) } }) });
    return { draft_id: d.id, saved: 'Draft saved in Gmail. It has NOT been sent.', to, subject: e.subject };
  }
});
// One email or a batch (emails: [...]); either way it is one Approve card and nothing is sent until approved
const MAX_SEND = 10;
const emailList = (i) => (Array.isArray(i.emails) && i.emails.length ? i.emails : [i]).map((e) => e || {});
tool({
  name: 'gmail_send', group: 'google', action: true,
  description: 'Send an email straight from Will’s Gmail (will@eltraenergy.com.au) with his Gmail signature added underneath. This is the normal way to send email: no draft is made, Will sees the whole email in one Approve card and it is sent the moment he approves. To reply in a conversation pass reply_to_message_id (or thread_id) so it stays in that thread; the subject is filled in from the thread if left out. To send several emails with one approval (e.g. a batch of follow-ups), pass them in emails (up to ' + MAX_SEND + '); for one card per email, call this tool once per email in the same step. Write in Will’s voice: friendly, plain Australian English, short. End the body with a short sign-off such as "Cheers," or "Thanks," and nothing after it.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Comma-separated addresses' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text' },
      reply_to_message_id: { type: 'string' }, thread_id: { type: 'string', description: 'Reply in this thread (to its latest message) when there is no message id' },
      emails: { type: 'array', description: 'Several emails to send with one approval. Use instead of the single-email fields.', items: { type: 'object', properties: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, reply_to_message_id: { type: 'string' }, thread_id: { type: 'string' } }, required: ['to', 'body'] } }
    }
  },
  async describe(i) {
    const list = emailList(i);
    const sa = await gmailSendAs();
    // fill in the subject of replies so the card shows exactly what goes out (read-only lookups)
    const subj = await Promise.all(list.map((e) => e.subject ? e.subject : (e.reply_to_message_id || e.thread_id) ? replyTarget(e.reply_to_message_id, e.thread_id).then(replySubject).catch(() => '(same as the thread)') : '(no subject)'));
    const head = (e, k) => ['To: ' + (e.to || '(missing)') + (e.cc ? '  ·  Cc: ' + e.cc : ''), 'Subject: ' + subj[k] + (e.reply_to_message_id || e.thread_id ? '  (reply in the same thread)' : '')];
    const from = 'From: ' + (sa.email || 'your Gmail');
    if (list.length === 1) {
      return { title: 'Send this email' + (list[0].reply_to_message_id || list[0].thread_id ? ' (reply)' : ''), lines: [from].concat(head(list[0], 0)), preview: String(list[0].body || '').replace(/\s+$/, '') + '\n\n' + (sa.text || 'Will\nEltra Energy') };
    }
    return {
      title: 'Send these ' + list.length + ' emails' + (list.length > MAX_SEND ? ' (only ' + MAX_SEND + ' can go at once, so this will be refused)' : ''),
      lines: [from, 'Your Gmail signature is added under each one.'],
      preview: list.map((e, k) => (k + 1) + '. ' + head(e, k).join('\n') + '\n\n' + String(e.body || '').replace(/\s+$/, '')).join('\n\n————————\n\n')
    };
  },
  async run(i) {
    const list = emailList(i);
    if (list.length > MAX_SEND) throw new Error('Too many emails at once (' + list.length + '). Send up to ' + MAX_SEND + ' per approval. Nothing was sent.');
    const bad = list.findIndex((e) => !oneLine(e.to) || !String(e.body || '').trim());
    if (bad >= 0) throw new Error('Email ' + (bad + 1) + ' is missing who it goes to or the message. Nothing was sent.');
    const sa = await gmailSendAs();
    const out = new Array(list.length);
    // a few at a time, to stay inside Gmail's sending limits and Netlify's time limit
    for (let k = 0; k < list.length; k += 3) {
      await Promise.all(list.slice(k, k + 3).map(async (e, j) => {
        const n = k + j;
        try {
          const m = await buildEmail(e, sa);
          const s = await g(GMAIL + '/messages/send', { method: 'POST', body: JSON.stringify({ raw: m.raw, ...(m.threadId ? { threadId: m.threadId } : {}) }) });
          out[n] = { sent: true, to: e.to, subject: m.subject, message_id: s.id, thread_id: s.threadId };
        } catch (err) { out[n] = { sent: false, to: e.to, error: err.message || 'Failed' }; }
      }));
    }
    if (out.length === 1) { if (!out[0].sent) throw new Error(out[0].error); return out[0]; }
    return { sent: out.filter((x) => x.sent).length, failed: out.filter((x) => !x.sent).length, emails: out };
  }
});
tool({
  name: 'gmail_send_draft', group: 'google', action: true,
  description: 'Send a Gmail draft that already exists. Only when Will has clearly asked to send that draft. To send a new email or reply, use gmail_send instead (no draft needed). Will approves it on screen first.',
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
// change or remove an existing event (ids come from calendar_events)
const calEv = (id) => CAL + '/events/' + encodeURIComponent(id);
const evWhen = (e) => (e.start && e.start.date ? e.start.date + ' (all day)' : e.start && e.start.dateTime ? melbDate(e.start.dateTime) : '');
const evGuests = (e) => (e && e.attendees || []).filter((a) => !a.self).length;
tool({
  name: 'calendar_update_event', group: 'google', action: true,
  description: 'Change an event on Will’s Google Calendar: title, times, location or description. event_id comes from calendar_events. Only give what changes. Times are Melbourne local time as YYYY-MM-DDTHH:MM; all_day_date (YYYY-MM-DD) makes it an all-day event on that day instead. Anyone invited gets the update.',
  input_schema: { type: 'object', properties: { event_id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, all_day_date: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } }, required: ['event_id'] },
  async describe(i) {
    const e = await g(calEv(i.event_id)).catch(() => null);
    return { title: 'Change calendar event', lines: [
      e ? 'Event: ' + (e.summary || '(no title)') + ', ' + evWhen(e) : 'Event id: ' + i.event_id,
      i.title && 'New title: ' + i.title,
      i.all_day_date ? 'New day: ' + i.all_day_date + ' (all day)' : (i.start || i.end) && 'New time: ' + (i.start || '…').replace('T', ' ') + ' to ' + (i.end || '…').replace('T', ' '),
      i.location && 'Location: ' + i.location, i.description && 'New description',
      evGuests(e) ? 'Guests (' + evGuests(e) + ') get the update.' : null
    ].filter(Boolean) };
  },
  async run(i) {
    const cur = await g(calEv(i.event_id)), body = {};
    if (i.title) body.summary = i.title;
    if (i.location) body.location = i.location;
    if (i.description) body.description = i.description;
    const dt = (v) => ({ dateTime: v.length === 16 ? v + ':00' : v, timeZone: tz, date: null });
    if (i.all_day_date) {
      const day = parseDay(i.all_day_date); if (!day) throw new Error('Give all_day_date as YYYY-MM-DD');
      body.start = { date: day, dateTime: null, timeZone: null }; body.end = { date: new Date(Date.parse(day + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10), dateTime: null, timeZone: null };
    } else {
      if (i.start) body.start = dt(i.start);
      if (i.end) body.end = dt(i.end);
    }
    if (!Object.keys(body).length) throw new Error('Nothing to change.');
    const e = await g(calEv(i.event_id) + '?sendUpdates=' + (evGuests(cur) ? 'all' : 'none'), { method: 'PATCH', body: JSON.stringify(body) });
    return { updated: true, event: eventOut(e) };
  }
});
tool({
  name: 'calendar_delete_event', group: 'google', action: true,
  description: 'Remove an event from Will’s Google Calendar (for example an install HOLD that is no longer needed). event_id comes from calendar_events. Anyone invited is told it is cancelled.',
  input_schema: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
  async describe(i) {
    const e = await g(calEv(i.event_id)).catch(() => null);
    return { title: 'Remove from calendar', lines: [e ? (e.summary || '(no title)') + ', ' + evWhen(e) : 'Event id: ' + i.event_id, evGuests(e) ? 'Guests (' + evGuests(e) + ') are told it’s cancelled.' : null].filter(Boolean) };
  },
  async run(i) {
    const e = await g(calEv(i.event_id));
    await g(calEv(i.event_id) + '?sendUpdates=' + (evGuests(e) ? 'all' : 'none'), { method: 'DELETE' });
    return { deleted: true, title: e.summary };
  }
});

tool({
  name: 'drive_search', group: 'google',
  description: 'Find files or folders in Google Drive by name (and optionally by text inside the file). Customer folders live in ELTRA ENERGY > Customer Quotes (folder id 1yRS0IDyBgfe_TVnE1V7wKnT8oapZPKyw), named "YYYY-MM-DD Name – Address": quotes in its Quoted Jobs subfolder (id 1DJbLBgjEweY_-xpPrLWqEoCCu2yVlX8D; some older ones loose in Customer Quotes), signed jobs in Active Jobs (id 1d0rJPuDDkewSQRbziI1l7-nf1yhrVyx6), finished jobs in Completed Jobs (id 1Yre7ebCvohiyzquQHolFGf6KapcLjeTQ).',
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
const TODO_FIELDS = { text: { type: 'string' }, section: { type: 'string' }, due: { type: 'string' }, ref: { type: 'string' }, note: { type: 'string', description: 'Optional extra detail shown under the to-do (what a customer said, what it is waiting on).' }, urgency: { type: 'string', enum: ['red', 'yellow', 'green'], description: 'Optional: red (urgent), yellow (soon), green (can wait). Only set it when asked to rate or prioritise, or the urgency is clear.' } };
const UPDATE_FIELDS = { id: { type: 'string' }, done: { type: 'boolean' }, text: { type: 'string' }, section: { type: 'string' }, due: { type: 'string' }, note: { type: 'string', description: 'Replace the whole note ("" clears it).' }, append_note: { type: 'string', description: 'Add this to the end of the existing note, on a new line (keeps what is already there).' }, for: { type: 'string', enum: ['will', 'ethan', 'both'] }, urgency: { type: 'string', enum: ['red', 'yellow', 'green', 'none'], description: 'red (urgent), yellow (soon), green (can wait), or none to clear the rating.' } };
// one line per item so a failure is plain to see
function batchReport(results, list, verb) {
  const out = results.map((r, n) => (r.ok ? { ok: true, [verb]: r.item } : { ok: false, error: r.error, asked: list[n] }));
  const failed = out.filter((r) => !r.ok).length;
  return { summary: (out.length - failed) + ' of ' + out.length + ' ' + verb + (failed ? '; ' + failed + ' FAILED, tell the person which ones' : ''), results: out };
}
tool({
  name: 'todo_list', group: 'core',
  description: 'Show the to-do list. By default only the ones for the person you are talking to (and shared ones); whose: "everyone" shows the whole team\'s, "will" or "ethan" one person\'s. Optionally one section (e.g. "DNSP" for all the DNSP sub-sections, "DNSP - Pre approval", "Quoting", "Order stock", "Install dates", "Accounts", "Socials", "Admin"). Includes ids for ticking things off, any note on each to-do, and its urgency (red urgent, yellow soon, green can wait; urgency_from_due means it was worked out from the due date, not set).',
  input_schema: { type: 'object', properties: { section: { type: 'string' }, include_done: { type: 'boolean' }, whose: { type: 'string', enum: ['mine', 'everyone', 'will', 'ethan'] } } },
  async run({ section, include_done, whose }) {
    const d = await loadTodos(), low = String(section || '').toLowerCase(), me = currentUser();
    const want = whose === 'everyone' ? null : whose === 'will' || whose === 'ethan' ? whose : me;
    const items = d.items.filter((x) => (include_done || !x.done) && (!want || x.owner === want || x.owner === 'both') && (!low || x.section.toLowerCase().includes(low) || (low.includes(x.section.toLowerCase()) && !/ - /.test(low))));
    // grouped in section order (DNSP sub-sections first, in their fixed order), keeping each section's own order
    const rank = (x) => { const i = d.sections.indexOf(x.section); return i < 0 ? d.sections.length : i; };
    items.sort((a, b) => rank(a) - rank(b));
    return { sections: d.sections, items: items.map((x) => ({ id: x.id, section: x.section, text: x.text, for: x.owner, due: x.due || undefined, done: x.done || undefined, ref: x.ref || undefined, note: x.note || undefined, urgency: urgencyFor(x) || undefined, urgency_from_due: (!x.urgency && x.due) || undefined })) };
  }
});
tool({
  name: 'invoice_scan', group: 'core',
  description: 'Check Ethan’s and Will’s inboxes for new supplier invoices and bills now (read-only: no email is sent, archived or changed) and add any new ones to Ethan’s Accounts to-dos, skipping ones already on the list. This already runs automatically early every morning, so only use it when someone asks to check for invoices again now. If the result says more: true, call it again to carry on.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    const { runInvoiceScan } = await import('./invoices.mjs');   // loaded here, as invoices.mjs uses this file's Gmail helpers
    const r = await runInvoiceScan({ force: true, budgetMs: 7000, batchSize: 4 });
    // just what the to-dos say: never the subjects or contents of Will's emails
    return { ...r, added: (r.added || []).map((x) => x.text) };
  }
});
tool({
  name: 'todo_add', group: 'core',
  description: 'Add a to-do. section: DNSP - Solar Vic, DNSP - Pre approval, DNSP - CES, DNSP - Grid connection, DNSP - Retailer request, Quoting, Order stock, Install dates (booking installs in), Accounts (invoicing, Xero/MYOB), Socials (Facebook/Instagram), Admin, or a new section name ("Parent - Sub" makes a sub-section). Ethan looks after Order stock, Install dates, Accounts and Socials; Will does DNSP, Quoting and the rest, so if for is not given and the task clearly belongs to the other person, set for to them. for: "me" (default, the person you are talking to), "will", "ethan" or "both". due: YYYY-MM-DD if a day was given. ref: customer or job it relates to. note: optional extra detail (what the customer said, what it is waiting on). urgency: optional red (urgent), yellow (soon) or green (can wait). To add several to-dos, put them all in items in ONE call (never several todo_add calls at once, or some can be lost), then check each result and tell the person about any that failed.',
  input_schema: { type: 'object', properties: { ...TODO_FIELDS, for: { type: 'string', enum: ['me', 'will', 'ethan', 'both'] }, items: { type: 'array', description: 'Several to-dos to add in one go, each with the same fields (text, section, for, due, ref, note, urgency).', items: { type: 'object', properties: { ...TODO_FIELDS, for: { type: 'string', enum: ['me', 'will', 'ethan', 'both'] } }, required: ['text'] } } } },
  async run({ items, ...i }) {
    if (Array.isArray(items) && items.length) {
      const list = i.text ? [i, ...items] : items;
      return batchReport(await addTodos(list.map((x) => ({ ...x, owner: x.for }))), list, 'added');
    }
    if (!i.text) throw new Error('A to-do needs some text');
    const it = await addTodo({ ...i, owner: i.for }); return { added: it };
  }
});
tool({
  name: 'todo_update', group: 'core',
  description: 'Tick off (done: true), reopen, rename, move (section, e.g. "DNSP - Grid connection") or re-date a to-do by id (get ids from todo_list), rate its urgency (urgency: red urgent, yellow soon, green can wait, none to clear; when asked to rate or prioritise to-dos, set them all in one call), or add a note to it. For "add a note to X: …" use append_note (keeps any note already there); use note only to replace the whole note, or note: "" to clear it. Notes stay on the to-do when it is moved or ticked off. Ticking off a "DNSP - Pre approval" to-do automatically adds a "Grid connection" to-do for that customer, and ticking off a "DNSP - Grid connection" one adds "Confirm meter reconfigured" under "DNSP - Retailer request", so don\'t add those yourself. To change several to-dos, put them all in updates in ONE call (never several todo_update calls at once, or some changes can be lost), then check each result and tell the person about any that failed.',
  input_schema: { type: 'object', properties: { ...UPDATE_FIELDS, updates: { type: 'array', description: 'Several to-dos to change in one go, each with its id and the fields to change.', items: { type: 'object', properties: UPDATE_FIELDS, required: ['id'] } } } },
  async run({ updates, ...one }) {
    const patchOf = ({ for: f, ...patch }) => (f ? { ...patch, owner: f } : patch);
    if (Array.isArray(updates) && updates.length) {
      const list = one.id ? [one, ...updates] : updates;
      return batchReport(await updateTodos(list.map(patchOf)), list, 'updated');
    }
    if (!one.id) throw new Error('Which to-do? Give its id (from todo_list).');
    const it = await updateTodo(one.id, patchOf(one)); return { updated: it };
  }
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
    const fields = DOC_FIELDS[kind] || DOC_FIELDS.other, keys = Object.keys(fields);
    // Ask for plain JSON in the prompt and parse it (newer models don't support a forced tool_choice).
    const shape = keys.map((k) => '  "' + k + '": ' + fields[k]).join('\n');
    const model = await claudeModel(key);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500,
        messages: [{ role: 'user', content: [
          isPdf ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } } : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          { type: 'text', text: 'Read this ' + (kind === 'bill' ? 'Australian electricity bill' : kind === 'ces' ? 'Victorian Certificate of Electrical Safety' : 'document') + ' and fill in the details. Copy numbers exactly as printed. Use null for anything not shown, cut off, blurry or otherwise unreadable; never guess.\n\nReply with only one JSON object (no other text, no code fence) with exactly these keys, each a string or null:\n{\n' + shape + '\n}' }
        ] }] })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Could not read the document: ' + ((out.error && out.error.message) || res.status));
    const text = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let parsed = null;
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a >= 0 && z > a) { try { parsed = JSON.parse(text.slice(a, z + 1)); } catch {} }
    if (!parsed || typeof parsed !== 'object') return { file: name, kind, details: null, note: 'I couldn\'t read the details from this document. Check the file is clear and try again, or read it yourself.' };
    const details = {}, unreadable = [];
    keys.forEach((k) => {
      let v = parsed[k];
      if (typeof v === 'string') { v = v.trim(); if (!v || /^(null|n\/?a|unknown|not (shown|visible|readable|legible)|unreadable|illegible)$/i.test(v)) v = null; }
      else if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      else v = null;
      // An NMI is 10 or 11 letters/digits; anything else is a misread, so don't pass it on.
      if (k === 'nmi' && v && !/^[A-Z0-9]{10,11}$/i.test(v.replace(/\s/g, ''))) v = null;
      else if (k === 'nmi' && v) v = v.replace(/\s/g, '').toUpperCase();
      details[k] = v; if (v === null) unreadable.push(k);
    });
    const r = { file: name, kind, details };
    if (unreadable.length) { r.could_not_read = unreadable; r.note = 'Could not read ' + unreadable.map((k) => k === 'nmi' ? 'NMI' : k.replace(/_/g, ' ')).join(', ') + ' from this document, so I have left ' + (unreadable.length === 1 ? 'it' : 'them') + ' blank rather than guess.'; }
    return r;
  }
});

// ---------- DNSP browser tasks: pre-approval and commissioning (filled in by Claude in Chrome) ----------
tool({
  name: 'dnsp_task_pack', group: 'pylon',
  description: 'Prepare a DNSP portal task for a Pylon project, ready for Will to hand to Claude in Chrome: task "preapproval" (solar/battery pre-approval application) or "commissioning" (notify the distributor the system is installed and the inverter is commissioned). Pulls the customer, site, NMI, meter, retailer, phases and system (signed design, else primary) from Pylon, lists anything missing, and returns the Chrome instruction plus the distributor portal link. Before calling it, gather the details yourself: find the customer\'s power bill (in Drive: Active Jobs › customer › Quote & bill for a signed job, else their Customer Quotes folder; or an email from them) and read it with read_document kind "bill" for NMI, meter number, retailer and distributor; for commissioning also find the CES (in Drive: Active Jobs › customer › CES & compliance, or email) and read it with kind "ces" for the CES number, completion date and serial numbers. Pass everything you found as the inputs below, plus anything Will tells you. Only ask Will for what you could not find. The dashboard shows Copy and Open portal buttons, so just summarise and flag what is still missing.',
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
const WALLPAPER_SIZES = ['phone', 'phone_1080', 'desktop', 'desktop_4k'];
tool({
  name: 'brand_wallpaper', group: 'core',
  description: 'Make an Eltra Energy branded wallpaper (blue background, white logo, optional short tagline) in one or more sizes: phone = 1170×2532 (iPhone), phone_1080 = 1080×1920 (Android/older phones), desktop = 1920×1080, desktop_4k = 3840×2160. The logo and tagline are kept clear of the clock at the top and the dock/lock screen buttons at the bottom. The dashboard shows a preview card with a Save button for each size. Leave sizes out to make all four.',
  input_schema: { type: 'object', properties: {
    sizes: { type: 'array', items: { type: 'string', enum: WALLPAPER_SIZES }, description: 'which sizes to make; default all four' },
    tagline: { type: 'string', description: 'optional short line under the logo (a few words, under 60 characters)' }
  } },
  async run({ sizes, tagline }) {
    const s = [...new Set((Array.isArray(sizes) ? sizes : []).filter((x) => WALLPAPER_SIZES.includes(x)))];
    return { wallpaper: { sizes: s.length ? s : WALLPAPER_SIZES, tagline: String(tagline || '').replace(/\s+/g, ' ').trim().slice(0, 60) }, note: 'The dashboard shows the wallpaper with a Save button for each size. Tell them it is ready.' };
  }
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
  description: 'Post to the Eltra Energy Instagram: one photo or a carousel of 2-10 images, with the caption. image_urls must be public JPEG links: use the "saved for posting" links on photos Ethan attached, or the slide links sent from a carousel card\'s "Post to Instagram" button. For a photo slot in the content schedule, use the attached photo\'s "saved for posting" link with that slot\'s caption (from content_schedule) and set content_id to the slot\'s id so it is marked posted. Run the caption through instagram_humanize (is_caption) first. Will or Ethan approves before it goes live.',
  input_schema: { type: 'object', properties: { image_urls: { type: 'array', items: { type: 'string' } }, caption: { type: 'string' }, content_id: { type: 'string', description: 'the content schedule post id, when this posts a scheduled photo slot' } }, required: ['image_urls', 'caption'] },
  async describe(i) { const n = (i.image_urls || []).length; return { title: 'Post to Instagram' + (n > 1 ? ' (carousel, ' + n + ' slides)' : ''), lines: [String(i.caption || '').slice(0, 400) + (String(i.caption || '').length > 400 ? '…' : '')] }; },
  async run(i) {
    const r = await publishPost({ image_urls: i.image_urls, caption: i.caption });
    if (r && r.posted && i.content_id) await markPosted(i.content_id, r.link).catch(() => {});
    return r;
  }
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
  description: 'The Instagram content schedule Eltra keeps filled for the coming week: each slot\'s date, format (photo, carousel, reel, story), topic, status (planned → draft → scheduled/manual → posted; or skipped/failed) and id. own_idea means Will or Ethan added that post by hand on the dashboard: keep to their idea. Deleted posts are not listed. Drafts need Will or Ethan to approve them in the Content schedule panel on the dashboard before anything is posted.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    const d = await loadContent(), cut = Date.now() - 7 * 864e5;
    return { settings: d.settings, what_works: d.learnings && d.learnings.text, items: d.items.filter((x) => Date.parse(x.at || x.createdAt) > cut).map((x) => ({ id: x.id, date: x.date, format: x.format, topic: x.topic, status: x.status, own_idea: x.own ? true : undefined, caption: x.caption ? (x.format === 'photo' ? x.caption : x.caption.slice(0, 300)) : undefined, photo: x.photo, link: x.link, error: x.error })) };
  }
});
tool({
  name: 'content_edit', group: 'core',
  description: 'Change a post in the content schedule: move it (date YYYY-MM-DD), change its topic or angle, change its format (photo = a single photo post, carousel, reel or story; the post is then redrafted in the new format within about 10 minutes, and feedback can go with it), edit the caption, skip it, send it back to be redrafted with feedback (action "redraft" plus feedback), or delete it. Use "delete" (not "skip") whenever Will or Ethan asks to remove, delete or clear a post: it takes the slot out of the schedule for good and the automatic fill won\'t put that date or topic back. Action "clear_skipped" (no id needed) deletes every skipped post in one go; offer it when skipped posts are cluttering the schedule. Approving still happens on the dashboard.',
  input_schema: { type: 'object', properties: { id: { type: 'string', description: 'the post id from content_schedule (not needed for clear_skipped)' }, action: { type: 'string', enum: ['edit', 'redraft', 'skip', 'delete', 'clear_skipped'] }, format: { type: 'string', enum: ['photo', 'carousel', 'reel', 'story'] }, date: { type: 'string' }, topic: { type: 'string' }, angle: { type: 'string' }, caption: { type: 'string' }, feedback: { type: 'string' } } },
  async run(i) {
    if (i.action === 'clear_skipped') { const gone = await deleteItems({ skipped: true }); return { deleted: gone.map((x) => ({ date: x.date, topic: x.topic })), note: gone.length ? undefined : 'There were no skipped posts to clear.' }; }
    if (!i.id) throw new Error('Which post? Give its id from content_schedule');
    if (i.action === 'delete') { const [x] = await deleteItems({ id: i.id }); return { deleted: { id: x.id, date: x.date, topic: x.topic }, note: x.status === 'posted' ? 'Removed from the schedule only; the post is still on Instagram.' : 'Removed from the schedule. Eltra won\'t plan another post for that date.' }; }
    const it = await updateItem(i.id, { ...i, action: i.action === 'edit' ? undefined : i.action }); return { updated: { id: it.id, date: it.date, format: it.format, topic: it.topic, status: it.status }, note: i.action === 'redraft' || (i.format && it.status === 'planned') ? 'Eltra will redraft it' + (i.format ? ' as a ' + it.format : '') + ' within about 10 minutes.' : undefined };
  }
});

// ---------- Improving Eltra (proposals need approval) ----------
tool({
  name: 'suggest_improvement', group: 'core',
  description: 'Propose an improvement to yourself (Eltra) for Will or Ethan to approve on the dashboard. Use it when you were asked for something you can\'t do, when a tool keeps failing, or when you notice a better way of working. kind "behaviour": a change to how you work, written as one clear instruction to yourself in change; it goes live when approved. kind "feature": needs new code or a new connection, in Eltra or in the quote app (set app); put a short build brief in change. Approving a feature has Claude build it on GitHub, Will tries the preview, then makes it live. Don\'t propose things already possible. Call improvements_list first so you don\'t propose something already waiting, building or live.',
  input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['behaviour', 'feature'] }, app: { type: 'string', enum: ['eltra', 'quote'], description: 'for a feature: which app the code change is for (Eltra herself, or the on-site quote app)' }, title: { type: 'string' }, why: { type: 'string' }, change: { type: 'string' } }, required: ['kind', 'title', 'why', 'change'] },
  async run(i) { const it = await addProposal({ ...i, target: i.app }, 'chat'); return { proposed: { id: it.id, title: it.title, kind: it.kind }, note: 'It\'s waiting for approval in the Improvements panel on the dashboard.' }; }
});
// what's in the Improvements panel and where each proposal is up to (read only)
const IMP_STATUS = { proposed: 'waiting for approval', approved: 'approved, waiting to be built', building: 'building', built: 'built and ready to test', live: 'live', undone: 'undone', failed: 'failed' };
const APP_NAME = { eltra: 'Eltra', quote: 'Quote app' };
tool({
  name: 'improvements_list', group: 'core',
  description: 'Read only. Everything in the Improvements panel on the dashboard: each proposal\'s id, title, kind (behaviour, feature, or an uploaded update), app (Eltra or the quote app), status (waiting for approval, approved, building, built and ready to test, live, undone, discarded or failed), any error (such as a merge conflict or a failed preview build), what it changes, links, and when it was created and last changed. Use it to answer "what\'s in the improvements panel?", and always before suggest_improvement so you don\'t propose something already waiting, building or live. If two open proposals touch the same area (same files, panel or tool), warn Will and say which order to make them live in (usually the one built first, then retry the other). If one has a merge conflict, say so plainly and offer to send it again as a fresh proposal with suggest_improvement (give it a slightly different title, since the same title just finds the old one) and suggest discarding the old one in the panel.',
  input_schema: { type: 'object', properties: { include_old: { type: 'boolean', description: 'also include proposals discarded more than 7 days ago (hidden from the panel)' } } },
  async run({ include_old } = {}) {
    const d = await refreshBuilds().catch(() => loadImprove());
    const when = (t) => (t ? melbDate(t) : undefined);
    const items = d.items.filter((x) => include_old || x.status !== 'rejected' || Date.now() - Date.parse(x.decidedAt || 0) < 7 * 864e5).map((x) => {
      const b = x.build || {};
      const times = [x.createdAt, x.decidedAt, b.startedAt, b.liveAt, b.undoneAt, b.errorAt].filter(Boolean).sort();
      const open = !['live', 'undone'].includes(x.status);
      const conflict = open && (!!b.conflict || /not mergeable|conflict/i.test(b.lastError || ''));
      const error = conflict ? 'Merge conflict: this change clashes with code that went live after it was built, so it can\'t be made live as it is.' + (b.lastError ? ' (' + clip(b.lastError, 200) + ')' : '')
        : open && (x.status === 'failed' || b.status === 'failed' || b.lastError) ? clip(b.error || b.lastError || 'unknown problem', 300) : undefined;
      return {
        id: x.id, title: x.title, kind: x.kind, app: x.kind === 'behaviour' ? 'Eltra (how she works)' : APP_NAME[x.target || 'eltra'] || x.target,
        status: x.status === 'rejected' ? (b.status === 'discarded' ? 'discarded' : 'declined') : IMP_STATUS[x.status] || x.status,
        error, merge_conflict: conflict || undefined,
        why: clip(x.why, 300) || undefined, change: clip(x.change, 500) || undefined,
        source: x.source, decided_by: x.decidedBy || undefined,
        created: when(x.createdAt), last_changed: when(times[times.length - 1]),
        issue: b.issueUrl || undefined, pull_request: b.prUrl || undefined, preview: b.status === 'built' ? b.previewUrl || undefined : undefined
      };
    });
    return { count: items.length, items, note: items.length ? undefined : 'The Improvements panel is empty.' };
  }
});


// ---------- Signed jobs and install dates ----------
// where the customer's Drive folder is up to (see jobfolders.mjs). `where` is its place in Drive right now, when Drive
// could be checked; otherwise Eltra's own record is used.
const folderStatus = (x, where) => {
  const err = x.folderError ? 'Drive problem: ' + x.folderError + ' ' : '';
  if (where) return err + 'in ' + where + (where === 'Active Jobs' ? ', moves to Completed Jobs when the DNSP commissioning to-do is ticked' : '');
  return x.folderError ? 'Drive problem: ' + x.folderError + (x.folderId ? (x.folderDone ? ' (folder is in Completed Jobs)' : ' (folder is in Active Jobs)') : '')
    : x.folderDone ? 'in Completed Jobs' : x.folderId ? 'in Active Jobs' + (x.commTodoId ? ', moves to Completed Jobs when the commissioning to-do is ticked' : '')
    : 'no folder yet (none set up by Eltra and none with this customer’s name in Active Jobs)';
};
tool({
  name: 'jobs_list', group: 'core',
  description: 'Signed jobs Eltra is tracking: customer, kit, install date (and where it came from), and which after-sale reminders have gone out (stock a week before, CES on the day, DNSP commissioning 2 weeks after), plus the link to the customer\'s Drive folder and where it is right now in Customer Quotes › Quoted Jobs / Active Jobs / Completed Jobs (it moves to Completed Jobs once the commissioning to-do is ticked). untracked_active_folders lists folders in Active Jobs that no tracked job uses (e.g. jobs signed before Eltra tracked them).',
  input_schema: { type: 'object', properties: {} },
  async run() {
    const d = await loadJobs();
    // check Drive for where each folder is now, and link jobs to folders already in Active Jobs; a Drive problem never stops the list
    let rep = null, drive_note;
    try {
      rep = await jobFolderReport(d);
      if (Object.keys(rep.updates).length) {
        const fresh = await loadJobs();   // reload so a change made meanwhile (e.g. by the automations) isn't lost
        for (const j of fresh.list) {
          const u = rep.updates[j.id];
          if (u && !(u.folderId && j.folderId && j.folderId !== u.folderId)) Object.assign(j, u);
        }
        await saveJobs(fresh);
      }
    } catch (e) { drive_note = 'Couldn’t check Google Drive just now (' + String(e.message || e).slice(0, 150) + '), so folder_status is Eltra’s last record.'; }
    return {
      jobs: d.list.filter((x) => !x.closed).map((x) => ({ customer: x.name, install_date: x.installDate || 'not set', set_by: x.installSource, kit: x.kit, reminders_sent: x.flags, date_check: x.dateCheck ? { proposed_date: x.dateCheck.date, status: x.dateCheck.status } : undefined, folder: x.folderUrl || undefined, folder_status: folderStatus(x, rep && rep.location[x.id]) })),
      untracked_active_folders: rep && rep.untracked.length ? rep.untracked : undefined,
      drive_note,
    };
  }
});
tool({
  name: 'job_install_date', group: 'core',
  description: 'Record or move a job\'s install date. Use it whenever Will or Ethan says when an install is, books one, or moves one ("Sarah\'s install is Tuesday", "move Mark to the 3rd"). The stock order (a week before), CES (on the day) and DNSP commissioning (2 weeks after) reminders run from this date. date: YYYY-MM-DD.',
  input_schema: { type: 'object', properties: { customer: { type: 'string' }, date: { type: 'string' } }, required: ['customer', 'date'] },
  async run({ customer, date }) {
    const day = parseDay(date); if (!day) throw new Error('Give the date as YYYY-MM-DD');
    const d = await loadJobs(), j = setInstall(d, customer, day, 'eltra');
    await syncPreApprovals(d).catch((e) => console.log('DNSP pre-approval due date', e.message));   // due 7 days before the install
    await saveJobs(d);
    return { saved: { customer: j.name, install_date: j.installDate, previous: j.previousDate }, note: j.unsigned ? 'No signed job by that name yet; the date is saved and the reminders will still run.' : undefined };
  }
});

// ---------- Install date availability check (ask the customer by email and text before the date is confirmed) ----------
const CHECK_FIELDS = { customer: { type: 'string', description: 'customer name as on the job' }, date: { type: 'string', description: 'proposed install date, YYYY-MM-DD' }, project_id: { type: 'string', description: 'Pylon project id, from install_date_check' } };
const HOLD_LINE = (i) => 'Puts an all-day "HOLD – Install – ' + i.customer + ' (awaiting confirmation)" on your calendar for ' + (parseDay(i.date) || i.date) + ' (once, no invites). It becomes "Install – ' + i.customer + '" when they confirm and comes off if they can’t.';
const checkDay = (date) => { const day = parseDay(date); if (!day) throw new Error('Give the date as YYYY-MM-DD'); return day; };
tool({
  name: 'install_date_check', group: 'core',
  description: 'Step 1 of asking a customer whether a proposed install date suits them (for example "book Sarah in for Tuesday 8 December"). Looks up the customer\'s name, email, mobile and address in Pylon and the job, and returns a ready-made email and text, plus anything already on that day in the calendar or Eltra’s jobs (clashes, including other install HOLDs). If clash_warning is set, tell them and check they still want that day first. Then, in ONE step, call install_check_send_email (and install_check_send_sms if texts are set up and there is a mobile) so each shows its own Approve card. Use the drafts as they are unless asked to change them. Do not record the date with job_install_date yet: Eltra watches for the reply, records the date when the customer confirms, and flags declines and no-replies to Ethan.',
  input_schema: { type: 'object', properties: CHECK_FIELDS, required: ['customer', 'date'] },
  async run({ customer, date, project_id }) {
    const day = checkDay(date);
    const { draftMessages, checkOut, fmtDay } = await import('./install-check.mjs');
    const d = await loadJobs(), job = findJob(d, customer, project_id);
    let proj = null, note = [];
    if (pylonReady()) {
      const id = project_id || (job && job.projectId);
      if (id) proj = pylonProject((await pylon('/solar_projects/' + encodeURIComponent(id))).data);
      else {
        const found = (await toolByName('pylon_find_projects').run({ search: customer })).projects || [];
        proj = found.find((p) => p.signed) || found.find((p) => p.sold) || found[0] || null;
        if (found.length > 1) note.push('Several Pylon projects matched; using ' + (proj.customer && proj.customer.name) + ' (' + proj.reference + '). Check it is the right customer.');
      }
    } else note.push('Pylon isn’t connected, so ask for the customer’s email and mobile.');
    const cust = (proj && proj.customer) || {}, name = cust.name || (job && job.name) || customer;
    if (proj && !proj.sold) note.push('This Pylon project isn’t signed yet.');
    const mobile = auMobile(cust.phone);
    if (cust.phone && !mobile) note.push('The phone number in Pylon (' + cust.phone + ') isn’t an Australian mobile, so no text can go.');
    if (!cust.email) note.push('No email in Pylon for this customer.');
    if (!smsReady()) note.push('Texts aren’t set up yet (Twilio or GoHighLevel in Netlify), so only send the email.');
    const drafts = draftMessages({ name, day, address: proj && proj.address });
    // anything already on that day: calendar events (including other holds) and other jobs Eltra has booked or held
    const ownHold = job && job.dateCheck && job.dateCheck.hold && job.dateCheck.hold.id;
    const events = await toolByName('calendar_events').run({ from_date: day, days: 1 }).catch((e) => { note.push('Couldn’t check the calendar: ' + e.message); return []; });
    const others = events.filter((e) => e.id !== ownHold), clashRe = /\b(hold|install(ation)?)\b/i;
    const clashes = others.filter((e) => clashRe.test(e.title)).map((e) => ({ title: e.title, when: e.start, hold: /^\s*hold\b/i.test(e.title) }));
    d.list.filter((x) => x !== job && !x.closed && (x.installDate === day || (x.dateCheck && x.dateCheck.date === day && ['asked', 'no reply', 'replied'].includes(x.dateCheck.status))))
      .forEach((x) => { if (!clashes.some((c) => normName(c.title).includes(normName(x.name)))) clashes.push({ title: (x.installDate === day ? 'Install – ' : 'HOLD – Install – ') + x.name + ' (in Eltra’s jobs)', when: day, hold: x.installDate !== day }); });
    return {
      customer: name, project_id: proj && proj.id, address: proj && proj.address, email: cust.email || null, mobile: mobile, mobile_display: mobile ? auMobileLocal(mobile) : null,
      proposed_date: day, proposed_date_words: fmtDay(day), texts_ready: smsReady(), text_sender: smsReady() ? smsSender() : undefined,
      existing_check: job ? checkOut(job.dateCheck) : null, drafts, notes: note.length ? note : undefined,
      clashes: clashes.length ? clashes : undefined,
      clash_warning: clashes.length ? 'Already on ' + fmtDay(day) + ': ' + clashes.map((c) => c.title).join('; ') + '. Warn them about this before sending, and only go ahead if they still want that day.' : undefined,
      other_events_that_day: others.filter((e) => !clashRe.test(e.title)).map((e) => e.title + ' (' + e.start + ')').slice(0, 8)
    };
  }
});
tool({
  name: 'install_check_send_email', group: 'google', action: true,
  description: 'Step 2 (email): send the customer the install date question from the Gmail of the person you are talking to (via gmail_send, with their signature), and track it on the job so Eltra watches for the reply. Use the subject and body from install_date_check. Shows an Approve card.',
  input_schema: { type: 'object', properties: { ...CHECK_FIELDS, to: { type: 'string', description: 'customer email' }, subject: { type: 'string' }, body: { type: 'string', description: 'plain text, ending with a sign-off like "Cheers,"' } }, required: ['customer', 'date', 'to', 'body'] },
  async describe(i) {
    const card = await toolByName('gmail_send').describe({ to: i.to, subject: i.subject, body: i.body });
    return { ...card, title: 'Ask ' + i.customer + ' about their install date (email)', lines: card.lines.concat(['Eltra will watch for their reply and track it on the job.', HOLD_LINE(i)]) };
  },
  async run(i) {
    const day = checkDay(i.date);
    const sent = await toolByName('gmail_send').run({ to: i.to, subject: i.subject, body: i.body });
    const { recordAsked } = await import('./install-check.mjs');
    const check = await recordAsked({ customer: i.customer, projectId: i.project_id, day, via: 'email', detail: { to: i.to, threadId: sent.thread_id, messageId: sent.message_id, user: currentUser() } });
    return { sent: true, to: i.to, check, note: 'Eltra checks for a reply every 30 minutes.' };
  }
});
tool({
  name: 'install_check_send_sms', group: 'sms', action: true,
  description: 'Step 2 (text): send the customer a short text asking whether the proposed install date suits, and track it on the job so Eltra watches for the reply. Use the mobile and text from install_date_check. One Approve card per text.',
  input_schema: { type: 'object', properties: { ...CHECK_FIELDS, to: { type: 'string', description: 'customer mobile' }, message: { type: 'string' }, email: { type: 'string', description: 'customer email, used if a GoHighLevel contact has to be made' } }, required: ['customer', 'date', 'to', 'message'] },
  async describe(i) {
    const ok = auMobile(i.to);
    return { title: 'Ask ' + i.customer + ' about their install date (text)', lines: ['To: ' + (ok ? auMobileLocal(ok) : i.to + ' (not an Australian mobile, so this will fail)'), 'From: ' + smsSender()].concat(smsProvider() === 'ghl' ? ['Uses their GoHighLevel contact (made if they don’t have one).'] : [], ['Eltra will watch for their reply and track it on the job.', HOLD_LINE(i)]), preview: i.message };
  },
  async run(i) {
    const day = checkDay(i.date);
    const sent = await sendSms({ to: i.to, body: i.message, name: i.customer, email: i.email });
    const { recordAsked } = await import('./install-check.mjs');
    const check = await recordAsked({ customer: i.customer, projectId: i.project_id, day, via: 'sms', detail: { provider: sent.provider, to: sent.to, id: sent.id, conversationId: sent.conversationId, contactId: sent.contactId } });
    return { sent: true, to: sent.to, check };
  }
});
tool({
  name: 'install_check_update', group: 'core',
  description: 'Set the answer to an install date check by hand, when Will or Ethan says the customer has answered some other way (rang, told them on site) or the check is no longer needed. outcome confirmed also records the install date (no need to call job_install_date) and renames the calendar hold to "Install – <customer name>"; declined, other_date and cancelled remove the hold (cancelled also releases the date when there has been no reply). other_date: put their suggested day in suggested_date.',
  input_schema: { type: 'object', properties: { customer: { type: 'string' }, outcome: { type: 'string', enum: ['confirmed', 'declined', 'other_date', 'cancelled'] }, suggested_date: { type: 'string' }, note: { type: 'string', description: 'what the customer said, in a few words' } }, required: ['customer', 'outcome'] },
  async run({ customer, outcome, suggested_date, note }) {
    const { settleCheck } = await import('./install-check.mjs');
    return settleCheck({ customer, outcome, suggested: suggested_date ? parseDay(suggested_date) : undefined, note });
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
  return T.filter((t) => t.group === 'google' ? !!process.env.GOOGLE_CLIENT_ID : t.group === 'ghl' ? ghlReady() : t.group === 'sm8' ? sm8Ready() : t.group === 'pylon' ? pylonReady() : t.group === 'instagram' ? igSetUp() : t.group === 'sms' ? smsReady() : true);
}
export const toolByName = (n) => T.find((t) => t.name === n);
