// Eltra changing her own code (and the quote app's), with Will's approval at each step:
//   approve an idea → a GitHub issue asks Claude (the Claude Code GitHub action) to build it on a branch →
//   Eltra opens the pull request and finds the Netlify deploy preview → Will tries the preview →
//   "Make it live" merges it → "Undo" restores the previous live version (and asks Claude to revert the change).
// Netlify env: GITHUB_TOKEN, NETLIFY_TOKEN, GITHUB_REPO, NETLIFY_SITE_ID, and for the quote app GITHUB_REPO_QUOTE, NETLIFY_SITE_ID_QUOTE.

export const TARGETS = {
  eltra: { name: 'Eltra', repo: () => process.env.GITHUB_REPO, site: () => process.env.NETLIFY_SITE_ID },
  quote: { name: 'Quote app', repo: () => process.env.GITHUB_REPO_QUOTE, site: () => process.env.NETLIFY_SITE_ID_QUOTE }
};
export const buildReady = (t = 'eltra') => !!(process.env.GITHUB_TOKEN && TARGETS[t] && TARGETS[t].repo());
export const guessTarget = (text) => (/\b(quote app|quote tool|quoting|calculator|eltra.?quote|ipad app|battery comparison)\b/i.test(text || '') ? 'quote' : 'eltra');
const SENSITIVE = /\b(log ?in|password|passcode|token|secret|session|cookie|auth|permission|access code|api key)\b/i;
export const isSensitive = (it) => SENSITIVE.test((it.title || '') + ' ' + (it.change || ''));

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch('https://api.github.com' + path, { method, headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Eltra', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('GitHub: ' + (d.message || res.status));
  return d;
}
async function nf(path, { method = 'GET' } = {}) {
  if (!process.env.NETLIFY_TOKEN) throw new Error('NETLIFY_TOKEN isn’t set');
  const res = await fetch('https://api.netlify.com/api/v1' + path, { method, headers: { Authorization: 'Bearer ' + process.env.NETLIFY_TOKEN, 'User-Agent': 'Eltra' } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Netlify: ' + (d.message || res.status));
  return d;
}

// 1. start: an issue that asks Claude to build the approved change
export async function startBuild(it) {
  const t = it.target || guessTarget(it.title + ' ' + it.change), T = TARGETS[t];
  if (!buildReady(t)) throw new Error('Code updates for ' + T.name + ' aren’t set up yet (GitHub token or repo missing in Netlify).');
  const repo = T.repo();
  const body = ['@claude please build this improvement, which Will has approved.', '', '**' + it.title + '**', '', it.why ? 'Why: ' + it.why : '', '', it.change, '',
    'Follow CLAUDE.md in this repo. Work on a new branch, change only what this needs, keep everything else working, run `node --check` on changed JavaScript, and explain what changed and how to test it.'].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
  const issue = await gh('/repos/' + repo + '/issues', { method: 'POST', body: { title: 'Eltra improvement: ' + it.title.slice(0, 90), body } });
  return { target: t, repo, issue: issue.number, issueUrl: issue.html_url, status: 'building', startedAt: new Date().toISOString() };
}

// 2. check: find Claude's branch, open the pull request if needed, and find the deploy preview
export async function checkBuild(b, title) {
  if (!b || !['building', 'built'].includes(b.status)) return b;
  const repo = b.repo;
  if (!b.pr) {
    const refs = await gh('/repos/' + repo + '/git/matching-refs/heads/claude/issue-' + b.issue + '-').catch(() => []);
    const ref = Array.isArray(refs) && refs.length ? refs[refs.length - 1].ref.replace('refs/heads/', '') : null;
    if (!ref) {
      if (Date.now() - Date.parse(b.startedAt) > 40 * 60000) { b.status = 'failed'; b.error = 'Claude hasn’t produced a change after 40 minutes. Check the issue on GitHub.'; }
      return b;
    }
    b.branch = ref;
    const open = await gh('/repos/' + repo + '/pulls?state=open&head=' + repo.split('/')[0] + ':' + encodeURIComponent(ref)).catch(() => []);
    let pr = Array.isArray(open) && open[0];
    if (!pr) {
      const info = await gh('/repos/' + repo);
      pr = await gh('/repos/' + repo + '/pulls', { method: 'POST', body: { title: 'Eltra improvement: ' + String(title || '').slice(0, 90), head: ref, base: info.default_branch, body: 'Built by Claude for issue #' + b.issue + '. Closes #' + b.issue + '.' } });
    }
    b.pr = pr.number; b.prUrl = pr.html_url;
  }
  // Claude's summary of what it changed (its last comment on the issue)
  if (!b.summary) {
    const cs = await gh('/repos/' + repo + '/issues/' + b.issue + '/comments?per_page=30').catch(() => []);
    const mine = (Array.isArray(cs) ? cs : []).filter((c) => /claude/i.test((c.user && c.user.login) || '')).pop();
    if (mine) b.summary = String(mine.body || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#*`>]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 900);
  }
  // the Netlify deploy preview for this pull request
  const site = TARGETS[b.target].site();
  if (site && process.env.NETLIFY_TOKEN && !b.previewUrl) {
    const ds = await nf('/sites/' + site + '/deploys?per_page=30').catch(() => []);
    const d = (Array.isArray(ds) ? ds : []).find((x) => x.context === 'deploy-preview' && +x.review_id === +b.pr);
    if (d && d.state === 'ready') { b.previewUrl = d.deploy_ssl_url || d.links && d.links.permalink; b.status = 'built'; }
    if (d && d.state === 'error') { b.status = 'failed'; b.error = 'The preview build failed on Netlify: ' + (d.error_message || 'see the deploy log') + '.'; }
  } else if (!site && b.pr) b.status = 'built';
  // once built, note whether the pull request still merges cleanly (another change made live first can cause a conflict)
  if (b.status === 'built' && b.pr) {
    const pr = await gh('/repos/' + repo + '/pulls/' + b.pr).catch(() => null);
    if (pr && typeof pr.mergeable === 'boolean') b.conflict = !pr.mergeable;
  }
  return b;
}

// 3. make it live: remember the current live version (for Undo), then merge
export async function makeLive(b) {
  const site = TARGETS[b.target].site();
  if (site && process.env.NETLIFY_TOKEN) {
    const ds = await nf('/sites/' + site + '/deploys?production=true&per_page=5').catch(() => []);
    const live = (Array.isArray(ds) ? ds : []).find((x) => x.state === 'ready');
    if (live) b.previousDeploy = live.id;
  }
  await gh('/repos/' + b.repo + '/pulls/' + b.pr + '/merge', { method: 'PUT', body: { merge_method: 'squash' } });
  b.status = 'live'; b.liveAt = new Date().toISOString();
  return b;
}

// 4. undo: put the previous live version back now, and ask Claude to revert the change in the code
export async function undoBuild(b) {
  const site = TARGETS[b.target].site();
  if (!b.previousDeploy || !site) throw new Error('There’s no earlier live version recorded for this change.');
  await nf('/sites/' + site + '/deploys/' + b.previousDeploy + '/restore', { method: 'POST' });
  const issue = await gh('/repos/' + b.repo + '/issues', { method: 'POST', body: { title: 'Revert: ' + (b.title || 'Eltra improvement #' + b.pr), body: '@claude please revert the changes merged in pull request #' + b.pr + ', on a new branch, and open a pull request. Follow CLAUDE.md.' } }).catch(() => null);
  b.status = 'undone'; b.undoneAt = new Date().toISOString(); if (issue) b.revertIssue = issue.html_url;
  return b;
}
// discard a build that wasn't wanted
export async function discardBuild(b) {
  if (b.pr) await gh('/repos/' + b.repo + '/pulls/' + b.pr, { method: 'PATCH', body: { state: 'closed' } }).catch(() => {});
  if (b.issue) await gh('/repos/' + b.repo + '/issues/' + b.issue, { method: 'PATCH', body: { state: 'closed' } }).catch(() => {});
  b.status = 'discarded'; return b;
}

// Install an update Will uploaded as a zip: files go on a new branch update/<date-time> in one commit, and a pull request
// opens. No issue (nobody needs to build it); checkBuild then finds the deploy preview, and makeLive / undoBuild work as usual.
// files: [{ path, data (base64) }], already checked to be under netlify/, public/ or a top-level .md file.
export const UPDATE_PATH = (p) => typeof p === 'string' && p.length < 300 && !/(^|\/)\.\.?(\/|$)|\\|\/\/|[\x00-\x1f]/.test(p) && (/^(netlify|public)\/./.test(p) || /^[^/]+\.md$/i.test(p));
export async function installUpdate(target, files, note = '') {
  const T = TARGETS[target];
  if (!T) throw new Error('Pick Eltra or the Quote app');
  if (!buildReady(target)) throw new Error('Code updates for ' + T.name + ' aren’t set up yet (GitHub token or repo missing in Netlify).');
  const repo = T.repo(), R = '/repos/' + repo;
  const info = await gh(R), base = info.default_branch;
  const head = await gh(R + '/git/ref/heads/' + encodeURIComponent(base));
  const parent = await gh(R + '/git/commits/' + head.object.sha);
  // text files go straight into the tree; anything else (images, fonts) becomes a blob first, a few at a time
  const entries = files.map((f) => {
    const buf = Buffer.from(f.data, 'base64'), text = buf.includes(0) ? null : new TextDecoder('utf-8', { fatal: true });
    let content = null; try { if (text) content = text.decode(buf); } catch {}
    return { path: f.path, buf, content };
  });
  const tree = new Array(entries.length);
  const queue = entries.map((e, i) => [e, i]);
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let n = queue.shift(); n; n = queue.shift()) {
      const [e, i] = n, mode = '100644';
      if (e.content !== null) tree[i] = { path: e.path, mode, type: 'blob', content: e.content };
      else { const bl = await gh(R + '/git/blobs', { method: 'POST', body: { content: e.buf.toString('base64'), encoding: 'base64' } }); tree[i] = { path: e.path, mode, type: 'blob', sha: bl.sha }; }
    }
  }));
  const t = await gh(R + '/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree } });
  if (t.sha === parent.tree.sha) throw new Error('Nothing to change: ' + T.name + ' already has exactly these files.');
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Australia/Melbourne' }).replace(/\D/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const branch = 'update/' + stamp, title = 'Install update ' + stamp.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2}).*/, '$3/$2/$1 $4:$5');
  const c = await gh(R + '/git/commits', { method: 'POST', body: { message: title + ' (uploaded by Will from Eltra)', tree: t.sha, parents: [parent.sha] } });
  await gh(R + '/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + branch, sha: c.sha } });
  const list = files.map((f) => '- `' + f.path + '`').join('\n');
  const pr = await gh(R + '/pulls', { method: 'POST', body: { title, head: branch, base, body: 'An update Will uploaded as a zip from Eltra’s dashboard' + (note ? ' (' + note + ')' : '') + '. Approve it there with “Make it live” once the deploy preview looks right.\n\nFiles (' + files.length + '):\n' + list.slice(0, 60000) } });
  return { title, build: { target, repo, branch, pr: pr.number, prUrl: pr.html_url, status: 'building', startedAt: new Date().toISOString(), title, summary: 'Files in this update (' + files.length + '):\n' + files.map((f) => f.path).join('\n').slice(0, 880) } };
}
