# Jukugo

A small, offline-capable web app for learning common Japanese vocabulary. Each
word progresses through a single path: read it (learning → learned → mastered),
then write it (learning → learned → mastered). Vanilla JS, no build step.

## Files

- `index.html` – app shell (registers the service worker)
- `app.js` – game logic
- `data.js` – bundled vocabulary (generated)
- `styles.css` – styles
- `config.js` – per-device config; **keep the key blank in a public repo**
- `sw.js` – service worker (offline precache)
- `manifest.webmanifest`, `icon.svg` – PWA metadata
- `.nojekyll` – tell GitHub Pages to serve files as-is

## Deploy to GitHub Pages

1. Create a repo (e.g. `jukugo`) and push **the contents of this folder to the
   repo root**:
   ```bash
   cd jukugo
   git init
   git add .
   git commit -m "Jukugo app"
   git branch -M main
   git remote add origin https://github.com/<you>/jukugo.git
   git push -u origin main
   ```
2. Repo → **Settings → Pages** → Source: **Deploy from a branch**,
   Branch: **main**, Folder: **/ (root)** → Save.
3. Wait ~1 minute for the URL: `https://<you>.github.io/jukugo/`.

## Use it on your phone

1. Open the Pages URL in the phone browser (Chrome on Android).
2. Menu → **Add to Home Screen** to install it.
3. Open the app → the **Progress** tab (top bar) → **Settings** → paste your
   **OpenAI API key** (needed only for the "Get example sentence" button). It is
   stored only on your device and sent directly to OpenAI.
4. Open it once online so the service worker caches everything; after that it
   works **offline**.

## Updating

Edit files, then bump the `CACHE` version string in `sw.js` (so phones fetch the
new files), commit, and `git push`. Pages redeploys automatically.
