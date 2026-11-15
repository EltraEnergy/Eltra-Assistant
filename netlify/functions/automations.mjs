// Runs the automatic to-dos every 30 minutes (Netlify scheduled function).
import { runAutomations } from '../lib/automations.mjs';
export default async () => {
  try { const r = await runAutomations({ force: true }); console.log('automations', JSON.stringify(r)); } catch (e) { console.log('automations failed', e.message); }
  return new Response('ok');
};
export const config = { schedule: '*/30 * * * *' };
