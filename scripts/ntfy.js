// Thin wrapper around a plain ntfy.sh POST. No SDK, no dependency -- ntfy's
// whole design point is "just POST to a URL."

import { config, isDryRun } from "./config.js";

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.clickUrl]
 * @param {"min"|"low"|"default"|"high"|"urgent"} [opts.priority]
 * @param {string[]} [opts.tags]
 * @param {boolean} [opts.alert] - true routes to the alerts topic instead of the main one
 */
export async function sendNtfy({ title, body, clickUrl, priority = "default", tags = [], alert = false }) {
  const topic = alert ? config.ntfy.alertsTopic : config.ntfy.topic;
  const url = `${config.ntfy.server}/${encodeURIComponent(topic)}`;

  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: encodeRfc2047IfNeeded(title),
    Priority: priority,
  };
  if (clickUrl) headers.Click = clickUrl;
  if (tags.length) headers.Tags = tags.join(",");

  if (isDryRun()) {
    console.log("=== DRY RUN: ntfy payload (NOT sent) ===");
    console.log("URL (topic redacted):", url.replace(topic, "<topic>"));
    console.log("Headers:", { ...headers, Title: title });
    console.log("Body:\n" + body);
    console.log("=========================================");
    return { dryRun: true };
  }

  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ntfy POST failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
  return { dryRun: false, status: res.status };
}

// ntfy's Title header must be ASCII-safe; non-ASCII (e.g. Urdu subject
// names could theoretically leak into a title) gets RFC 2047 encoded so the
// HTTP header itself never contains raw non-Latin1 bytes. The BODY has no
// such restriction and carries Urdu text as plain UTF-8 fine.
function encodeRfc2047IfNeeded(text) {
  if (/^[\x00-\xFF]*$/.test(text)) return text;
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

/** Convenience: send a failure alert with a consistent shape, used by run.js's
 * top-level catch so a broken selector/login never fails silently. */
export async function sendFailureAlert(error, context = "") {
  await sendNtfy({
    title: "Edsby check failed",
    body: [
      context && `Context: ${context}`,
      `Error: ${error?.message || String(error)}`,
      "",
      "No homework data was collected this run -- check the GitHub Actions log " +
        "(workflow artifacts may include a screenshot) for details.",
    ]
      .filter(Boolean)
      .join("\n"),
    priority: "high",
    tags: ["warning"],
    alert: true,
  });
}
