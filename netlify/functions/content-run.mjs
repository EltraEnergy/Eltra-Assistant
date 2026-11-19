// Runs the content autopilot every 10 minutes: posts what's due, then does one planning/drafting/learning job.
import { runCycle } from '../lib/content.mjs';
export default async () => {
  try { const d = await runCycle(); console.log('content cycle', d.log && d.log[0] && d.log[0].msg); } catch (e) { console.log('content cycle failed', e.message); }
  return new Response('ok');
};
export const config = { schedule: '*/10 * * * *' };
