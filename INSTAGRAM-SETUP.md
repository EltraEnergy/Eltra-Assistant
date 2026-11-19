# Connecting Instagram to Eltra

Option A – Connect button (your Facebook login must be an admin of the portfolio that owns the Instagram account)
  Netlify: META_APP_ID, META_APP_SECRET (secret), META_CONFIG_ID = 1132719459515517, INSTAGRAM_ACCOUNT_ID = 17841474006679183
  Eltra → Settings → Connect Instagram.

Option B – Token from the Meta developer dashboard (works with any portfolio)
  1. developers.facebook.com → Eltra Assistant → Use cases → Customize → API setup with Unified login
     → 2. Generate access tokens → Generate token next to eltraenergy_ → copy it.
  2. Netlify → Eltra-Assistant → Environment variables:
       INSTAGRAM_ACCESS_TOKEN = the token (tick "Contains secret values")
       INSTAGRAM_ACCOUNT_ID   = 17841474006679183
  3. Trigger a deploy. Eltra → Settings should show "Instagram @eltraenergy_".
  Instagram-style tokens (starting "IG") are refreshed automatically by Eltra. If you ever generate a new token,
  replace INSTAGRAM_ACCESS_TOKEN and redeploy.
