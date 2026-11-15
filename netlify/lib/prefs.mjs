// Small saved settings shared by the dashboard and Eltra (e.g. links to each distributor's portal).
import { store } from './util.mjs';
export const DNSPS = ['Powercor', 'CitiPower', 'Jemena', 'AusNet Services', 'United Energy'];
export async function loadPrefs() {
  const p = (await store().get('prefs', { type: 'json' })) || {};
  const portals = {}; DNSPS.forEach((n) => { portals[n] = (p.portals && p.portals[n]) || ''; });
  return { portals };
}
export async function savePrefs(b) {
  const cur = await loadPrefs();
  if (b.portals) DNSPS.forEach((n) => { const v = String(b.portals[n] || '').trim(); cur.portals[n] = /^https:\/\/[^\s]+$/.test(v) ? v.slice(0, 300) : ''; });
  await store().setJSON('prefs', cur); return cur;
}
export function portalFor(prefs, name) {
  const n = String(name || '').toLowerCase(); if (!n) return { name: '', url: '' };
  const hit = DNSPS.find((d) => n.includes(d.toLowerCase().split(' ')[0]));
  return hit ? { name: hit, url: prefs.portals[hit] || '' } : { name: name, url: '' };
}
