# Private School Progress Monitor

An unofficial family automation that combines a parent-visible Edsby activity feed with selected read-only Gmail messages, sends one deduplicated ntfy update, and builds a mobile dashboard. The code can be public; student data, account identifiers, OAuth tokens, and passwords cannot.

This project is not affiliated with Edsby, Google, a school, or ntfy. Edsby scraping remains inherently sensitive to portal layout changes. Gmail uses the official API with the narrow `gmail.readonly` OAuth scope.

## What was improved

- Edsby and Gmail run independently and concurrently. A temporary failure in one source produces an honest partial result instead of hiding data from the other.
- Notifications are marked sent only after ntfy confirms delivery. Failed pushes remain retryable.
- ntfy calls have timeouts, bounded retries, safe header handling, and payload-size protection.
- Daily and backfill state writes share one concurrency group, start from the latest branch tip, and rebase before pushing to prevent stale-workflow `fetch first` failures.
- Gmail queries are limited by both the configured school filter and the current Karachi day; message fetches use bounded concurrency.
- Gmail sender domains are allowlisted, identical emails are collapsed, and school emails keep earliest-received-first order.
- Edsby cards are enriched with course/teacher metadata from the card context and a private course directory.
- Every notification item is numbered; repetitive Edsby login boilerplate is removed.
- New-item checks run every 15 minutes during daytime hours, while a complete daily synthesis is sent at 17:00 Asia/Karachi.
- Personal child IDs, names, tenant URLs, and account addresses moved from code to GitHub Secrets.
- History and dedupe state are AES-256-GCM encrypted before being committed.
- The GitHub Pages dashboard contains ciphertext only and is decrypted locally after entering the dashboard key.
- Raw homework/email dumps and automatic diagnostic screenshot uploads were removed from CI logs.
- Configuration, encryption, Gmail normalization, and syntax/privacy checks are testable without live credentials.

## Public-repository privacy warning

Older versions committed `data/history.json`, `data/notified.json`, and hardcoded child details. Deleting those files in a new commit does not erase old Git history. Before relying on a public repository, remove those paths and identifiers from history using a tool such as `git filter-repo`, force-push the cleaned history, and review existing forks/caches. Make a backup first. The original Edsby password and Gmail OAuth material were not present in this archive, but any credentials ever exposed elsewhere should be rotated.

To preserve existing local history before removing the plaintext files, set `DATA_ENCRYPTION_KEY` in `.env` and run `npm run migrate:state` while the two legacy files are still present. Verify that the dashboard unlocks, then remove/scrub the plaintext copies.

The revised project commits only `data/state.enc.json`. Offline guessing is possible against any public ciphertext, so `DATA_ENCRYPTION_KEY` must be a unique, long passphrase (preferably generated, not a reused account password).

## GitHub configuration

Create these repository **Secrets** under Settings → Secrets and variables → Actions:

| Secret | Required | Purpose |
|---|---:|---|
| `EDSBY_CONFIG_JSON` | yes | One private object containing tenant URLs and child configuration |
| `EDSBY_BASE_URL` / `EDSBY_PARENT_HOME_URL` / `EDSBY_CHILDREN_JSON` | alternative | Separate values remain supported for compatibility |
| `EDSBY_EMAIL` / `EDSBY_PASSWORD` | when Edsby enabled | Parent portal login |
| `EDSBY_CHILDREN_JSON` | yes | Private child configuration array; use the `.env.example` shape |
| `DATA_ENCRYPTION_KEY` | recommended | Encrypts state and unlocks Pages; if absent, the existing long `NTFY_TOPIC` is used as the key |
| `NTFY_TOPIC` | yes | Long, unguessable topic name |
| `NTFY_SERVER` / `NTFY_ALERTS_TOPIC` | optional | Custom server and separate failure channel |
| `GMAIL_ACCOUNT_EMAIL` | when Gmail enabled | Guards against connecting the wrong account |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | when Gmail enabled | Google Cloud Desktop OAuth client |
| `GMAIL_REFRESH_TOKEN` | when Gmail enabled | Read-only offline OAuth grant |
| `GMAIL_QUERY` | when Gmail enabled | Restricts which school messages are considered |
| `GMAIL_SCHOOL_DOMAINS` | when Gmail enabled | Comma-separated sender-domain allowlist applied after Gmail search |
| `GMAIL_CHILD_ID` | optional | Target child; defaults to the first configured child |
| `SCHOOL_COURSES_JSON` | recommended | Private course/teacher/keyword directory used to enrich Edsby cards |

Create these repository **Variables**:

| Variable | Value |
|---|---|
| `EDSBY_ENABLED` | `true` or `false` |
| `GMAIL_ENABLED` | `true` or `false` |

Enable Pages with source **GitHub Actions**. Anyone may load the public URL, but only the correct encryption key can reveal the dashboard content. The key is never sent by the page; browser Web Crypto performs decryption in the tab.

## Secure Gmail connection

Do not put a Gmail password or app password in this project. Use a Google Cloud OAuth Desktop client:

1. In Google Cloud Console, enable the Gmail API and create an OAuth client of type **Desktop app**. Configure the consent screen for your own account.
2. Put the client ID and client secret in a local `.env` copied from `.env.example`; also save them as GitHub repository Secrets. Never commit `.env`.
3. Install and authenticate GitHub CLI (`gh auth login`) and run this command inside the repository:

   ```sh
   npm run gmail:connect
   ```

4. Open the printed Google URL and approve read-only Gmail access. The helper verifies the signed-in account and sends the refresh token directly to GitHub Secrets through standard input. It never prints or saves the token locally.
5. Set `GMAIL_QUERY` as a Secret. Start narrowly, preferably with a known sender or school domain, for example:

   ```text
   {from:(school.example) from:(school.edsby.com)}
   ```

The automation adds strict current-day timestamps to that query. It stores only message subject, sender, short Gmail snippet, timestamp, and a Gmail link—not full message bodies or attachments.

## Test before trusting it

Install Node 20+ and dependencies:

```sh
npm ci
npx playwright install chromium
npm test
npm run lint
```

For a real local dry run, copy `.env.example` to `.env`, fill it locally, then run:

```sh
node --env-file=.env scripts/run.js --dry-run
```

A dry run still logs into enabled sources but does not send ntfy messages or write dedupe success markers. It does generate local encrypted state/dashboard files. First validate with safe sample identifiers if possible; do not add real student data until repository secrets, encryption, and access controls are configured.

Then run **School Progress Check** manually in GitHub Actions with `dry_run` enabled. Verify:

- the run reports separate Edsby/Gmail item counts without printing message content;
- an encrypted `data/state.enc.json` commit appears;
- Pages shows only the unlock screen before the dashboard key is entered;
- entering a wrong key reveals nothing;
- a non-dry run sends one notification, and a same-content rerun does not duplicate it.

## Automation behavior

- Every 15 minutes from approximately 07:07–18:52 Asia/Karachi: collect Edsby and Gmail, and notify only genuinely new/changed items.
- Every day at 17:00 Asia/Karachi: send one complete numbered synthesis of the day's school notices and homework.
- Manual backfill: maximum 31 days, with one consolidated digest.
- Same-day edits generate a new notification because deduplication hashes normalized content, not only the date.
- If all sources fail, the dashboard records a failure and ntfy receives a high-priority warning. If one source works, the status is **partial**.

## Known limitations

- Edsby has no public API used here; its browser selectors must be verified against the current parent portal. “No items” is not proof that the selectors remain correct—monitor source counts and failure alerts.
- The app reports only parent-visible content. It does not invent completion/submission status that Edsby does not expose.
- Gmail relevance is only as good as `GMAIL_QUERY`. Use school senders/labels to avoid unrelated mail.
- Public ntfy topics are effectively bearer secrets. Use a long random topic or an authenticated/self-hosted ntfy server for stronger privacy.
- A public encrypted dashboard still exposes update timing and ciphertext size. If that metadata matters, disable Pages and rely on notifications or deploy behind authentication.

## Project layout

```text
scripts/run.js             source orchestration and consolidated notifications
scripts/edsbyClient.js     Playwright login and activity-feed scraping
scripts/gmailClient.js     Gmail OAuth refresh and read-only message search
scripts/stateStore.js      encrypted persistent history/dedupe state
scripts/dashboard.js       encrypted client-side dashboard
scripts/ntfy.js            bounded/retrying ntfy sender
scripts/gmailAuthorize.js  one-time secure OAuth-to-GitHub helper
test/                      credential-free unit tests
.github/workflows/         scheduled and manual automations
```
