// Customer folders in Will's Google Drive follow the job:
//  • quotes: the quote app saves each quote in "Customer Quotes" (named "2026-11-10 Sarah Nguyen – 14 Grevillea Cres")
//  • signed: the customer's newest quote folder moves into "Active Jobs" (or a new "<name> – <address>" folder is made there),
//    with the subfolders Quote & bill, DNSP, CES & compliance, Photos and Invoices; loose files go into Quote & bill
//  • finished (DNSP commissioning to-do ticked): the folder moves into "Completed Jobs"
// "Active Jobs" and "Completed Jobs" sit beside "Customer Quotes" (same parent) and are found or made once, then
// remembered in Netlify Blobs. Drive calls use Will's Google account (automations run as Will).
import { store } from './util.mjs';
import { g, DRIVE } from './google.mjs';
import { normName } from './jobs.mjs';

const KEY = 'jobfolders';
const FOLDER = 'application/vnd.google-apps.folder';
export const SUBFOLDERS = ['Quote & bill', 'DNSP', 'CES & compliance', 'Photos', 'Invoices'];
const quotesId = () => String(process.env.QUOTES_FOLDER_ID || '').trim() || '1yRS0IDyBgfe_TVnE1V7wKnT8oapZPKyw';
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

// { quotes, parent, active, completed } – looked up once, then kept in Blobs
export async function jobFolderRoots() {
  const quotes = quotesId();
  const saved = await store().get(KEY, { type: 'json' }).catch(() => null);
  if (saved && saved.quotes === quotes && saved.active && saved.completed) return saved;
  const q = await g(DRIVE + '/files/' + encodeURIComponent(quotes) + '?fields=id,parents&supportsAllDrives=true');
  const parent = (q.parents || [])[0];
  if (!parent) throw new Error('Couldn’t find the folder that holds Customer Quotes');
  const list = await children(parent, true);
  const active = await findOrCreate('Active Jobs', parent, list);
  const completed = await findOrCreate('Completed Jobs', parent, list);
  const roots = { quotes, parent, active: active.id, completed: completed.id, at: new Date().toISOString() };
  await store().setJSON(KEY, roots);
  return roots;
}

// A newly signed job: move (or make) the customer's folder in Active Jobs and set it up. → { folderId, folderUrl }
export async function jobFolderOnSigning({ name, address }) {
  const roots = await jobFolderRoots();
  const words = normName(name).split(' ').filter(Boolean);
  let folder = null;
  if (words.length) {
    // newest first: by the date the quote app puts at the front of the name, then by when Drive made it
    const quotes = (await children(roots.quotes, true, 'createdTime desc'))
      .filter((f) => { const have = ' ' + normName(f.name) + ' '; return words.every((w) => have.includes(' ' + w + ' ')); });
    const dateOf = (f) => (String(f.name).match(/^\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    quotes.sort((a, b) => (dateOf(b) || '').localeCompare(dateOf(a) || '') || String(b.createdTime || '').localeCompare(String(a.createdTime || '')));
    folder = quotes[0] || null;
  }
  const moved = !!folder;
  if (folder) await move(folder.id, roots.active, roots.quotes);
  else folder = await createFolder(String(name || 'Customer').trim() + (address ? ' – ' + String(address).trim() : ''), roots.active);
  // subfolders (only the missing ones), then loose files into Quote & bill
  const inside = await children(folder.id);
  const subs = {};
  for (const n of SUBFOLDERS) subs[n] = await findOrCreate(n, folder.id, inside);
  const loose = inside.filter((f) => f.mimeType !== FOLDER);
  for (const f of loose.slice(0, 40)) await move(f.id, subs['Quote & bill'].id, folder.id);
  return { folderId: folder.id, folderUrl: folderUrl(folder.id), folderFrom: moved ? 'Customer Quotes' : 'new', looseMoved: Math.min(loose.length, 40) };
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
