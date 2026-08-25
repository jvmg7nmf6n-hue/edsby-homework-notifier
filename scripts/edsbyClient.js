// Playwright-driven Edsby scraper. Edsby is a heavy SPA with a virtualized
// activity feed -- plain fetch/HTML scraping doesn't work (see README).
//
// VERIFICATION STATUS, kept honest and current:
//   - loginToEdsby(): selectors LIVE-VERIFIED 2026-08-25 against a real
//     logged-out session on headstart.edsby.com (see git history for the
//     fix this replaced -- the first version guessed a "click a Login-ish
//     link" step that turned out to also match the page's own "Log in using
//     Google" link, which is exactly the class of bug this note exists to
//     prevent silently reintroducing).
//   - scrapeChildHomework() and its helpers: still NOT independently
//     live-verified -- described from a manual browsing session, not
//     captured field-by-field. Written defensively (role/text-based
//     Playwright locators, multiple fallback strategies, no brittle
//     nth-child/class-name chains) per the project's own design constraint,
//     but the first real `dry_run` against the activity feed (see README's
//     Testing section) is what actually validates these. Any selector that
//     fails should throw a clear, specific error (never silently return
//     empty data) so the ntfy failure alert names the real problem.

import { chromium } from "playwright";
import { config } from "./config.js";
import { karachiISODate } from "./karachiTime.js";

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

export class EdsbySelectorError extends Error {
  constructor(message) {
    super(message);
    this.name = "EdsbySelectorError";
  }
}

// Screenshots are safe to upload as CI artifacts as-is: a browser always
// renders `type="password"` as masked dots regardless of the real value, so
// a screenshot can never visually leak EDSBY_PASSWORD. The email address may
// be visible on-screen (lower sensitivity than a password, and it's the
// user's own account email, not a third-party secret) -- disclosed in the
// README rather than hidden. Written to `diagnostics/` (gitignored, never
// committed -- only ever picked up by the workflow's own artifact-upload
// step for that single run).
async function saveDiagnosticScreenshot(page, label) {
  if (!page || page.isClosed()) return null;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir("diagnostics", { recursive: true });
    const path = `diagnostics/${label}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    return path;
  } catch {
    return null;
  }
}

/** Logs in and returns an authenticated Playwright `page`/`context`/`browser`
 * trio the caller is responsible for closing. Throws EdsbySelectorError with
 * a specific, actionable message if any expected element isn't found --
 * never silently proceeds on a half-completed login. */
export async function loginToEdsby() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    // A realistic UA avoids some SPA bot-detection paths that serve a
    // stripped-down "unsupported browser" page instead of the real app.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const page = await context.newPage();

  try {
    // Live-inspected, confirmed 2026-08-25 (logged-out session against the
    // real headstart.edsby.com tenant): navigating to the base URL redirects
    // straight to a single username/password form at /p/BasePublic/ -- no
    // separate marketing/landing page, no district/board picker, no MFA
    // step. An EARLIER version of this function tried to click a "Login"
    // link/button on the landing page first, matched on a loose /log ?in/i
    // name regex -- that regex also matches this page's own "Log in using
    // Google" OAuth link's accessible name, which is why the very first
    // real run clicked into Google's OAuth flow instead of ever reaching
    // this form. Fixed by removing that step entirely and going straight
    // for the real, confirmed field selectors below -- do not reintroduce a
    // generic "find and click a login-ish link" step without checking it
    // can't also match that Google link.
    await page.goto(config.edsby.baseUrl, { waitUntil: "domcontentloaded" });

    // Username field: type="text", placeholder="Username" (labeled
    // "Username" even though an email address is what's actually typed in),
    // name="login-userid". Its `id` has a numeric prefix regenerated per
    // page load (e.g. "2loginform-login-userid__f__") -- never select by id.
    const usernameField = await findFirstVisible(page, [
      () => page.getByPlaceholder("Username"),
      () => page.locator('input[name="login-userid"]'),
    ]);
    if (!usernameField) {
      throw new EdsbySelectorError(
        "Could not find the Username field on the Edsby login page -- the login form's structure has likely changed from what was live-verified on 2026-08-25."
      );
    }
    await usernameField.fill(config.edsby.email);

    // Password field: type="password", placeholder="Password", `name` is
    // empty on this field (confirmed) -- select by placeholder/type only,
    // never by name.
    const passwordField = await findFirstVisible(page, [
      () => page.getByPlaceholder("Password"),
      () => page.locator('input[type="password"]'),
    ]);
    if (!passwordField) {
      throw new EdsbySelectorError(
        "Could not find the Password field on the Edsby login page -- the login form's structure has likely changed from what was live-verified on 2026-08-25."
      );
    }
    await passwordField.fill(config.edsby.password);

    // Submit is a real <input type="submit"> (id has the same unstable
    // numeric-prefix issue as the username field's id, so it's deliberately
    // not used here), not a <button> -- select by type, not by role/name
    // (a role-based name match risks the same "Log in using Google" link
    // collision the earlier landing-page step hit).
    const submitButton = page.locator('input[type="submit"]');
    if (!(await submitButton.count())) {
      throw new EdsbySelectorError(
        "Could not find the login submit input on the Edsby login page -- the login form's structure has likely changed from what was live-verified on 2026-08-25."
      );
    }
    await Promise.all([
      page.waitForURL(/\/p\/BaseParent\//, { timeout: NAV_TIMEOUT_MS }),
      submitButton.first().click(),
    ]);

    return { browser, context, page };
  } catch (err) {
    // Capture everything from the still-open page BEFORE closing the
    // browser -- page.url()/screenshot() are unusable once it's closed.
    const urlAtFailure = page.url();
    err.screenshotPath = await saveDiagnosticScreenshot(page, "login-failure");
    await browser.close().catch(() => {});
    if (err.name === "TimeoutError") {
      throw new EdsbySelectorError(
        `Login form was submitted but the page never navigated to /p/BaseParent/... (stayed at ${urlAtFailure}) -- ` +
          "check EDSBY_EMAIL/EDSBY_PASSWORD secrets are correct, or the login flow may have changed."
      );
    }
    throw err;
  }
}

async function findFirstVisible(page, locatorFactories) {
  for (const factory of locatorFactories) {
    const locator = factory();
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

/** Navigates to a specific child's dashboard and returns every activity-feed
 * card whose Date: field falls within [todayISO - lookbackBufferDays, today].
 * Cross-checks the notifications bell as a secondary source. */
export async function scrapeChildHomework(page, child, { maxShowOlderClicks, lookbackBufferDays }) {
  try {
    await page.goto(child.dashboardUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});

    const feedHeading = page.getByText(/recent activity/i).first();
    await feedHeading.waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS }).catch(() => {
      throw new EdsbySelectorError(
        `Could not find the "Recent Activity" feed on ${child.dashboardUrl} -- the child dashboard's layout may have changed, or the login session didn't carry over.`
      );
    });

    const todayISO = karachiISODate();
    const cutoffISO = karachiISODate(new Date(Date.now() - lookbackBufferDays * 86_400_000));

    const seen = new Map(); // dedupe key -> card
    let oldestSeenISO = todayISO;
    let clicks = 0;

    while (clicks < maxShowOlderClicks) {
      await collectVisibleCards(page, seen);

      const oldest = [...seen.values()]
        .map((c) => c.dateISO)
        .filter(Boolean)
        .sort()[0];
      if (oldest) oldestSeenISO = oldest;

      if (oldestSeenISO && oldestSeenISO <= cutoffISO) break;

      const olderButton = page.getByRole("button", { name: /show older posts?/i });
      const hasMore = await olderButton.count();
      if (!hasMore) break;
      const visible = await olderButton.first().isVisible().catch(() => false);
      if (!visible) break;

      await olderButton.first().click();
      await page.waitForTimeout(800); // let the virtualized feed render the newly-loaded batch
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      clicks++;
    }

    const todaysCards = [...seen.values()].filter((c) => c.dateISO === todayISO);

    const bellCards = await scrapeNotificationBell(page, todayISO).catch((err) => {
      console.warn(`Notification-bell cross-check failed (non-fatal): ${err.message}`);
      return [];
    });

    return { todaysCards, bellCrossCheck: bellCards, cardsScanned: seen.size, showOlderClicks: clicks };
  } catch (err) {
    err.screenshotPath = await saveDiagnosticScreenshot(page, `scrape-failure-${child.id}`);
    throw err;
  }
}

/** Finds every activity card currently rendered and merges new ones into
 * `seen` (keyed by subject+date+first-120-chars, since the DOM is
 * virtualized and repeated scans will re-see already-collected cards). */
async function collectVisibleCards(page, seen) {
  // Cards are identified generically: a container that has BOTH a
  // recognizable subject/course heading AND a "Date:" label somewhere
  // inside it. This avoids depending on a specific class name.
  const dateLabels = page.getByText(/^date:/i);
  const count = await dateLabels.count();

  for (let i = 0; i < count; i++) {
    const dateLabel = dateLabels.nth(i);
    const card = await nearestCardContainer(dateLabel);
    if (!card) continue;

    const cardText = (await card.innerText().catch(() => "")) || "";
    const dateISO = parseEdsbyDate(cardText);
    const subject = extractSubject(cardText);
    const topics = extractSection(cardText, /topics covered/i);
    const toDo = extractSection(cardText, /to ?do/i);
    const attachments = await extractAttachmentNames(card);

    const key = `${subject}|${dateISO}|${cardText.slice(0, 120)}`;
    if (!seen.has(key)) {
      seen.set(key, { subject, dateISO, topics, toDo, attachments, rawExcerpt: cardText.slice(0, 400) });
    }
  }
}

/** Walks up from a "Date:" text node to the smallest ancestor that also
 * contains a plausible subject heading -- a generic "find the enclosing
 * card" without assuming a fixed DOM depth or class name. */
async function nearestCardContainer(dateLabelLocator) {
  for (let depth = 1; depth <= 6; depth++) {
    const ancestor = dateLabelLocator.locator(`xpath=ancestor::*[${depth}]`);
    const count = await ancestor.count().catch(() => 0);
    if (!count) continue;
    const text = (await ancestor.first().innerText().catch(() => "")) || "";
    // Heuristic: a real card is long enough to plausibly contain a subject
    // name plus the Date: line, but short enough not to be the whole feed
    // (which would swallow every card into one "container").
    if (text.length > 20 && text.length < 4000) {
      return ancestor.first();
    }
  }
  return null;
}

function parseEdsbyDate(cardText) {
  const match = cardText.match(/date:\s*([^\n]+)/i);
  if (!match) return null;
  const raw = match[1].trim();
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return karachiISODate(parsed);
  // Fallback: strip a leading weekday name Date.parse sometimes chokes on
  // in combination with other tokens (e.g. "Mon, Aug 25, 2026").
  const stripped = raw.replace(/^[A-Za-z]{3,9},?\s*/, "");
  const parsed2 = new Date(stripped);
  return Number.isNaN(parsed2.getTime()) ? null : karachiISODate(parsed2);
}

function extractSubject(cardText) {
  const firstLine = cardText.split("\n").map((l) => l.trim()).find(Boolean);
  return firstLine || "Unknown subject";
}

function extractSection(cardText, headingPattern) {
  const lines = cardText.split("\n");
  const startIdx = lines.findIndex((l) => headingPattern.test(l.trim()));
  if (startIdx === -1) return "";
  const rest = lines.slice(startIdx + 1);
  const stopIdx = rest.findIndex((l) => /^(topics covered|to ?do|date:|attachments?)/i.test(l.trim()));
  const body = stopIdx === -1 ? rest : rest.slice(0, stopIdx);
  return body.join(" ").trim();
}

async function extractAttachmentNames(card) {
  // Attachment cards typically show a filename with a recognizable
  // extension near a download affordance -- matched by text pattern rather
  // than a specific button class.
  const text = (await card.innerText().catch(() => "")) || "";
  const matches = text.match(/[\w .\-()]+\.(pdf|pptx?|docx?|jpg|jpeg|png)/gi) || [];
  return [...new Set(matches.map((m) => m.trim()))];
}

async function scrapeNotificationBell(page, todayISO) {
  const bell = page.getByRole("button", { name: /notifications?/i }).or(page.locator('[aria-label*="notification" i]'));
  if (!(await bell.count())) return [];
  await bell.first().click();
  await page.waitForTimeout(500);

  const dropdown = page.getByRole("list").filter({ hasText: /journal entry|posted|edited/i }).first();
  const text = (await dropdown.innerText().catch(() => "")) || "";
  if (!text) return [];

  // The bell dropdown is a lower-priority secondary source -- we only need
  // a coarse "did today show up here at all" signal, not full parsing.
  return text
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => parseEdsbyDate(`Date: ${line}`) === todayISO || new RegExp(todayISO).test(line));
}
