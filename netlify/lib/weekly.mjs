// Monday 7am summary email for Will and for Ethan (each to their own inbox, from their own Gmail).
import { runAs, melbToday, USERS } from './util.mjs';
import { googleStatus, g, GMAIL } from './google.mjs';
import { loadTodos } from './todos.mjs';
import { loadContent } from './content.mjs';
import { loadImprove } from './improve.mjs';

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });

function melbParts() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: +p.hour };
}

export async function buildSummary(user, s) {
  const today = melbToday(0), weekEnd = melbToday(6), weekAgo = Date.now() - 7 * 864e5;
  const t = await loadTodos(), mine = t.items.filter((x) => !x.done && (x.owner === user || x.owner === 'both'));
  const overdue = mine.filter((x) => x.due && x.due < today).sort((a, b) => a.due.localeCompare(b.due));
  const thisWeek = mine.filter((x) => x.due && x.due >= today && x.due <= weekEnd).sort((a, b) => a.due.localeCompare(b.due));
  const c = await loadContent();
  const posted = c.items.filter((x) => x.status === 'posted' && Date.parse(x.postedAt || x.at) > weekAgo);
  const needsOk = c.items.filter((x) => x.status === 'draft'), scheduled = c.items.filter((x) => x.status === 'scheduled');
  const signed = (s.signedLog || []).filter((x) => Date.parse(x.at) > weekAgo);
  const ideas = (await loadImprove()).items.filter((x) => x.status === 'proposed');
  const li = (arr, f) => arr.length ? '<ul>' + arr.map((x) => '<li>' + f(x) + '</li>').join('') + '</ul>' : '<p style="color:#5D6E82">None.</p>';
  const sec = (title, inner) => '<h3 style="margin:18px 0 6px;font-size:16px">' + title + '</h3>' + inner;
  const html = '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#14263D;max-width:560px">' +
    '<p>Morning ' + esc(USERS[user].name) + ', here’s your week from Eltra.</p>' +
    sec('Overdue (' + overdue.length + ')', li(overdue, (x) => esc(x.text) + ' <span style="color:#C2413A">· due ' + fmtDay(x.due) + '</span>')) +
    sec('Due this week (' + thisWeek.length + ')', li(thisWeek, (x) => esc(x.text) + ' <span style="color:#5D6E82">· ' + fmtDay(x.due) + '</span>')) +
    (user === 'will' ? sec('Jobs signed last week (' + signed.length + ')', li(signed, (x) => esc(x.name))) : '') +
    sec('Instagram', '<p>' + posted.length + ' post' + (posted.length === 1 ? '' : 's') + ' went out last week, ' + scheduled.length + ' scheduled, ' + needsOk.length + ' waiting for your OK.</p>' + (posted.length ? li(posted, (x) => x.link ? '<a href="' + esc(x.link) + '">' + esc(x.topic) + '</a>' : esc(x.topic)) : '')) +
    (ideas.length ? sec('Eltra’s improvement ideas', '<p>' + ideas.length + ' waiting for approval on the dashboard.</p>') : '') +
    '<p style="color:#5D6E82;font-size:13px;margin-top:22px">Open Eltra to tick things off: <a href="https://eltra-assistant.netlify.app">eltra-assistant.netlify.app</a></p></div>';
  const text = 'Overdue: ' + overdue.length + '. Due this week: ' + thisWeek.length + '. Instagram: ' + posted.length + ' posted, ' + needsOk.length + ' waiting for your OK.';
  return { subject: 'Your week: ' + overdue.length + ' overdue, ' + thisWeek.length + ' due' + (needsOk.length ? ', ' + needsOk.length + ' post' + (needsOk.length > 1 ? 's' : '') + ' to approve' : ''), html, text };
}

export async function sendTo(email, { subject, html, text }) {
  const bnd = 'eltraw_' + Date.now().toString(36);
  const part = (type, body) => '--' + bnd + '\r\nContent-Type: ' + type + '; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(body).toString('base64').replace(/.{76}/g, '$&\r\n') + '\r\n';
  const raw = 'To: ' + email + '\r\nSubject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="' + bnd + '"\r\n\r\n' + part('text/plain', text) + part('text/html', html) + '--' + bnd + '--';
  return g(GMAIL + '/messages/send', { method: 'POST', body: JSON.stringify({ raw: b64url(raw) }) });
}

// Sends once per week, on Monday from 7am Melbourne time. `s` is the automations state (keeps the "sent" marker).
export async function sendWeeklySummaries(s, { force = false } = {}) {
  const { weekday, hour } = melbParts(), week = melbToday(0);
  if (!force && (weekday !== 'Mon' || hour < 7 || s.summaryWeek === week)) return 0;
  s.summaryWeek = week;
  let sent = 0;
  for (const user of Object.keys(USERS)) {
    await runAs(user, async () => {
      const gs = await googleStatus().catch(() => ({}));
      if (!gs.connected || !gs.email) return;
      await sendTo(gs.email, await buildSummary(user, s)); sent++;
    }).catch(() => {});
  }
  return sent;
}
