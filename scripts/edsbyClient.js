// Playwright-driven Edsby scraper. Edsby is a heavy SPA with a virtualized
// activity feed -- plain fetch/HTML scraping doesn't work (see README).
//
// VERIFICATION STATUS, kept honest and current:
//   - loginToEdsby(): selectors LIVE-VERIFIED 2026-08-25 against a real
//     logged-out session on the configured Edsby tenant (see git history for the
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

// Diagnostics are opt-in and kept local. A screenshot can contain student
// names, assignments, and email addresses even when the password field itself
// is masked, so public-repository workflows must not upload it automatically.
async function saveDiagnosticScreenshot(page, label) {
  if (process.env.SAVE_DIAGNOSTICS !== "true" || !page || page.isClosed()) return null;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir("diagnostics", { recursive: true });
    const path = `diagnostics/${label}-${Date.now()}.png`;
    await page.locator('input[type="password"]').fill("").catch(() => {});
    await page.locator('input[name="login-userid"]').fill("<redacted>").catch(() => {});
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
    // configured Edsby tenant): navigating to the base URL redirects
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

    // Edsby is a heavy SPA (see module docstring) -- domcontentloaded fires
    // before the login form is necessarily hydrated/rendered. The FIRST
    // attempt at this fix used a custom findFirstVisible() helper whose
    // `.count()`/`.isVisible()` checks are synchronous snapshots with no
    // retry, so it gave up immediately if the form hadn't rendered yet by
    // that exact millisecond -- confirmed as the real cause of a second
    // real failed run (same error, even with the correct selector), not a
    // wrong-selector problem. Fixed by using a single combined locator
    // (`.or()`) and Playwright's own real auto-waiting `.waitFor()`/`.fill()`
    // (which retry internally up to ACTION_TIMEOUT_MS), never a manual
    // one-shot check.

    // Username field: type="text", placeholder="Username" (labeled
    // "Username" even though an email address is what's actually typed in),
    // name="login-userid". Its `id` has a numeric prefix regenerated per
    // page load (e.g. "2loginform-login-userid__f__") -- never select by id.
    const usernameField = page.getByPlaceholder("Username").or(page.locator('input[name="login-userid"]'));
    try {
      await usernameField.first().waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS });
    } catch {
      throw new EdsbySelectorError(
        "Could not find the Username field on the Edsby login page (waited " +
          `${NAV_TIMEOUT_MS}ms) -- the login form's structure has likely changed from what was live-verified on 2026-08-25.`
      );
    }
    await usernameField.first().fill(config.edsby.email);

    // Password field: type="password", placeholder="Password", `name` is
    // empty on this field (confirmed) -- select by placeholder/type only,
    // never by name.
    const passwordField = page.getByPlaceholder("Password").or(page.locator('input[type="password"]'));
    try {
      await passwordField.first().waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    } catch {
      throw new EdsbySelectorError(
        "Could not find the Password field on the Edsby login page -- the login form's structure has likely changed from what was live-verified on 2026-08-25."
      );
    }
    await passwordField.first().fill(config.edsby.password);

    // Submit is a real <input type="submit"> (id has the same unstable
    // numeric-prefix issue as the username field's id, so it's deliberately
    // not used here), not a <button> -- select by type, not by role/name
    // (a role-based name match risks the same "Log in using Google" link
    // collision the earlier landing-page step hit).
    const submitButton = page.locator('input[type="submit"]');
    try {
      await submitButton.first().waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    } catch {
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
      const wrapped = new EdsbySelectorError(
        `Login form was submitted but the page never navigated to /p/BaseParent/... (stayed at ${urlAtFailure}) -- ` +
          "check EDSBY_EMAIL/EDSBY_PASSWORD secrets are correct, or the login flow may have changed."
      );
      wrapped.screenshotPath = err.screenshotPath;
      throw wrapped;
    }
    throw err;
  }
}

/** Navigates to a specific child's dashboard and returns every activity-feed
 * card whose Date: field falls within [todayISO - lookbackBufferDays, today].
 * Cross-checks the notifications bell as a secondary source. Thin wrapper
 * around scrapeChildHomeworkRange (the daily job's own "just today" case) --
 * see that function for a card whose Date: falls anywhere in an arbitrary
 * range, e.g. for a one-off historical digest. */
export async function scrapeChildHomework(page, child, { maxShowOlderClicks, lookbackBufferDays }) {
  const todayISO = karachiISODate();
  const result = await scrapeChildHomeworkRange(page, child, {
    fromISO: todayISO,
    toISO: todayISO,
    maxShowOlderClicks,
    lookbackBufferDays,
  });
  return {
    todaysCards: result.cards,
    bellCrossCheck: result.bellCrossCheck,
    cardsScanned: result.cardsScanned,
    showOlderClicks: result.showOlderClicks,
  };
}

/** Navigates to a specific child's dashboard and returns every activity-feed
 * card whose Date: field falls within [fromISO, toISO] (inclusive both
 * ends). Pages back ("Show Older Posts") until the oldest card seen so far
 * is at or before `fromISO` minus `lookbackBufferDays` of extra buffer (the
 * feed is post-time ordered, not lesson-date ordered, so a small buffer past
 * the requested range's own start is needed to be confident nothing in
 * range was missed), or until `maxShowOlderClicks` is hit. Cross-checks the
 * notifications bell as a secondary source (today's date only -- the bell
 * dropdown doesn't meaningfully page back further). */
export async function scrapeChildHomeworkRange(page, child, { fromISO, toISO, maxShowOlderClicks, lookbackBufferDays }) {
  try {
    await page.goto(child.dashboardUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});

    const feedHeading = page.getByText(/recent activity/i).first();
    await feedHeading.waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS }).catch(() => {
      throw new EdsbySelectorError(
        `Could not find the "Recent Activity" feed on ${child.dashboardUrl} -- the child dashboard's layout may have changed, or the login session didn't carry over.`
      );
    });

    const cutoffISO = karachiISODate(new Date(`${fromISO}T00:00:00Z`).getTime() - lookbackBufferDays * 86_400_000);

    const seen = new Map(); // dedupe key -> card
    let oldestSeenISO = toISO;
    let clicks = 0;
    let olderButtonEverFound = false;

    while (clicks < maxShowOlderClicks) {
      await collectVisibleCards(page, seen);

      const oldest = [...seen.values()]
        .map((c) => c.dateISO)
        .filter(Boolean)
        .sort()[0];
      if (oldest) oldestSeenISO = oldest;

      if (oldestSeenISO && oldestSeenISO <= cutoffISO) break;

      // NOT live-verified (unlike the login form -- see loginToEdsby's own
      // note) -- this text pattern is a guess. Widened to a few plausible
      // phrasings and to both button/link roles, and the outcome of this
      // FIRST attempt is logged unconditionally below so a caller can tell
      // "no more real posts exist" apart from "this selector never matched
      // anything" -- never trust a silent 0-clicks result.
      const olderButton = page
        .getByRole("button", { name: /show (older|more)( posts?)?/i })
        .or(page.getByRole("link", { name: /show (older|more)( posts?)?/i }))
        .or(page.getByText(/show (older|more)( posts?)?/i));
      const hasMore = await olderButton.count();
      if (clicks === 0) {
        console.log(
          `[scrapeChildHomeworkRange] "Show Older Posts"-style control ${hasMore ? "FOUND" : "NOT FOUND"} on first page load (matched ${hasMore} element(s)).`
        );
      }
      if (!hasMore) break;
      olderButtonEverFound = true;
      const visible = await olderButton.first().isVisible().catch(() => false);
      if (!visible) break;

      const previousTail = await page.locator("body").innerText().then((text) => text.slice(-600)).catch(() => "");
      await olderButton.first().click();
      await page
        .waitForFunction(
          (tail) => (document.body?.innerText || "").slice(-600) !== tail,
          previousTail,
          { timeout: 3_000 }
        )
        .catch(() => {});
      await page.waitForTimeout(100);
      clicks++;
    }
    if (!olderButtonEverFound && clicks === 0) {
      console.log(
        "[scrapeChildHomeworkRange] Never found a pagination control -- either the feed genuinely has no more posts to load, or the button text/selector doesn't match Edsby's real markup. Cannot currently tell these apart from here."
      );
    }

    const allCards = [...seen.values()];
    const cards = allCards
      .filter((c) => c.dateISO && c.dateISO >= fromISO && c.dateISO <= toISO)
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO));

    const todayISO = karachiISODate();
    const bellCards =
      toISO >= todayISO
        ? await scrapeNotificationBell(page, todayISO).catch((err) => {
            console.warn(`Notification-bell cross-check failed (non-fatal): ${err.message}`);
            return [];
          })
        : [];

    // allCards is returned unfiltered/unsorted alongside the range-filtered
    // `cards` specifically so a caller can log/inspect exactly what was
    // scanned (subject, raw Date: text, parsed dateISO) for diagnosing a
    // suspiciously-empty range result -- never trust a silent "0 in range"
    // without being able to see what the scan actually found.
    return { cards, allCards, bellCrossCheck: bellCards, cardsScanned: seen.size, showOlderClicks: clicks };
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
    const rawDateText = extractRawDateText(cardText);
    const dateISO = parseEdsbyDate(cardText);
    const metadata = extractEdsbyMetadata(cardText);
    const subject = metadata.course || "Unknown subject";
    const topics = extractSection(cardText, /topics covered/i);
    const toDo = extractSection(cardText, /to ?do/i);
    const attachments = await extractAttachmentNames(card);

    const key = `${subject}|${dateISO}|${cardText.slice(0, 120)}`;
    if (!seen.has(key)) {
      seen.set(key, {
        source: "edsby",
        subject,
        course: metadata.course,
        teacher: metadata.teacher,
        sequence: seen.size,
        dateISO,
        rawDateText,
        topics,
        toDo,
        attachments: attachments.sort(),
        rawExcerpt: cardText.slice(0, 400),
      });
    }
  }
}

/** Walks up from a "Date:" text node to the smallest ancestor that also
 * contains a plausible subject heading -- a generic "find the enclosing
 * card" without assuming a fixed DOM depth or class name. */
async function nearestCardContainer(dateLabelLocator) {
  let fallback = null;
  for (let depth = 1; depth <= 10; depth++) {
    const ancestor = dateLabelLocator.locator(`xpath=ancestor::*[${depth}]`);
    const count = await ancestor.count().catch(() => 0);
    if (!count) continue;
    const text = (await ancestor.first().innerText().catch(() => "")) || "";
    // Heuristic: a real card is long enough to plausibly contain a subject
    // name plus the Date: line, but short enough not to be the whole feed
    // (which would swallow every card into one "container").
    if (text.length > 20 && text.length < 8000) {
      const dateCount = await ancestor.first().getByText(/^date:/i).count().catch(() => 0);
      if (dateCount !== 1) continue;
      fallback ||= ancestor.first();
      if (extractEdsbyMetadata(text).course) return ancestor.first();
    }
  }
  return fallback;
}

function extractRawDateText(cardText) {
  const match = cardText.match(/date:\s*([^\n]+)/i);
  return match ? match[1].trim() : null;
}

// REAL BUG FOUND live 2026-08-25 (backfill diagnostic dump): Edsby's real
// Date: field omits the year for recent dates ("Aug 25", confirmed via raw
// rawDateText logging), and `new Date("Aug 25")` silently parses that as
// year 2001 in this runtime -- not the current year. Every date comparison
// downstream (the daily "is this today's date" check, and the backfill
// range filter) was therefore silently excluding EVERY real card with a
// year-less date, which is apparently Edsby's convention for anything
// recent -- meaning every "no homework today" push sent before this fix
// landed was very likely wrong, not a genuine empty result. Fixed by
// explicitly inferring the year: try the current Karachi year first: if
// that lands more than 2 days in the future (a real post/lesson date should
// never be meaningfully after "now"), fall back to the previous year
// instead, so a year-less date encountered deep in the feed's history isn't
// silently mis-stamped onto the current year either.
export function parseEdsbyDate(cardText, now = new Date()) {
  const raw = extractRawDateText(cardText);
  if (raw === null) return null;
  if (/\b\d{4}\b/.test(raw)) {
    // Explicit year present -- trust it directly, same as before.
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return karachiISODate(parsed);
    // Fallback: strip a leading weekday name Date.parse sometimes chokes on
    // in combination with other tokens (e.g. "Mon, Aug 25, 2026").
    const stripped = raw.replace(/^[A-Za-z]{3,9},?\s*/, "");
    const parsed2 = new Date(stripped);
    return Number.isNaN(parsed2.getTime()) ? null : karachiISODate(parsed2);
  }

  const currentYear = Number(karachiISODate(now).slice(0, 4));
  let firstParseAttempted = null;
  for (const year of [currentYear, currentYear - 1]) {
    const parsed = new Date(`${raw} ${year}`);
    if (Number.isNaN(parsed.getTime())) continue;
    if (firstParseAttempted === null) firstParseAttempted = parsed;
    const daysInFuture = (parsed.getTime() - now.getTime()) / 86_400_000;
    if (daysInFuture < 2) return karachiISODate(parsed);
  }
  // Both years either failed to parse or landed implausibly in the future --
  // return the current-year attempt anyway if it at least parsed (a real
  // card is better surfaced with a possibly-off-by-one-year date than
  // silently dropped), never fabricate a date for genuinely unparseable text.
  return firstParseAttempted ? karachiISODate(firstParseAttempted) : null;
}

// REAL BUG FOUND live 2026-08-25 (backfill diagnostic dump): every scanned
// card's "subject" came back as the literal string "Topics Covered" -- the
// section-header label, not the real course name (e.g. "7-K Mathematics").
// This means nearestCardContainer's chosen ancestor apparently starts AT or
// AFTER that label, i.e. the real subject heading lives outside the
// container this scraper currently selects (still unconfirmed exactly
// where -- no live DOM access at the time of this fix, see module
// docstring). This fix does NOT solve that positioning problem (would need
// live inspection to do properly); it narrows the damage by refusing to
// silently mislabel a known SECTION heading as if it were the subject, so a
// wrong guess is at least visibly "Unknown subject" rather than a
// plausible-looking wrong answer. Re-check with the diagnostic logging in
// backfill.js after this fix -- if "Unknown subject" shows up often, the
// container-selection heuristic itself needs live-verified adjustment.
const KNOWN_SECTION_HEADERS = /^(topics covered|to ?do|date:|attachments?)\b/i;
const TEACHER_PATTERN = /\b(Ms\.?|Mrs\.?|Mr\.?|Miss|Sir)\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}\b/;
const COURSE_PATTERN = /\b\d{1,2}\s*[-–]\s*[A-Z]\b\s*[-–:]?\s*[A-Za-z][A-Za-z &/-]{2,80}/i;

export function extractEdsbyMetadata(cardText) {
  const lines = String(cardText || "").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const teacher = lines.map((line) => line.match(TEACHER_PATTERN)?.[0] || "").find(Boolean) || "";
  const directCourse = lines.map((line) => line.match(COURSE_PATTERN)?.[0] || "").find(Boolean) || "";
  if (directCourse) return { course: directCourse.trim(), teacher };

  const firstSection = lines.findIndex((line) => KNOWN_SECTION_HEADERS.test(line));
  const headingLines = firstSection >= 0 ? lines.slice(0, firstSection) : lines.slice(0, 5);
  const course = headingLines
    .filter((line) => !TEACHER_PATTERN.test(line))
    .filter((line) => !/^(recent activity|posted|journal entry|assignment)$/i.test(line))
    .filter((line) => line.length >= 3 && line.length <= 120)
    .at(-1) || "";
  return { course, teacher };
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
