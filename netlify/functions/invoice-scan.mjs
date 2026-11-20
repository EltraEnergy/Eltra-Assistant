// Daily invoice scan of Ethan's and Will's inboxes (read-only) into Ethan's Accounts to-dos.
// Netlify schedules are in UTC: 18:00–22:00 UTC covers 5–9am Melbourne in both summer and winter time.
// The scan itself only runs once a Melbourne day, from 5am; the later firings finish or retry a run that was cut short.
import { runInvoiceScan } from '../lib/invoices.mjs';
export default async () => {
  try { const r = await runInvoiceScan(); console.log('invoice scan', JSON.stringify(r)); } catch (e) { console.log('invoice scan failed', e.message); }
  return new Response('ok');
};
export const config = { schedule: '0 18-22 * * *' };
