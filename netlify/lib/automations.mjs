// Automatic to-dos, so nothing slips:
//  • a Pylon proposal gets signed  → pre-approval, stock order, install booking and welcome email to-dos
//  • a proposal has sat unsigned for 3+ days → a follow-up to-do (once per project)
// Runs on a schedule (functions/automations.mjs) and whenever the dashboard loads the to-do list (at most every 15 min).
import { store } from './util.mjs';
import { addTodo } from './todos.mjs';
import { pylon, pylonReady, pylonProject, pylonDesign, DESIGN_FIELDS } from './tools.mjs';

const STATE = 'automations';
const dayPlus = (n) => { const d = new Date(Date.now() + n * 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }); };

// What gets added when a job is signed. Sections must match (or loosely match) your to-do sections.
function signedTasks(name, design) {
  const kit = design ? [design.panels.join('; '), design.inverters.join('; '), design.batteries.join('; ')].filter(Boolean).join(' · ') : '';
  return [
    { section: 'Admin', text: 'Send ' + name + ' the welcome / next steps email', due: dayPlus(0) },
    { section: 'Admin', text: 'Book the install date with ' + name, due: dayPlus(1) },
    { section: 'DNSP', text: 'Lodge the DNSP pre-approval for ' + name, due: dayPlus(1) },
    { section: 'Order stock', text: 'Order stock for ' + name + (kit ? ': ' + kit : ''), due: dayPlus(2) }
  ];
}

export async function runAutomations({ force = false } = {}) {
  if (!pylonReady()) return { skipped: 'Pylon not connected' };
  const s = (await store().get(STATE, { type: 'json' })) || {};
  if (!force && s.lastRun && Date.now() - Date.parse(s.lastRun) < 15 * 60000) return { skipped: 'ran recently' };
  s.signed = s.signed || []; s.followed = s.followed || [];
  const first = !s.lastRun, added = [];

  // newest projects (last ~60) — enough for a small team
  let url = '/solar_projects?sort=created_at.desc&filter[is_archived]=false', projects = [];
  for (let page = 0; url && page < 4; page++) { const d = await pylon(url.replace('https://api.getpylon.com/v1', '')); projects = projects.concat(d.data || []); url = d.links && d.links.next; }

  for (const raw of projects) {
    const p = pylonProject(raw), name = (p.customer && p.customer.name) || p.address || 'customer', attrs = raw.attributes || {};
    if (p.sold && !s.signed.includes(p.id)) {
      s.signed.push(p.id);
      if (first) continue;   // first run: remember what is already signed, don't flood the list with old jobs
      const ds = await pylon('/solar_designs?filter[project]=' + encodeURIComponent(p.id) + '&fields[solar_designs]=' + DESIGN_FIELDS).catch(() => ({ data: [] }));
      const designs = (ds.data || []).map(pylonDesign);
      const design = designs.find((x) => x.id === p.signed_design_id) || designs.find((x) => x.primary) || designs[0];
      for (const t of signedTasks(name, design)) added.push(await addTodo({ ...t, ref: name + ' · auto' }));
    }
    const age = (Date.now() - Date.parse(attrs.created_at || 0)) / 864e5;
    if (!p.sold && attrs.is_committed && p.primary_design_id && age >= 3 && age <= 21 && !s.followed.includes(p.id)) {
      s.followed.push(p.id);
      added.push(await addTodo({ section: 'Quoting', text: 'Follow up ' + name + '’s proposal (sent ' + Math.round(age) + ' days ago, not signed yet)', due: dayPlus(0), ref: name + ' · auto' }));
    }
  }
  s.signed = s.signed.slice(-500); s.followed = s.followed.slice(-500); s.lastRun = new Date().toISOString();
  await store().setJSON(STATE, s);
  return { added: added.length, first };
}
