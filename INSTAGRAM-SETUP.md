# Connecting Instagram to Eltra

1. Meta app (done): "Instagram API (unified login)" configuration, redirect URL
   https://eltra-assistant.netlify.app/.netlify/functions/instagram-auth
2. Netlify → Eltra-Assistant → Environment variables:
   - META_APP_ID      (App settings → Basic → App ID)
   - META_APP_SECRET  (App settings → Basic → App secret)  ← tick "Contains secret values"
   - META_CONFIG_ID   1132719459515517
   Then Deploys → Trigger deploy.
3. Upload this update, open Eltra → Settings → Connections → Connect Instagram.
   Log in, and when Meta asks which accounts to share, tick the Eltra Energy Instagram account.
