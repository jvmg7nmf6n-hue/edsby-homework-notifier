// Playwright-driven Edsby scraper. Edsby is a heavy SPA with a virtualized
// activity feed -- plain fetch/HTML scraping doesn't work (see README).
//
// HONEST LIMITATION, disclosed up front: the exact login form and activity-
// feed DOM were described from a manual browsing session, not captured live
// by this script's own author. Every selector below is written defensively
// (role/text-based Playwright locators, multiple fallback strategies, no
// brittle nth-child/class-name chains) per the project's own design
// constraint, but the FIRST real `dry_run` (see README's Testing section) is
// what actually validates them against the live site. Any selector that
// fails should throw a clear, specific error (never silently return empty
// data) so the ntfy failure alert names the real problem.

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
    await page.goto(config.edsby.baseUrl, { waitUntil: "domcontentloaded" });

    // Step 1: find and click into the login flow from the marketing/landing
    // page. Try several common phrasings -- "Login", "Log In", "Sign In".
    const loginEntry = page
      .getByRole("link", { name: /log ?in|sign ?in/i })
      .or(page.getByRole("button", { name: /log ?in|sign ?in/i }));
    if (await loginEntry.count()) {
      await loginEntry.first().click();
    }
    // else: some districts land directly on a login form with no separate
    // marketing page -- fall through and look for the form directly.

    await page.waitForLoadState("domcontentloaded");

    // Step 2: fill the email/username field. Edsby's own docs describe a
    // possible district/board picker BEFORE the credential form on some
    // instances -- if we see a district/board selector instead of a
    // credential field, this school's flow needs it, so handle it generically:
    // look for a select/combobox first, and if present, choose the option
    // that best matches "Headstart" before continuing.
    await maybeHandleDistrictPicker(page);

    const emailField = await findFirstVisible(page, [
      () => page.getByLabel(/e-?mail|username|user ?id/i),
      () => page.getByPlaceholder(/e-?mail|username/i),
      () => page.locator('input[type="email"]'),
      () => page.locator('input[name*="email" i], input[name*="user" i]'),
    ]);
    if (!emailField) {
      throw new EdsbySelectorError(
        "Could not find an email/username field on the Edsby login page -- the login form's structure has likely changed."
      );
    }
    await emailField.fill(config.edsby.email);

    // Some SSO-style flows require submitting the email first (a "Next"
    // button) before the password field even renders.
    const nextButton = page.getByRole("button", { name: /^next$|continue/i });
    if (await nextButton.count()) {
      await nextButton.first().click();
      await page.waitForLoadState("domcontentloaded");
    }

    const passwordField = await findFirstVisible(page, [
      () => page.getByLabel(/password/i),
      () => page.getByPlaceholder(/password/i),
      () => page.locator('input[type="password"]'),
    ]);
    if (!passwordField) {
      throw new EdsbySelectorError(
        "Could not find a password field on the Edsby login page (after filling email) -- the login flow's structure has likely changed, or it needs an extra step this script doesn't handle yet."
      );
    }
    await passwordField.fill(config.edsby.password);

    const submitButton = page
      .getByRole("button", { name: /log ?in|sign ?in|submit/i })
      .or(page.locator('button[type="submit"], input[type="submit"]'));
    if (await submitButton.count()) {
      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {}),
        submitButton.first().click(),
      ]);
    } else {
      // Fall back to submitting the form via Enter if no explicit button is found.
      await passwordField.press("Enter");
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }

    // Step 3: confirm we actually landed in an authenticated parent area --
    // Edsby parent URLs contain "/p/". If we're still on a login-looking
    // page (password field still visible), the credentials were rejected or
    // an unhandled extra step exists.
    const stillOnLogin = await page.locator('input[type="password"]').count();
    if (stillOnLogin > 0 && !/\/p\//.test(page.url())) {
      throw new EdsbySelectorError(
        "Login did not appear to succeed -- still on a page with a password field after submitting. Check EDSBY_EMAIL/EDSBY_PASSWORD secrets, or the login flow may have an extra step (MFA, district picker) this script doesn't handle."
      );
    }

    return { browser, context, page };
  } catch (err) {
    err.screenshotPath = await saveDiagnosticScreenshot(page, "login-failure");
    await browser.close().catch(() => {});
    throw err;
  }
}

async function maybeHandleDistrictPicker(page) {
  const picker = page.getByRole("combobox").or(page.locator("select"));
  if (!(await picker.count())) return;
  const el = picker.first();
  const visible = await el.isVisible().catch(() => false);
  if (!visible) return;
  try {
    await el.selectOption({ label: /headstart/i });
  } catch {
    // Not a real <select>, or no matching option -- likely wasn't a
    // district picker at all (could be an unrelated dropdown on the
    // landing page). Non-fatal: proceed and let the email-field lookup
    // below succeed or fail on its own merits.
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
