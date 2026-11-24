// Customer folders in Google Drive (Will's account):
//   Customer Quotes  – every quote the quote app saves (found by its ID, so renaming or moving it is fine)
//   Active Jobs      – when a job is signed in Pylon, the customer's quote folder moves here and gets subfolders:
//                      Quote & bill (the quote and bill move in), DNSP, CES & compliance, Photos, Invoices
//   Completed Jobs   – when the DNSP commissioning to-do is ticked off, the folder moves here
// Active Jobs and Completed Jobs are created next to Customer Quotes the first time they're needed.
import { store } from './util.mjs';
import { g, DRIVE } from './google.mjs';

const QUOTES_ID = () => process.env.QUOTES_FOLDER_ID || '1yRS0IDyBgfe_TVnE1V7wKnT8oapZPKyw';
const FOLDER = 'application/vnd.google-apps.folder';
export const SUBFOLDERS = ['Quote & bill', 'DNSP', 'CES & compliance', 'Photos', 'Invoices'];
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const list = (query, fields = 'files(id,name,modifiedTime,mimeType,webViewLink)') => g(DRIVE + '/files?' + new URLSearchParams({ q: query + ' and trashed = false', fields, pageSize: '100', orderBy: 'modifiedTime desc', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })).then((d) => d.files || []);
async function childFolder(parent, name) {
  const found = await list("'" + parent + "' in parents and mimeType = '" + FOLDER + "' and name = '" + q(name) + "'");
  if (found[0]) return found[0];
  return g(DRIVE + '/files?supportsAllDrives=true&fields=id,name,webViewLink', { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) });
}
const move = (id, to, from) => g(DRIVE + '/files/' + id + '?' + new URLSearchParams({ addParents: to, removeParents: from, supportsAllDrives: 'true', fields: 'id,parents' }), { method: 'PATCH', body: JSON.stringify({}) });

// the Active Jobs and Completed Jobs folders, next to Customer Quotes (remembered once found or made)
export async function jobFolders() {
  const saved = (await store().get('job-folders', { type: 'json' }).catch(() => null)) || {};
  if (saved.active && saved.completed && saved.quotes === QUOTES_ID()) return saved;
  const qf = await g(DRIVE + '/files/' + QUOTES_ID() + '?supportsAllDrives=true&fields=id,parents');
  const parent = (qf.parents || [])[0];
  if (!parent) throw new Error('Can’t find where the Customer Quotes folder lives in Drive');
  const out = { quotes: QUOTES_ID(), parent, active: (await childFolder(parent, 'Active Jobs')).id, completed: (await childFolder(parent, 'Completed Jobs')).id };
  await store().setJSON('job-folders', out);
  return out;
}

// a job was signed: move (or make) the customer's folder in Active Jobs, add subfolders, file the quote and bill
export async function openJobFolder(job, address) {
  const f = await jobFolders(), who = String(job.name || '').trim();
  if (!who) return null;
  // the quote app names folders "YYYY-MM-DD Name – address": newest match for this customer
  const words = who.split(/\s+/).filter((w) => w.length > 1);
  const cands = (await list("'" + f.quotes + "' in parents and mimeType = '" + FOLDER + "' and name contains '" + q(words[words.length - 1] || who) + "'"))
    .filter((x) => words.every((w) => x.name.toLowerCase().includes(w.toLowerCase())));
  let folder;
  if (cands[0]) { folder = cands[0]; await move(folder.id, f.active, f.quotes); }
  else folder = await g(DRIVE + '/files?supportsAllDrives=true&fields=id,name,webViewLink', { method: 'POST', body: JSON.stringify({ name: who + (address ? ' – ' + address : ''), mimeType: FOLDER, parents: [f.active] }) });
  const subs = {};
  for (const name of SUBFOLDERS) subs[name] = (await childFolder(folder.id, name)).id;
  // loose files already in the folder (quote summary, bill, saved quote data) go into "Quote & bill"
  const loose = await list("'" + folder.id + "' in parents and mimeType != '" + FOLDER + "'", 'files(id,name)');
  for (const file of loose) await move(file.id, subs['Quote & bill'], folder.id).catch(() => {});
  return { folderId: folder.id, folderUrl: folder.webViewLink || 'https://drive.google.com/drive/folders/' + folder.id, folderName: folder.name, fromQuote: !!cands[0], olderQuotes: cands.length > 1 ? cands.length - 1 : 0 };
}

// commissioning ticked off: the job's folder moves to Completed Jobs
export async function closeJobFolder(job) {
  if (!job.folderId) return false;
  const f = await jobFolders();
  await move(job.folderId, f.completed, f.active);
  return true;
}
