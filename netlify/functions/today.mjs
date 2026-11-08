// Dashboard data: the next 7 days of calendar, recent email conversations, open leads and booked jobs.
import { json, guard, melbToday, melbToDate } from '../lib/util.mjs';
import { googleStatus, g, CAL } from '../lib/google.mjs';
import { ghlReady, sm8Ready, ghlOpps, sm8Schedule, eventOut, gmailThreads } from '../lib/tools.mjs';

const safe = (p) => p.then((data) => ({ data }), (e) => ({ error: e.message || 'Failed' }));
const MAIL_Q = '-in:sent -in:drafts newer_than:7d -category:promotions -category:social -category:forums';

export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  const gs = await googleStatus().catch(() => ({ setUp: false, connected: false }));
  const out = { status: { google: gs, ghl: ghlReady(), sm8: sm8Ready(), voice: !!process.env.ELEVENLABS_API_KEY }, at: new Date().toISOString() };
  const jobs = [];
  if (gs.connected) {
    const sp = new URLSearchParams({ timeMin: melbToDate(melbToday()).toISOString(), timeMax: melbToDate(melbToday(7)).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '60', timeZone: 'Australia/Melbourne' });
    jobs.push(safe(g(CAL + '/events?' + sp).then((d) => (d.items || []).filter((e) => e.status !== 'cancelled').map(eventOut))).then((r) => { out.calendar = r; }));
    jobs.push(safe(gmailThreads(MAIL_Q, 12)).then((r) => { out.mail = r; }));
  }
  if (ghlReady()) jobs.push(safe(ghlOpps({ status: 'open', limit: 8 })).then((r) => { out.leads = r; }));
  if (sm8Ready()) jobs.push(safe(sm8Schedule(7)).then((r) => { out.jobs = r; }));
  await Promise.all(jobs);
  return json(200, out);
};
