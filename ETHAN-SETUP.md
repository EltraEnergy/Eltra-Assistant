# Adding Ethan to Eltra

1. **Netlify → Eltra-Assistant → Environment variables**: add `ETHAN_PASSWORD` (8+ characters, tick "Contains secret values"), then trigger a deploy.
2. **Google Cloud** (only if your consent screen is "External / Testing"): Google Auth Platform → Audience → Test users → add Ethan's Google email. If it's "Internal" and Ethan has an @eltraenergy.com.au account, nothing to do.
3. Ethan opens the dashboard, logs in with his password, and taps **Connect Google** with **his own** account.

Will's password, login and Google connection carry on unchanged.
