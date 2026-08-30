import { config } from "./config.js";
import { karachiISODate } from "./karachiTime.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";

async function apiFetch(url, options = {}, label = "Gmail API request") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(`${label} failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`${label} timed out after 20 seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: config.gmail.clientId,
    client_secret: config.gmail.clientSecret,
    refresh_token: config.gmail.refreshToken,
    grant_type: "refresh_token",
  });
  const result = await apiFetch(
    TOKEN_URL,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    "Gmail OAuth refresh"
  );
  if (!result.access_token) throw new Error("Gmail OAuth refresh returned no access token");
  return result.access_token;
}

function dayStartSeconds(isoDate) {
  return Math.floor(Date.parse(`${isoDate}T00:00:00+05:00`) / 1000);
}

function nextDay(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function header(message, name) {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function cleanText(value, maxLength = 500) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function senderEmail(sender) {
  const bracketed = String(sender || "").match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = String(sender || "").match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return (bracketed?.[1] || bare?.[0] || "").toLowerCase();
}

function senderDomain(sender) {
  return senderEmail(sender).split("@")[1] || "";
}

export function isAllowedSchoolSender(sender, allowedDomains) {
  const domain = senderDomain(sender);
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

export function parseEdsbyNotificationSubject(subject) {
  const match = cleanText(subject, 240).match(/^Edsby Notification:\s*(.+?)\s+in\s+(.+)$/i);
  return match ? { teacher: match[1].trim(), course: match[2].trim() } : { teacher: "", course: "" };
}

function edsbyUpdateType(snippet) {
  const match = cleanText(snippet, 800).match(/\b(made a new post|posted a journal entry|posted an assignment|updated a post|posted)\b/i);
  if (!match) return "New Edsby update — open Edsby for the complete details.";
  const label = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  return `${label} — open Edsby for the complete details.`;
}

export function cleanSchoolSnippet(snippet, { isEdsbyNotification = false } = {}) {
  if (isEdsbyNotification) return edsbyUpdateType(snippet);
  const withoutFooter = String(snippet || "").split(
    /Click here to view this notification in Edsby|To Log in to Edsby|Your Edsby server address is:|Unsubscribe|View this email in your browser/i
  )[0];
  return cleanText(withoutFooter, 500)
    .replace(/^Hi\s+[^,]{1,80},\s*/i, "")
    .replace(/^Dear\s+(Parents?|Parents?\s*\/\s*Guardians?|Guardians?),?\s*/i, "")
    .trim();
}

export function gmailMessageToCard(message) {
  const subject = cleanText(header(message, "Subject"), 180) || "School email";
  const sender = cleanText(header(message, "From"), 180) || "Unknown sender";
  const parsedEdsby = parseEdsbyNotificationSubject(subject);
  const isEdsbyNotification = Boolean(parsedEdsby.course);
  const timestamp = Number(message.internalDate);
  const receivedAt = Number.isFinite(timestamp) ? new Date(timestamp) : new Date(header(message, "Date"));
  if (Number.isNaN(receivedAt.getTime())) throw new Error(`Gmail message ${message.id} has no valid date`);
  return {
    source: "gmail",
    sourceId: message.id,
    subject,
    sender,
    senderEmail: senderEmail(sender),
    teacher: parsedEdsby.teacher,
    course: parsedEdsby.course,
    updateType: isEdsbyNotification ? edsbyUpdateType(message.snippet) : "",
    topics: "",
    toDo: cleanSchoolSnippet(message.snippet, { isEdsbyNotification }),
    attachments: [],
    dateISO: karachiISODate(receivedAt),
    receivedAt: receivedAt.toISOString(),
    url: `https://mail.google.com/mail/u/0/#all/${message.id}`,
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function fetchSchoolEmails({ fromISO, toISO }) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const profile = await apiFetch(`${API_ROOT}/profile`, { headers }, "Gmail profile check");
  if (profile.emailAddress?.toLowerCase() !== config.gmail.accountEmail.toLowerCase()) {
    throw new Error("Gmail OAuth token belongs to a different account than GMAIL_ACCOUNT_EMAIL");
  }

  const query = `${config.gmail.query} after:${dayStartSeconds(fromISO)} before:${dayStartSeconds(nextDay(toISO))}`;
  const listUrl = new URL(`${API_ROOT}/messages`);
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("maxResults", String(config.gmail.maxMessages));
  const listing = await apiFetch(listUrl, { headers }, "Gmail message search");
  const ids = listing.messages || [];

  const messages = await mapLimit(ids, 5, async ({ id }) => {
    const url = new URL(`${API_ROOT}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "metadata");
    for (const name of ["Subject", "From", "Date"]) url.searchParams.append("metadataHeaders", name);
    return apiFetch(url, { headers }, `Gmail message ${id}`);
  });

  return messages
    .map(gmailMessageToCard)
    .filter((card) => isAllowedSchoolSender(card.sender, config.gmail.schoolDomains))
    .filter((card) => card.dateISO >= fromISO && card.dateISO <= toISO)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .map((card, sequence) => ({ ...card, sequence }));
}
