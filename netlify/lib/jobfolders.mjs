// Customer folders in Will's Google Drive follow the job. Everything lives inside "Customer Quotes":
//   Customer Quotes › Quoted Jobs     – quotes (named "2026-11-10 Sarah Nguyen – 14 Grevillea Cres"); older ones may still sit loose in Customer Quotes
//   Customer Quotes › Active Jobs     – signed jobs, each with Quote & bill, DNSP, CES & compliance, Photos and Invoices
//   Customer Quotes › Completed Jobs  – finished jobs (DNSP commissioning to-do ticked)
//  • signed: the customer's folder (already in Active Jobs, else the newest in Quoted Jobs or loose in Customer Quotes) moves
//    into Active Jobs (or a new "<name> – <address>" folder is made there); missing subfolders are added and loose files go
//    into Quote & bill
//  • finished: the folder moves into Completed Jobs
// The three folders are found by their ids (or by name inside Customer Quotes), then remembered in Netlify Blobs. Eltra
// never makes its own Active Jobs or Completed Jobs. Drive calls use the signed-in Google account (automations run as Will).
import { store } from './util.mjs';
import { g, DRIVE } from './google.mjs';
import { normName } from './jobs.mjs';

const KEY = 'jobfolders:v2';   // v2: the folders inside Customer Quotes (v1 looked beside it)
const FOLDER = 'application/vnd.google-apps.folder';
export const SUBFOLDERS = ['Quote & bill', 'DNSP', 'CES & compliance', 'Photos', 'Invoices'];
const env = (k, d) => String(process.env[k] || '').trim() || d;
const quotesId = () => env('QUOTES_FOLDER_ID', '1yRS0IDyBgfe_TVnE1V7wKnT8oapZPKyw');
const ROOTS = {
  quoted: { name: 'Quoted Jobs', id: () => env('QUOTED_JOBS_FOLDER_ID', '1DJbLBgjEweY_-xpPrLWqEoCCu2yVlX8D') },
  active: { name: 'Active Jobs', id: () => env('ACTIVE_JOBS_FOLDER_ID', '1d0rJPuDDkewSQRbziI1l7-nf1yhrVyx6') },
  completed: { name: 'Completed Jobs', id: () => env('COMPLETED_JOBS_FOLDER_ID', '1Yre7ebCvohiyzquQHolFGf6KapcLjeTQ') },
};
const ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const folderUrl = (id) => 'https://drive.google.com/drive/folders/' + id;

// the non-trashed items in a folder (folders only if foldersOnly)
async function children(parent, foldersOnly = false, order = '') {
  const out = []; let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const q = "'" + esc(parent) + "' in parents and trashed = false" + (foldersOnly ? " and mimeType = '" + FOLDER + "'" : '');
    const qs = new URLSearchParams({ q, pageSize: '200', fields: 'nextPageToken,files(id,name,mimeType,createdTime,parents)' });
    if (order) qs.set('orderBy', order);
    if (pageToken) qs.set('pageToken', pageToken);
    const r = await g(DRIVE + '/files?' + qs + '&' + ALL);
    out.push(...(r.files || []));
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}
async function createFolder(name, parent) {
  return g(DRIVE + '/files?supportsAllDrives=true&fields=id,name', { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) });
}
async function findOrCreate(name, parent, list) {
  const have = (list || (await children(parent, true))).find((f) => f.mimeType === FOLDER && f.name.trim().toLowerCase() === name.toLowerCase());
  return have || createFolder(name, parent);
}
async function move(id, to, from) {
  const qs = new URLSearchParams({ addParents: to, supportsAllDrives: 'true', fields: 'id,parents' });
  if (from) qs.set('removeParents', from);
  return g(DRIVE + '/files/' + encodeURIComponent(id) + '?' + qs, { method: 'PATCH', body: '{}' });
}

// does a folder name hold every word of the customer's name?
const wordsOf = (name) => normName(name).split(' ').filter(Boolean);
const matches = (f, words) => words.length > 0 && words.every((w) => (' ' + normName(f.name) + ' ').includes(' ' + w + ' '));
// newest first: by the date the quote app puts at the front of the name, then by when Drive made it
const dateOf = (f) => (String(f.name).match(/^\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
const newestFirst = (a, b) => dateOf(b).localeCompare(dateOf(a)) || String(b.createdTime || '').localeCompare(String(a.createdTime || ''));

// { quotes, quoted, active, completed } – the folders inside Customer Quotes, looked up once, then kept in Blobs.
// Active Jobs and Completed Jobs must already exist: a missing one is an error (saved on the job), never a new folder.
export async function jobFolderRoots() {
  const quotes = quotesId();
  const saved = await store().get(KEY, { type: 'json' }).catch(() => null);
  if (saved && saved.quotes === quotes && saved.active && saved.completed
    && Object.keys(ROOTS).every((k) => saved['want_' + k] === ROOTS[k].id())) return saved;
  const list = await children(quotes, true);
  const roots = { quotes, at: new Date().toISOString() };
  for (const [k, r] of Object.entries(ROOTS)) {
    const want = r.id();
    // the known id inside Customer Quotes, else a folder with the right name there, else the known id wherever it is
    let f = list.find((x) => x.id === want) || list.find((x) => x.name.trim().toLowerCase() === r.name.toLowerCase());
    if (!f && want) {
      try { const x = await g(DRIVE + '/files/' + encodeURIComponent(want) + '?fields=id,name,mimeType,trashed&supportsAllDrives=true'); if (x && !x.trashed && x.mimeType === FOLDER) f = x; }
      catch { /* not there */ }
    }
    if (!f && k !== 'quoted') throw new Error('Couldn’t find "' + r.name + '" inside Customer Quotes, so the folder wasn’t moved (Eltra won’t make a second one)');
    roots[k] = f ? f.id : null;
    roots['want_' + k] = want;
  }
  await store().setJSON(KEY, roots);
  return roots;
}

// A newly signed job: move (or make) the customer's folder in Active Jobs and set it up. → { folderId, folderUrl, folderFrom }
export async function jobFolderOnSigning({ name, address }) {
  const roots = await jobFolderRoots();
  const words = wordsOf(name);
  let folder = null, from = 'new';
  if (words.length) {
    // already in Active Jobs (e.g. moved by hand): use it where it is
    const active = (await children(roots.active, true)).filter((f) => matches(f, words)).sort(newestFirst);
    if (active[0]) { folder = active[0]; from = 'Active Jobs'; }
    else {
      // the newest quote folder in Quoted Jobs or loose in Customer Quotes (never the three job folders themselves)
      const skip = new Set([roots.quoted, roots.active, roots.completed].filter(Boolean));
      const [quoted, loose] = await Promise.all([roots.quoted ? children(roots.quoted, true) : [], children(roots.quotes, true)]);
      const hits = quoted.map((f) => ({ ...f, from: 'Quoted Jobs' }))
        .concat(loose.filter((f) => !skip.has(f.id)).map((f) => ({ ...f, from: 'Customer Quotes' })))
        .filter((f) => matches(f, words)).sort(newestFirst);
      if (hits[0]) {
        folder = hits[0]; from = folder.from;
        await move(folder.id, roots.active, (folder.parents || []).join(',') || null);
      }
    }
  }
  if (!folder) folder = await createFolder(String(name || 'Customer').trim() + (address ? ' – ' + String(address).trim() : ''), roots.active);
  // subfolders (only the missing ones), then loose files into Quote & bill
  const inside = await children(folder.id);
  const subs = {};
  for (const n of SUBFOLDERS) subs[n] = await findOrCreate(n, folder.id, inside);
  const loose = inside.filter((f) => f.mimeType !== FOLDER);
  for (const f of loose.slice(0, 40)) await move(f.id, subs['Quote & bill'].id, folder.id);
  return { folderId: folder.id, folderUrl: folderUrl(folder.id), folderFrom: from, looseMoved: Math.min(loose.length, 40) };
}

// A finished job: move its folder from Active Jobs (or wherever it is now) into Completed Jobs.
export async function jobFolderDone(folderId) {
  const roots = await jobFolderRoots();
  const f = await g(DRIVE + '/files/' + encodeURIComponent(folderId) + '?fields=id,parents,trashed&supportsAllDrives=true');
  const parents = f.parents || [];
  if (parents.includes(roots.completed)) return true;
  await move(folderId, roots.completed, parents.join(','));
  return true;
}

// Where each open job's folder is now, read from Drive. Also links jobs that have no folder yet to a matching folder
// already in Active Jobs (or Completed Jobs) – e.g. the ones moved there by hand – and marks a folder that has been put
// in Completed Jobs as done. Changes the job records in d (the caller saves them). Nothing in Drive is changed.
// → { location: { jobId: 'Active Jobs' | … }, untracked: [{ name, link }] (Active Jobs folders no job is using), updates }
export async function jobFolderReport(d) {
  const roots = await jobFolderRoots();
  const [active, completed, quoted, loose] = await Promise.all([
    children(roots.active, true), children(roots.completed, true), roots.quoted ? children(roots.quoted, true) : [], children(roots.quotes, true),
  ]);
  const label = { [roots.quotes]: 'Customer Quotes', [roots.active]: 'Active Jobs', [roots.completed]: 'Completed Jobs' };
  if (roots.quoted) label[roots.quoted] = 'Quoted Jobs';
  const where = new Map();
  for (const [list, w] of [[active, 'Active Jobs'], [completed, 'Completed Jobs'], [quoted, 'Quoted Jobs'], [loose, 'Customer Quotes']]) for (const f of list) where.set(f.id, w);
  const open = d.list.filter((j) => !j.closed);
  const taken = new Set(d.list.map((j) => j.folderId).filter(Boolean));
  const updates = {}, now = new Date().toISOString();
  const note = (j, fields) => { Object.assign(j, fields); updates[j.id] = { ...(updates[j.id] || {}), ...fields }; };
  // jobs with no folder yet: link one already in Active Jobs (else Completed Jobs) by the customer's name
  for (const j of open) {
    if (j.folderId) continue;
    const words = wordsOf(j.name); if (!words.length) continue;
    const pick = (list) => list.filter((f) => !taken.has(f.id) && matches(f, words)).sort(newestFirst)[0];
    const a = pick(active), c = a ? null : pick(completed), f = a || c;
    if (!f) continue;
    taken.add(f.id);
    note(j, { folderId: f.id, folderUrl: folderUrl(f.id), folderFrom: 'found in ' + (a ? 'Active Jobs' : 'Completed Jobs'), ...(c ? { folderDone: now } : {}) });
  }
  // where each job's folder is now (a folder outside the four lists is looked up on its own, a few at most)
  const location = {}; let lookups = 0;
  for (const j of open) {
    if (!j.folderId) continue;
    let w = where.get(j.folderId);
    if (!w && lookups++ < 8) {
      try {
        const f = await g(DRIVE + '/files/' + encodeURIComponent(j.folderId) + '?fields=id,parents,trashed&supportsAllDrives=true');
        w = f.trashed ? 'the Drive bin' : label[(f.parents || []).find((p) => label[p])] || 'another Drive folder';
      } catch { w = 'nowhere (folder not found in Drive)'; }
    }
    if (!w) continue;
    location[j.id] = w;
    if (w === 'Completed Jobs' && !j.folderDone) note(j, { folderDone: now });   // moved there by hand
  }
  const untracked = active.filter((f) => !taken.has(f.id)).sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ name: f.name, link: folderUrl(f.id) }));
  return { location, untracked, updates };
}
