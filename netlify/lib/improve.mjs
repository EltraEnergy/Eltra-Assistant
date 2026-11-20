// Eltra improving herself, with permission. She notes problems (tool errors) and things she couldn't do or was asked
// for; once a day she turns new notes into proposals. Two kinds:
//   behaviour – a change to how she works (a rule added to her instructions). Goes live the moment someone approves it.
//   feature   – needs new code. Approving it produces a build brief to hand to Claude Code / Claude; it goes live when
//               the code change is reviewed and deployed.
import { store, currentUser } from './util.mjs';
import { claudeJSON } from './claude.mjs';
import crypto from 'node:crypto';
import { startBuild, checkBuild, makeLive, undoBuild, discardBuild, buildReady, guessTarget, isSensitive } from './codebuild.mjs';

const KEY = 'improve';
export async function loadImprove() {
  const d = (await store().get(KEY, { type: 'json' })) || {};
  return { items: d.items || [], log: d.log || [], reviewedAt: d.reviewedAt || null };
}
const save = (d) => store().setJSON(KEY, d);

export async function logIssue(kind, text) {
  try {
    const d = await loadImprove();
    d.log = (d.log || []).concat([{ at: new Date().toISOString(), kind, text: String(text).slice(0, 700), by: currentUser() }]).slice(-80);
    await save(d);
  } catch {}
}
export async function addProposal({ kind, title, why, change, target }, source = 'eltra') {
  const d = await loadImprove(), t = String(title || '').trim().slice(0, 120);
  if (!t) throw new Error('A proposal needs a title');
  const same = d.items.find((x) => x.title.toLowerCase() === t.toLowerCase() && x.status !== 'rejected');
  if (same) return same;
  const it = { id: crypto.randomBytes(5).toString('hex'), kind: kind === 'behaviour' ? 'behaviour' : 'feature', title: t, why: String(why || '').slice(0, 600), change: String(change || '').slice(0, 2500), source, status: 'proposed', createdAt: new Date().toISOString() };
  if (it.kind === 'feature') it.target = target === 'quote' || target === 'eltra' ? target : guessTarget(t + ' ' + it.change);
  d.items.unshift(it); d.items = d.items.slice(0, 60); await save(d); return it;
}
export async function decide(id, action, by = currentUser(), opts = {}) {
  const d = await loadImprove(), it = d.items.find((x) => x.id === id); if (!it) throw new Error('That proposal no longer exists');
  if (action === 'approve') {
    it.decidedBy = by; it.decidedAt = new Date().toISOString();
    if (it.kind === 'behaviour') it.status = 'live';
    else if (buildReady(it.target)) {
      // a code change: changes touching logins or keys need a second, explicit OK
      if (isSensitive(it) && !opts.confirmSensitive) throw new Error('SENSITIVE');
      it.build = { ...(await startBuild(it)), title: it.title }; it.status = 'building';
    } else it.status = 'approved';
  }
  else if (action === 'target' && (opts.target === 'eltra' || opts.target === 'quote')) it.target = opts.target;
  else if (action === 'live' && it.build && it.build.status === 'built') { await makeLive(it.build); it.status = 'live'; }
  else if (action === 'undo' && it.build && it.build.status === 'live') { await undoBuild(it.build); it.status = 'undone'; }
  else if (action === 'discard' && it.build) { await discardBuild(it.build); it.status = 'rejected'; it.decidedAt = new Date().toISOString(); }
  else if (action === 'retry' && it.kind === 'feature') { it.build = { ...(await startBuild(it)), title: it.title }; it.status = 'building'; }
  else if (action === 'reject') { it.status = 'rejected'; it.decidedBy = by; it.decidedAt = new Date().toISOString(); }
  else if (action === 'done') it.status = 'live';
  else if (action === 'undo') it.status = 'proposed';
  await save(d); return it;
}
// approved behaviour changes, added to Eltra's instructions
export async function liveRules() {
  const d = await loadImprove().catch(() => ({ items: [] }));
  return d.items.filter((x) => x.kind === 'behaviour' && x.status === 'live').map((x) => x.change).filter(Boolean).slice(0, 25);
}
// once a day: turn new notes into at most three proposals
export async function reviewLog() {
  const d = await loadImprove(), since = d.reviewedAt ? Date.parse(d.reviewedAt) : 0;
  const fresh = d.log.filter((x) => Date.parse(x.at) > since);
  d.reviewedAt = new Date().toISOString();
  if (!fresh.length) { await save(d); return 0; }
  const open = d.items.filter((x) => x.status !== 'rejected').map((x) => x.title);
  const ans = await claudeJSON({
    system: 'You are Eltra, an AI assistant built for Eltra Energy (a Melbourne solar and battery installer; Will is the owner, Ethan handles stock, install dates, accounts and socials). You review your own recent problems and requests and propose specific improvements to yourself. People approve every change.',
    prompt: 'Recent notes (errors from tools, things you couldn\'t do, requests, and 👎 feedback on your replies, which matters most):\n' + fresh.map((x) => '- [' + x.kind + '] ' + x.text).join('\n') + '\n\nAlready proposed (don\'t repeat):\n' + (open.join('\n') || 'none') + '\n\nPropose up to 3 improvements worth doing, most valuable first, or none if nothing is worth it. Use kind "behaviour" for a change to how you work that can be written as one clear instruction to yourself (put that instruction in change). Use kind "feature" for anything needing new code or connections (put a short build brief in change: what to build, which files or systems, how to test). Ignore one-off glitches such as a single network timeout.',
    schema: { type: 'object', properties: { proposals: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['behaviour', 'feature'] }, title: { type: 'string' }, why: { type: 'string' }, change: { type: 'string' } }, required: ['kind', 'title', 'why', 'change'] } } }, required: ['proposals'] },
    maxTokens: 1800
  });
  await save(d);
  let n = 0; for (const p of (ans.proposals || []).slice(0, 3)) { await addProposal(p, 'daily review'); n++; }
  return n;
}
export const reviewDue = async () => { const d = await loadImprove(); return d.log.some((x) => Date.parse(x.at) > (d.reviewedAt ? Date.parse(d.reviewedAt) : 0)) && (!d.reviewedAt || Date.now() - Date.parse(d.reviewedAt) > 20 * 3600e3); };

// check builds in progress (called when the dashboard loads the ideas; at most once a minute per build)
export async function refreshBuilds() {
  const d = await loadImprove(); let changed = false;
  for (const it of d.items) {
    const b = it.build;
    if (!b || !['building', 'built'].includes(b.status) || (b.checkedAt && Date.now() - Date.parse(b.checkedAt) < 60000)) continue;
    try { await checkBuild(b, it.title); } catch (e) { b.lastError = e.message; }
    b.checkedAt = new Date().toISOString(); changed = true;
    if (b.status === 'built') it.status = 'built';
    if (b.status === 'failed') it.status = 'failed';
  }
  if (changed) await save(d);
  return d;
}
