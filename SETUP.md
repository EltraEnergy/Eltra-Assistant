# Eltra Today – setup

Your own standalone dashboard (the same HUD look as the Claude version) with a voice assistant: next appointment countdown, the week's calendar, recent email, open leads and booked jobs, plus an assistant you talk to and that talks back in a natural ElevenLabs voice. It can read and draft emails, search and move Drive files, add calendar events, and look up and update leads (GoHighLevel) and jobs (ServiceM8).

Anything that changes something (sending an email, moving files, updating a lead, creating a job) shows an **Approve** card first. Nothing goes out without your tap.

Set it up in this order. Google, GoHighLevel and ServiceM8 can each be added later; the app works with whatever is connected.

---

## 1. GitHub
1. In the EltraEnergy GitHub account, create a new **private** repository called `Eltra-Assistant`.
2. Unzip `eltra-assistant.zip`, open the `eltra-assistant` folder and drag **everything inside it** onto the new repo (Add file > Upload files). Commit.
   - Check the repo's main page shows `public`, `netlify`, `netlify.toml` and `package.json` at the top level.
   - If a folder didn't come across (Safari sometimes skips folders), open that folder in GitHub and upload its files directly.

## 2. Netlify
1. **Add new project > Import an existing project > GitHub**, and pick `Eltra-Assistant`. Leave the build settings as they are and deploy.
2. Project configuration > General > **Project name**: `eltra-assistant` (your address becomes `https://eltra-assistant.netlify.app`).
3. Environment variables (Project configuration > Environment variables). Tick **Contains secret values** on all of them:

| Key | Value |
|---|---|
| `AGENT_PASSWORD` | The password you'll log in with. Make it long. |
| `SESSION_SECRET` | 40+ random characters (use a password generator). Never needed again. |
| `ANTHROPIC_API_KEY` | A Claude API key. Best to make a new one called "Eltra Assistant" in the Anthropic console so you can see its cost separately. |

4. Deploys > Trigger deploy > Deploy site. Open the address and log in. The chat works now, but it can't see anything yet.

## 3. Google (Gmail, Calendar, Drive)
Use the Google Cloud project you made for the roof designer.

1. **APIs & Services > Library**: enable **Gmail API**, **Google Calendar API** and **Google Drive API**.
2. **Google Auth Platform > Branding** (or "OAuth consent screen"): app name `Eltra Assistant`, your email as support and developer contact.
3. **Audience**:
   - Your eltraenergy.com.au email runs on Google Workspace, so choose **Internal**. That's the best option: no Google review, and the connection doesn't expire.
   - If it's a normal Gmail account you'll only get **External**. Leave it in **Testing** and add your own email under Test users. Google then makes you reconnect every 7 days (one tap on Connect Google).
4. **Clients > Create client** > Web application, name `Eltra Assistant`.
   - Authorised redirect URI: `https://eltra-assistant.netlify.app/.netlify/functions/google-auth` (use your real address if the name is different).
   - Create, then copy the **Client ID** and **Client secret**.
5. In Netlify add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (secret), then redeploy.
6. Open the assistant and tap **Connect Google** at the top. Sign in with the mailbox you use for work and allow access.

## 4. GoHighLevel
1. In the sub-account: **Settings > Private Integrations > Create new integration**, name `Eltra Assistant`.
2. Scopes: View/Edit Contacts, View/Edit Opportunities, View Locations (contacts.readonly, contacts.write, opportunities.readonly, opportunities.write, locations.readonly).
3. Copy the token. In Netlify add `GHL_TOKEN` (secret).
4. Your **Location ID**: Settings > Business Profile, or the long code after `/location/` in the GHL web address. Add it as `GHL_LOCATION_ID`.
5. Redeploy.

## 5. ServiceM8
1. In ServiceM8, open **Settings** and look for **API Keys**. Create a key called `Eltra Assistant`.
   - If you can't find API Keys, send me a screenshot of the Settings menu.
2. In Netlify add `SERVICEM8_API_KEY` (secret) and redeploy.

## 6. ElevenLabs (the voice)
1. Sign up at elevenlabs.io (the free plan is fine for testing; Starter is about US$5/month).
2. **Voices > Voice Library**: browse and **Add to my voices** any you like. Filter Accent: Australian for local ones.
3. Profile (bottom left) > **API Keys > Create API key**, name it `Eltra Today`. If it asks for permissions, allow **Text to Speech**, **Speech to Text** and **Voices (read)**.
4. In Netlify add `ELEVENLABS_API_KEY` (secret). Optional: `ELEVENLABS_VOICE_ID` to set the default voice (otherwise it picks an Australian one if you've added one).
5. Redeploy. Pick the voice in the dashboard under **Voice settings**.

The same key also turns your speech into text, so the mic works on the iPad, phone and computer.

## 7. On the iPad and phone
Open the address in Safari, log in, then **Share > Add to Home Screen**. Allow the microphone when you first tap the orb.

---

## Good to know
- **Talking:** tap the orb and talk; it stops listening when you pause and sends. Tap the orb while it's talking to cut it off. Tick **Keep listening after replies** for a back-and-forth conversation. On a computer the space bar works as the orb.
- **Voice:** pick any ElevenLabs voice (or a device voice) under Voice settings, and set the speed. Each device remembers its own choice.
- **Your conversation** is kept on that device only. "New chat" clears it.
- **Cost:** you pay Anthropic per use: a typical question is roughly 2–8 cents, a morning brief roughly 10–20 cents. ElevenLabs: spoken replies use your monthly character allowance (Starter covers roughly 30 minutes of speech a month; upgrade if you talk to it a lot). Keep an eye on it in the Anthropic console for the first couple of weeks.
- **Approvals:** anything that sends, moves, archives, creates or updates waits for your Approve tap. Emails and documents can't give it instructions; if one tries, it tells you instead.
- **"That took too long":** each step has to finish within about 10 seconds on Netlify's standard plan. Tap Try again; it carries on where it stopped.
- **Turning it off:** delete `ANTHROPIC_API_KEY` in Netlify and redeploy. To cut Google access, remove "Eltra Assistant" at myaccount.google.com > Security > Third-party connections.
