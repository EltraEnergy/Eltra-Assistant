# Eltra (Eltra-Assistant) – notes for Claude

Eltra is the AI assistant dashboard for Eltra Energy, a Melbourne solar and battery installer. Owner: Will. Ethan (stock, install dates, accounts, socials) has his own login. Hosted on Netlify from this repo; every merge to `main` deploys live.

## Layout
- `public/` – the dashboard (one page): `index.html` (layout + CSS), `app.js` (all browser code: chat, voice, panels, to-dos, content schedule, improvements).
- `netlify/functions/` – web endpoints. `agent.mjs` runs a chat turn with Claude (system prompt + tools). Timed jobs: `automations.mjs` (every 30 min), `content-run.mjs` (every 10 min).
- `netlify/lib/` – shared code. `tools.mjs` defines every tool Eltra can use with `tool({ name, group, action, describe, run })`. `util.mjs` (logins, per-user context `runAs`, storage), `google.mjs`, `todos.mjs`, `jobs.mjs`, `automations.mjs`, `content.mjs`, `improve.mjs`, `instagram*.mjs`, `weekly.mjs`.
- Data lives in Netlify Blobs (store `eltra-agent`), not in the repo.

## Rules
- Anything that sends, posts, books, creates outside Eltra or spends money must be a tool with `action: true` and a `describe()` so it shows an Approve card. Never remove an approval.
- Don't change logins, passwords, cookies, tokens or `util.mjs` session code unless the task explicitly asks.
- Background jobs run as Will (`runAs('will', …)`); per-user features must respect `currentUser()`. Ethan must never see Will's email or calendar.
- Keep Australian English and the existing plain, friendly wording. No new npm dependencies unless essential (only `@netlify/blobs` today).
- Netlify functions time out after ~10–26 s (scheduled ~30 s): keep work per call short.
- Before finishing: `node --check` every changed `.mjs`/`.js` file, and keep existing behaviour working. Explain in the pull request what changed and how to test it in the Netlify deploy preview.
