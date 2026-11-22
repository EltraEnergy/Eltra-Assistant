// Signed jobs and their install dates. GET: the list. POST { name, date }: set or move a job's install date.
import { json, guard, melbToday } from '../lib/util.mjs';
import { loadJobs, saveJobs, setInstall, parseDay, syncPreApprovals } from '../lib/jobs.mjs';
export default async (req) => {
  const bad = guard(req); if (bad) return bad;
  try {
    const d = await loadJobs();
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({})), day = parseDay(b.date);
      if (!day) return json(400, { error: 'I couldn’t read that date. Try 25/11 or 2026-11-25.' });
      const j = setInstall(d, b.name, day, 'dashboard');
      await syncPreApprovals(d).catch((e) => console.log('DNSP pre-approval due date', e.message));   // due 7 days before the install
      await saveJobs(d);
      return json(200, { job: j });
    }
    const today = melbToday(-14);
    return json(200, { jobs: d.list.filter((x) => !x.closed && (!x.installDate || x.installDate >= today)).sort((a, b) => (a.installDate || '9').localeCompare(b.installDate || '9')) });
  } catch (e) { return json(400, { error: e.message }); }
};
