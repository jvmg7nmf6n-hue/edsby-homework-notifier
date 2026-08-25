# Edsby Homework Notifier

An unofficial personal automation that logs into the [Edsby](https://www.edsby.com/)
parent portal every school day, checks for homework/announcements posted **today**
for one child, and pushes a notification via [ntfy.sh](https://ntfy.sh) — plus a
small, mobile-friendly dashboard published on GitHub Pages.

**This is not an official Edsby integration.** It's a personal script that drives a
real browser (Playwright) against the same pages a parent would click through by
hand, on a schedule, and is not affiliated with or endorsed by Edsby or the school.
Use responsibly — it's built for one check a day, not aggressive polling.

## How it works

- **GitHub Actions** runs the check once a day (`cron`), timezone-aware for
  Asia/Karachi (UTC+5, no DST):
  - **Monday–Friday**: logs in, scrapes the child's "Recent Activity" feed for
    anything dated today, and pushes a homework summary via ntfy.
  - **Sunday**: sends a short "finish pending homework" reminder only — no scrape.
  - **Saturday**: the cron schedule itself never fires (see the workflow's own
    comment) — no automated run at all.
  - A `workflow_dispatch` manual trigger is also available, with a `dry_run` option.
- A small **dashboard** (`docs/index.html`, deployed to GitHub Pages) shows today's
  homework front and center plus the last 14 days, in light/dark mode, mobile-first.
- A tiny **dedupe log** (`data/notified.json`) stops a re-run from spamming a
  duplicate push for content already sent; **`data/history.json`** persists what
  was found each day so the dashboard's history strip survives across runs.

## Setup (fork → configure → done)

1. **Fork this repo** (keep it public — GitHub Pages on the free tier needs that,
   and there's nothing sensitive in the code itself).
2. **Add repository secrets** (Settings → Secrets and variables → Actions → New
   repository secret):

   | Secret | Required | Notes |
   |---|---|---|
   | `EDSBY_EMAIL` | yes | Your Edsby parent-portal login email |
   | `EDSBY_PASSWORD` | yes | Your Edsby parent-portal password |
   | `NTFY_TOPIC` | yes | A long, hard-to-guess topic name (see below) |
   | `NTFY_SERVER` | no | Only if self-hosting ntfy; defaults to `https://ntfy.sh` |
   | `NTFY_ALERTS_TOPIC` | no | A separate topic for failure alerts; defaults to `NTFY_TOPIC` |

3. **Pick an ntfy topic and subscribe to it**: install the [ntfy app](https://ntfy.sh/#subscribe)
   (iOS/Android/web), then subscribe to a topic name of your choosing — treat the
   name like a password, since anyone who knows it can read the feed (ntfy itself
   doesn't require auth on the free public server). A long random string works
   well, e.g. `bin-salman-hw-9f2a7c1e4b`.
4. **Enable GitHub Pages**: Settings → Pages → Source → "GitHub Actions" (the
   workflow deploys via `actions/deploy-pages`, so no branch needs to be picked).
5. **Run it once manually** to verify the whole pipeline before trusting the
   schedule — see Testing below.

### Supporting a second child

`scripts/config.js` has `edsby.children` as a **list**, not a single hardcoded
value — add a second `{ id, name, grade, dashboardUrl }` entry there and every
other script (scraper, notifier, dashboard) picks it up automatically.

## Testing before you trust it unattended

1. Go to **Actions → Edsby Homework Check → Run workflow**, tick `dry_run`, run it.
2. `dry_run` still performs the **real** Edsby login and scrape (that's the point —
   it proves your credentials and the scraper actually work end-to-end) but
   **prints the ntfy payload to the workflow log instead of sending it**.
3. Check the run's log for the printed payload, and check the Pages URL (Settings →
   Pages, or the deployment URL in the run summary) to confirm the dashboard
   renders — try it on your phone and in dark mode.
4. Once that looks right, run it again **without** `dry_run` and confirm a real
   push arrives on your phone via the ntfy app.
5. To deliberately test the failure path, temporarily set `EDSBY_PASSWORD` to
   something wrong, run it, and confirm you get a "check failed" push instead of
   silence.

Local testing (optional, needs Node 20+ and `npx playwright install chromium` once):

```sh
cp .env.example .env   # fill in real values
node --env-file=.env scripts/run.js          # real run
DRY_RUN=true node --env-file=.env scripts/run.js   # dry run
```

## Selector fragility — read this if a run fails

Edsby's exact login form and activity-feed DOM were documented from a manual
browsing session, not machine-verified line-by-line before this code was written.
`scripts/edsbyClient.js` uses defensive, role/text-based Playwright locators
(never brittle class-name chains) specifically so small DOM changes don't break
it silently, but a real layout change can still require a selector update.

**On any failure — login, selector-not-found, network error — you get an ntfy
push explaining what broke, never silence.** The workflow also uploads a
screenshot (`diagnostics/`) as a build artifact on failure — safe to look at
without leaking your password (browsers always mask `type="password"` fields
visually, screenshot or not); your email address may be visible in it, which is
why it's never committed to the repo, only attached to that one run's artifacts.

If a run fails, check the Actions log first, then the screenshot artifact, and
adjust the relevant locator in `scripts/edsbyClient.js`.

## What gets scraped, and how "today" is decided

- Every card in the "Recent Activity" feed is scanned for a **`Date:`** field —
  that's the lesson/homework date, and what's compared against today's real
  Asia/Karachi calendar date. The "posted Xh/Xd ago" relative label near the
  subject name is **ignored** for this purpose (a post can say "2h ago" but its
  `Date:` field says yesterday).
- Because the feed is virtualized and ordered by post-time (not lesson-date), the
  scraper clicks "Show Older Posts" repeatedly until it's paged back at least 3
  days past today (or hits a 30-click safety cap), not just until today's posts
  "look" present.
- The notifications bell dropdown is checked as a secondary, lower-priority
  cross-check for anything today-dated the activity feed might have missed.
- "Nothing posted today" is a real, valid outcome — you still get a short
  notification saying so, not silence.

## Security notes

- Credentials and the ntfy topic live **only** in GitHub Actions encrypted
  secrets — never in the repo, never printed to logs. `.env` is gitignored.
- `data/notified.json` and `data/history.json` (committed back by the workflow
  each run) contain homework **content** (subject names, topics, to-do text,
  attachment filenames) but never credentials or session cookies.
- The dashboard is public (no login) by design, but never shows anything beyond
  what's already in `data/history.json` — no raw Edsby attachment files are
  re-hosted, just filenames and a link back to the (login-gated) Edsby site.

## Project layout

```
scripts/
  run.js          orchestrator: Sun-vs-weekday branch, ties everything together
  edsbyClient.js  Playwright login + activity-feed scraper
  ntfy.js         ntfy.sh POST sender (+ dry-run mode)
  dashboard.js    generates docs/index.html from data/history.json
  dedupe.js       content-hash log so re-runs don't double-notify
  history.js      persisted day-by-day record the dashboard reads
  config.js       all configuration/secrets in one place
  karachiTime.js  Asia/Karachi date helpers (no external date library)
.github/workflows/homework-check.yml   the daily schedule + manual trigger
data/             committed state (notified.json, history.json)
docs/             generated dashboard output (gitignored, built fresh each run)
```

## Nice-to-haves not yet built

- Weekly digest.
- Downloading/re-hosting attachment files (currently just filenames are listed —
  the raw file URLs are login-gated and weren't confirmed fetchable outside an
  authenticated Playwright session).
- A parent-visible completion/submission status — unclear if Edsby exposes this
  to parents at all; not investigated, not fabricated.
