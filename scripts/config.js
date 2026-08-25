// Central place every script reads its configuration from. Secrets come only
// from environment variables (GitHub Actions secrets in CI, a local .env for
// manual testing -- see .env.example) -- never hardcoded, never logged.

function required(name, { allowEmptyInDryRun = false } = {}) {
  const value = process.env[name];
  if (value) return value;
  if (allowEmptyInDryRun && isDryRun()) return "";
  throw new Error(`Missing required environment variable: ${name}`);
}

export function isDryRun() {
  return String(process.env.DRY_RUN || "").toLowerCase() === "true";
}

export const config = {
  edsby: {
    baseUrl: "https://headstart.edsby.com",
    parentHomeUrl: "https://headstart.edsby.com/p/BaseParent/210220381",
    // Config LIST (not a single hardcoded child) so a second child can be
    // added later without touching any scraping/notification code -- see
    // README's "supporting a second child" note.
    children: [
      {
        id: "210215645",
        name: "Muhammad Bin Salman",
        grade: "7-K",
        dashboardUrl: "https://headstart.edsby.com/p/BaseParentChild/210215645",
      },
    ],
    get email() {
      // Required even in dry_run: dry_run only mocks the ntfy SEND step, it
      // still performs a real Edsby login/scrape (that's the whole point --
      // "verify a fresh setup... works end-to-end before trusting it to run
      // unattended").
      return required("EDSBY_EMAIL");
    },
    get password() {
      return required("EDSBY_PASSWORD");
    },
  },
  ntfy: {
    get server() {
      return process.env.NTFY_SERVER || "https://ntfy.sh";
    },
    get topic() {
      return required("NTFY_TOPIC", { allowEmptyInDryRun: true }) || "dry-run-topic";
    },
    get alertsTopic() {
      // Falls back to the same topic if a dedicated alerts topic isn't set --
      // still every failure gets a real push, just not separated out.
      return process.env.NTFY_ALERTS_TOPIC || this.topic;
    },
  },
  // How many days of history the dashboard's "recent" strip shows.
  dashboardHistoryDays: 14,
  // Safety cap on "Show Older Posts" clicks -- the feed is post-time, not
  // lesson-date, ordered, so we page back until we've covered this many
  // calendar days of buffer past today, or hit this cap, whichever first.
  maxShowOlderClicks: 30,
  lookbackBufferDays: 3,
};
