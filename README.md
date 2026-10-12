# Divine Insight — Web

The **Web** branch of the Divine Insight platform: a browser tarot-reading site
built with [TanStack Start](https://tanstack.com/start) (React 19 + Vite 7 +
Tailwind 4), served on **port 3000**.

Card data comes from [Divine Insight Core](https://github.com/mal494/divine-insight-core)
— this repo never edits card copy directly. See `CORE.md` for the pinned-version
rules.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (`bun --version`)
- Node is optional — Bun ships its own runtime; `node` only matters if you use
  `node scripts/generate-deck.mjs` explicitly (Bun can run it too:
  `bun scripts/generate-deck.mjs`).

## Quick start

```bash
cd divine-insight-web
bun install          # installs deps (also done automatically by publish.sh)
bun run dev          # dev server on http://localhost:3000
```

## Common commands

| Task | Command |
|------|---------|
| Dev server (HMR) | `bun run dev` → http://localhost:3000 |
| Production build | `bun run build` → emits `dist/client` + `dist/server` |
| Serve the built site | `bun run start` (requires `bun run build` first) |
| Build + serve (deploy) | `bun run publish` → `publish.sh` |
| Deploy to Vercel | `bun run go-live` → `go-live.sh` (needs `VERCEL_TOKEN`) |
| Format | `bun run format` (Prettier, `--write .`) |
| Type-check | `bunx tsc --noEmit` |

> **Note:** `publish.sh` / `go-live.sh` / `serve.ts` assume a Linux-style sandbox
> (`bash`, `setsid`, `lsof`, `sudo`, `curl`). On a plain Windows shell use
> `bun run dev` / `bun run build` instead — the sandbox-only takeover logic in
> `serve.ts` won't run outside that environment.

## Environment variables

None are required to build or run the dev server. These matter at deploy time:

| Variable | Required by | Purpose |
|----------|-------------|---------|
| `VERCEL_TOKEN` | `bun run go-live` | Vercel deploy token (collected from the owner) |
| `DATABASE_URL` | runtime queries via `src/db.ts` | Neon Postgres connection string — resolved lazily, so the site builds & serves without it; only actual queries throw |
| `STRIPE_WEBHOOK_SECRET` | `/api/stripe-webhook` | Stripe signing secret (`whsec_...`). Required for paid orders to flip to `paid` |
| `RESEND_API_KEY` + `GIFT_FROM_EMAIL` | gift emails via `src/lib/gift-email.ts` | Required to send Gift Reading claim emails |
| `PUBLIC_SITE_URL` | gift claim-link builder | Optional origin override for `/claim/<token>` links in email |
| `SITE_URL` | optional, og:url/og:image/canonical tags | The real production origin. Falls back to `VERCEL_PROJECT_PRODUCTION_URL` on Vercel, then to a relative path. **Never hardcode a sandbox domain here** |
| `VERCEL_SCOPE` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_NAME` | optional | Overrides for `go-live.sh` team/project resolution |

`go-live.sh` fails fast when `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, or
`GIFT_FROM_EMAIL` is missing, and passes them to Vercel with `-e` so a deploy
cannot silently go out without payment/gift-email configuration.

Create a local `.env` (gitignored) if you need any of these during development:

```bash
cp .env.example .env   # if present; otherwise create .env manually
```

## Project layout

```
src/
  routes/
    __root.tsx     # HTML shell: <head>, fonts, canonical/og tags, layout
    index.tsx      # the landing page ("/")
  components/      # card-face, reading-panel, pricing, tip-jar, …
  data/
    deck.generated.ts   # GENERATED — do not hand-edit (see CORE.md)
    deck.ts             # deck accessors
    artwork.ts          # which card ids have real artwork (all 78)
  lib/             # analytics, payments, random, synthesis
  styles/app.css   # Tailwind entrypoint + base styles
  db.ts            # Neon serverless Postgres helper (server-only)
scripts/
  generate-deck.mjs     # rebuilds src/data/deck.generated.ts from Core
  deck-presentation.json# hand-maintained glyphs + numerology notes
public/
  cards/           # 78 card artworks (.webp)
  hero/            # hero image used for og:image
site.json          # { "businessName": "…" } — read at request time
vite.config.ts     # dev server on 0.0.0.0:3000
```

## Adding a page

Create a new file under `src/routes/` — e.g. `about.tsx` becomes `/about`.
Files are routes; the router tree (`src/routeTree.gen.ts`) is generated
automatically (it's gitignored).

## Regenerating the deck

The dataset is fetched from Core at the tag in `core.version`:

```bash
bun scripts/generate-deck.mjs
```

It fails loudly on a wrong card count, duplicate id, or a card missing meaning,
keywords, glyph or numerology note. Never hand-edit
`src/data/deck.generated.ts` — see `CORE.md` for the full rules.

## Styling / formatting

Prettier is wired up (`bun run format`). The repo currently uses LF line
endings; Windows checkouts with `core.autocrlf=true` may show a large
format-only diff after `bun run format` — that's expected, review with
`git diff --ignore-cr-at-eol`.
