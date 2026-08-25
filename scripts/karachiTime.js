// Asia/Karachi is UTC+5 year-round (no DST) -- Intl's timeZone support handles
// this correctly regardless of what timezone the GitHub Actions runner itself
// is in, so we never need to hardcode a +5 offset by hand.

const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const WEEKDAY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Karachi",
  weekday: "long",
});

const PRETTY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Karachi",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** "YYYY-MM-DD" for the given instant (defaults to now), in Asia/Karachi. */
export function karachiISODate(date = new Date()) {
  return DATE_FMT.format(date); // en-CA locale formats as YYYY-MM-DD
}

/** e.g. "Monday" */
export function karachiWeekday(date = new Date()) {
  return WEEKDAY_FMT.format(date);
}

/** e.g. "Mon, Aug 25" */
export function karachiPretty(date = new Date()) {
  return PRETTY_FMT.format(date);
}

/** "YYYY-MM-DD" N days before the given date, still evaluated as a Karachi
 * calendar date (used to bound how far back the scraper needs to page). */
export function karachiISODateOffset(days, date = new Date()) {
  const iso = karachiISODate(date);
  const asUtc = new Date(`${iso}T00:00:00Z`);
  asUtc.setUTCDate(asUtc.getUTCDate() + days);
  return asUtc.toISOString().slice(0, 10);
}
