<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/e468963d-bbff-4509-96e4-ae233a833514

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Run the app:
   `npm run dev`

> Provider API keys (Gemini, etc.) are NOT set in the client build — they live only as Cloudflare
> Worker secrets (`wrangler secret put GEMINI_API_KEY --env staging`) and are injected server-side by
> the `/api/gemini` proxy. Never put a provider key in `.env.local` / the client bundle. To use your
> own key for local direct testing, paste it into the app's Settings (it stays in your browser only).
