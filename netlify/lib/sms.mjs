// Text messages (SMS), kept on their own so install date checks, appointment reminders and the booking automation can
// all share them. Two services are supported; set ONE up in Netlify:
//  • Twilio: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (an Australian number like +61412345678, or a sender
//    name such as EltraEnergy; customers can't reply to a sender name, so use a number if replies matter).
//    TWILIO_MESSAGING_SERVICE_SID can be used instead of TWILIO_FROM.
//  • GoHighLevel conversations: SMS_PROVIDER=ghl, using the GHL_TOKEN and GHL_LOCATION_ID already set for the leads
//    pipeline (the token needs the conversations and contacts scopes). GHL_SMS_FROM picks the sending number if the
//    account has more than one. Texts and replies show in GoHighLevel's Conversations too.
// Sending is always behind an Approve card in the tools that use it; nothing here asks for approval itself.

const provider = () => {
  const p = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  const twilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID));
  const ghl = !!(process.env.GHL_TOKEN && process.env.GHL_LOCATION_ID);
  if (p === 'ghl' || p === 'gohighlevel') return ghl ? 'ghl' : null;
  if (p === 'off') return null;
  return twilio ? 'twilio' : null;
};
export const smsProvider = provider;
export const smsReady = () => !!provider();
// how the sender shows in an Approve card
export const smsSender = () => provider() === 'twilio' ? (process.env.TWILIO_FROM || 'Twilio messaging service') + ' (Twilio)' : provider() === 'ghl' ? (process.env.GHL_SMS_FROM || 'your GoHighLevel number') + ' (GoHighLevel)' : 'not set up';

// Australian mobile in international form (+614XXXXXXXX), or null if it isn't one.
// Accepts 0412 345 678, 412345678, +61 412 345 678, 61412345678, (04) 1234 5678.
export function auMobile(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0061')) d = d.slice(2);
  if (d.startsWith('61')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return /^4\d{8}$/.test(d) ? '+61' + d : null;
}
// 0412 345 678, for showing people
export const auMobileLocal = (raw) => { const m = auMobile(raw); return m ? '0' + m.slice(3, 6) + ' ' + m.slice(6, 9) + ' ' + m.slice(9) : String(raw || ''); };

// ---- Twilio ----
async function twilio(path, opts = {}) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + path, {
    ...opts, headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }
  });
  const text = await res.text(); let d; try { d = JSON.parse(text); } catch { d = text; }
  if (!res.ok) throw new Error('Twilio error ' + res.status + ': ' + String((d && d.message) || text).slice(0, 200));
  return d;
}

// ---- GoHighLevel (uses the same request helper as the leads tools) ----
const ghlCall = async (path, opts) => (await import('./tools.mjs')).ghl(path, opts);
async function ghlContact(to, name, email) {
  const loc = process.env.GHL_LOCATION_ID;
  const dupe = await ghlCall('/contacts/search/duplicate?locationId=' + encodeURIComponent(loc) + '&number=' + encodeURIComponent(to)).catch(() => null);
  if (dupe && dupe.contact && dupe.contact.id) return dupe.contact.id;
  const body = { locationId: loc, phone: to, name: name || undefined, email: email || undefined, source: 'Eltra' };
  const c = await ghlCall('/contacts/', { method: 'POST', body: JSON.stringify(body) });
  const id = (c.contact && c.contact.id) || c.id;
  if (!id) throw new Error('GoHighLevel didn’t return a contact for ' + to);
  return id;
}

// Send one text. Returns { sent, provider, to, id, conversationId?, contactId? }.
// name/email are only used to find or create the GoHighLevel contact.
export async function sendSms({ to, body, name, email }) {
  const p = provider(); if (!p) throw new Error('Text messages aren’t set up yet (add Twilio or GoHighLevel details in Netlify).');
  const num = auMobile(to); if (!num) throw new Error('“' + to + '” isn’t an Australian mobile number.');
  const text = String(body || '').trim(); if (!text) throw new Error('The text message is empty.');
  if (p === 'twilio') {
    const f = new URLSearchParams({ To: num, Body: text });
    if (process.env.TWILIO_MESSAGING_SERVICE_SID) f.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID); else f.set('From', process.env.TWILIO_FROM);
    const m = await twilio('/Messages.json', { method: 'POST', body: f.toString() });
    return { sent: true, provider: p, to: num, id: m.sid };
  }
  const contactId = await ghlContact(num, name, email);
  const r = await ghlCall('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message: text, ...(process.env.GHL_SMS_FROM ? { fromNumber: process.env.GHL_SMS_FROM } : {}) }) });
  return { sent: true, provider: p, to: num, id: r.messageId || r.id, conversationId: r.conversationId, contactId };
}

// Texts the customer has sent us since a time (oldest first): [{ at, body }].
// sent = what sendSms returned (it tells us where to look).
export async function smsReplies(sent, sinceIso) {
  const p = sent && sent.provider, since = Date.parse(sinceIso || 0) || 0;
  if (!p || p !== provider()) return [];
  let out = [];
  if (p === 'twilio') {
    const day = new Date(since - 864e5).toISOString().slice(0, 10);
    const d = await twilio('/Messages.json?PageSize=30&From=' + encodeURIComponent(sent.to) + '&DateSent%3E=' + day);
    out = (d.messages || []).filter((m) => m.direction === 'inbound').map((m) => ({ at: new Date(m.date_sent || m.date_created).toISOString(), body: m.body || '' }));
  } else if (sent.conversationId) {
    const d = await ghlCall('/conversations/' + encodeURIComponent(sent.conversationId) + '/messages?limit=30');
    const list = (d.messages && (d.messages.messages || d.messages)) || [];
    out = (Array.isArray(list) ? list : []).filter((m) => m.direction === 'inbound' && (!m.messageType || /sms/i.test(m.messageType)))
      .map((m) => ({ at: new Date(m.dateAdded || m.dateUpdated || 0).toISOString(), body: m.body || '' }));
  }
  return out.filter((m) => Date.parse(m.at) > since && m.body.trim()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
