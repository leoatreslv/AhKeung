# Ah Keung 💪

Your personal gym training tracker — a Progressive Web App (PWA) that works on both Android and iOS without going through any app store.

## What it does

- **Plan your week** — pick muscle groups (chest/back/legs/etc.) and build a routine with target sets, reps and weights.
- **Track workouts** — tick off each set as you go, with a live timer.
- **Exercise library** — 35+ exercises across 9 muscle groups, each with form notes.
- **Body metrics** — log weight, height, body fat over time, with BMI and a weight-trend chart.
- **Offline-first** — all data lives on your device (IndexedDB via Dexie). No login, no server, no tracking.
- **Installable** — add to home screen on iOS/Android for a fullscreen app feel.

## Tech

- Vite + React 19 + TypeScript
- Tailwind CSS
- Dexie (IndexedDB) for local persistence
- React Router (hash mode, so it works on any static host)
- vite-plugin-pwa for service worker + manifest
- Recharts for the weight trend graph

## Run locally

```bash
cd ah-keung
npm install
npm run dev
```

Open `http://localhost:5173` (or the network URL it prints for testing on your phone over Wi-Fi).

## Build for production

```bash
npm run build
```

Outputs a fully static site to `dist/` — drop it anywhere (Vercel, Netlify, Cloudflare Pages, GitHub Pages, your own server).

## Install on phone

1. Deploy somewhere with HTTPS (required for PWAs / service workers).
2. Open the URL in **Safari (iOS)** or **Chrome (Android)**.
3. Tap **Share → Add to Home Screen** (iOS) or **⋮ → Install app** (Android).
4. Launch from the home-screen icon — runs fullscreen, no browser chrome.

## Project structure

```
src/
├── App.tsx            # router + bottom tab bar
├── db.ts              # Dexie schema (plans / sessions / metrics)
├── exercises.ts       # bundled exercise catalog
├── utils.ts           # date helpers
└── pages/
    ├── Home.tsx       # this-week plan, recent sessions, quick actions
    ├── Plans.tsx      # list of saved plans
    ├── PlanEditor.tsx # create/edit a plan with focus groups + exercises
    ├── Workout.tsx    # live session, set-by-set logging, timer
    ├── Library.tsx    # browse / search exercises by muscle group
    └── Metrics.tsx    # log + chart body metrics
```

## Roadmap

- Cloud sync (Supabase) — opt-in, so the same data follows you across phones.
- Rest timer between sets.
- Personal records (PRs) view per exercise.
- Real exercise GIFs/diagrams (currently using emojis as placeholders).
- Export to CSV.
