// Generates a single self-contained docs/index.html (no build step, no
// framework, no external requests at render time) from the persisted
// history. GitHub Pages serves docs/ directly.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadHistory, STATUS_OK, STATUS_NONE, STATUS_FAILED, STATUS_SKIPPED } from "./history.js";
import { config } from "./config.js";
import { karachiISODate, karachiISODateOffset, karachiPretty } from "./karachiTime.js";

const OUT_PATH = new URL("../docs/index.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Fixed, hand-picked palette -- each pair is (light bg, light text) tuned
// for AA contrast; dark-mode equivalents are derived via CSS variables, not
// a second hardcoded list, so the two modes never drift out of sync.
const SUBJECT_PALETTE = [
  "#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed",
  "#0891b2", "#c026d3", "#65a30d", "#e11d48", "#4f46e5",
];

function subjectColor(subject) {
  let hash = 0;
  for (let i = 0; i < subject.length; i++) hash = (hash * 31 + subject.charCodeAt(i)) >>> 0;
  return SUBJECT_PALETTE[hash % SUBJECT_PALETTE.length];
}

function fileBadge(filename) {
  const ext = (filename.match(/\.(\w+)$/)?.[1] || "file").toUpperCase();
  return `<span class="file-badge" title="${escapeHtml(filename)}">${escapeHtml(ext)}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderCard(card) {
  const color = subjectColor(card.subject);
  return `
    <article class="hw-card">
      <span class="subject-chip" style="--chip-color:${color}">${escapeHtml(card.subject)}</span>
      ${card.topics ? `<p class="hw-topics"><strong>Topics covered:</strong> ${escapeHtml(card.topics)}</p>` : ""}
      ${card.toDo ? `<p class="hw-todo"><strong>To do:</strong> ${escapeHtml(card.toDo)}</p>` : ""}
      ${
        card.attachments?.length
          ? `<div class="hw-attachments">${card.attachments.map(fileBadge).join("")}</div>`
          : ""
      }
    </article>`;
}

function renderToday(dayRecord) {
  if (!dayRecord) {
    return `
      <div class="empty-state">
        <span class="empty-icon" aria-hidden="true">&#8288;</span>
        <p>No data for this day (before this automation was set up, or a run didn't happen).</p>
      </div>`;
  }
  if (dayRecord.status === STATUS_FAILED) {
    return `
      <div class="empty-state empty-state--failed">
        <span class="empty-icon" aria-hidden="true">&#9888;</span>
        <p>Today's check failed to run.</p>
        ${dayRecord.error ? `<p class="empty-detail">${escapeHtml(dayRecord.error)}</p>` : ""}
      </div>`;
  }
  if (dayRecord.status === STATUS_SKIPPED) {
    return `
      <div class="empty-state">
        <span class="empty-icon" aria-hidden="true">&#128197;</span>
        <p>Sunday -- reminder-only day, no scrape performed.</p>
      </div>`;
  }
  if (!dayRecord.cards?.length) {
    return `
      <div class="empty-state">
        <span class="empty-icon" aria-hidden="true">&#127881;</span>
        <p>No homework posted today.</p>
      </div>`;
  }
  return `<div class="hw-grid">${dayRecord.cards.map(renderCard).join("")}</div>`;
}

function statusMeta(status) {
  switch (status) {
    case STATUS_OK:
      return { icon: "&#9989;", label: "Homework", cls: "day--ok" };
    case STATUS_NONE:
      return { icon: "&#8212;", label: "None", cls: "day--none" };
    case STATUS_FAILED:
      return { icon: "&#9888;", label: "Failed", cls: "day--failed" };
    case STATUS_SKIPPED:
      return { icon: "&#183;", label: "Sunday", cls: "day--skipped" };
    default:
      return { icon: "&#8288;", label: "No data", cls: "day--unknown" };
  }
}

function renderHistoryStrip(childHistory, todayISO) {
  const days = [];
  for (let i = config.dashboardHistoryDays - 1; i >= 0; i--) {
    const iso = karachiISODateOffset(-i, new Date(`${todayISO}T00:00:00Z`));
    days.push(iso);
  }
  return `
    <div class="history-strip">
      ${days
        .map((iso) => {
          const record = childHistory?.[iso];
          const meta = statusMeta(record?.status);
          const pretty = karachiPretty(new Date(`${iso}T00:00:00Z`));
          const count = record?.cards?.length || 0;
          return `
            <a class="history-day ${meta.cls}" href="#day-${iso}" title="${pretty}${count ? ` -- ${count} subject(s)` : ""}">
              <span class="history-icon" aria-hidden="true">${meta.icon}</span>
              <span class="history-date">${pretty}</span>
              <span class="history-label">${meta.label}</span>
            </a>`;
        })
        .join("")}
    </div>
    <div class="history-detail">
      ${days
        .slice()
        .reverse()
        .map((iso) => {
          const record = childHistory?.[iso];
          const pretty = karachiPretty(new Date(`${iso}T00:00:00Z`));
          return `
            <details id="day-${iso}" class="history-detail-item">
              <summary>${pretty}${record?.cards?.length ? ` (${record.cards.length})` : ""}</summary>
              ${renderToday(record)}
            </details>`;
        })
        .join("")}
    </div>`;
}

export async function generateDashboard() {
  const history = await loadHistory();
  const child = config.edsby.children[0];
  const todayISO = karachiISODate();
  const childHistory = history[child.id] || {};
  const todayRecord = childHistory[todayISO];

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(child.name)} -- Homework</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📚</text></svg>'
  )}" />
<style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <header class="site-header">
      <h1>${escapeHtml(child.name)}</h1>
      <p class="subtitle">Grade ${escapeHtml(child.grade)} &middot; last updated ${escapeHtml(karachiPretty())} (Asia/Karachi)</p>
    </header>

    <main>
      <section class="today-section">
        <h2>Today's homework</h2>
        ${renderToday(todayRecord)}
      </section>

      <section class="history-section">
        <h2>Last ${config.dashboardHistoryDays} days</h2>
        ${renderHistoryStrip(childHistory, todayISO)}
      </section>
    </main>

    <footer class="site-footer">
      <p><a href="${config.edsby.parentHomeUrl}" rel="noopener">Open Edsby</a></p>
      <p class="disclaimer">Unofficial personal automation, not affiliated with or endorsed by Edsby or the school.</p>
    </footer>
  </div>
</body>
</html>`;

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, html);
  return OUT_PATH;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f8fafc;
  --bg-elevated: #ffffff;
  --text: #0f172a;
  --text-muted: #64748b;
  --border: #e2e8f0;
  --accent: #2563eb;
  --ok-bg: #ecfdf5; --ok-text: #047857;
  --none-bg: #f1f5f9; --none-text: #64748b;
  --failed-bg: #fef2f2; --failed-text: #b91c1c;
  --skipped-bg: #f5f3ff; --skipped-text: #6d28d9;
  --radius: 12px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b1220;
    --bg-elevated: #131c2e;
    --text: #e2e8f0;
    --text-muted: #94a3b8;
    --border: #1e293b;
    --accent: #60a5fa;
    --ok-bg: #052e21; --ok-text: #34d399;
    --none-bg: #111827; --none-text: #94a3b8;
    --failed-bg: #2a0f0f; --failed-text: #f87171;
    --skipped-bg: #1c1531; --skipped-text: #a78bfa;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.55;
}
.page { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
.site-header { padding: 16px 0 24px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
.site-header h1 { margin: 0 0 4px; font-size: 1.6rem; }
.subtitle { margin: 0; color: var(--text-muted); font-size: 0.9rem; }
h2 { font-size: 1.1rem; margin: 0 0 12px; }
section { margin-bottom: 40px; }

.hw-grid { display: grid; gap: 12px; }
.hw-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}
.subject-chip {
  display: inline-block;
  font-size: 0.78rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  color: white;
  background: var(--chip-color);
  margin-bottom: 8px;
}
.hw-topics, .hw-todo { margin: 6px 0; font-size: 0.95rem; }
.hw-attachments { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
.file-badge {
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.03em;
  border: 1px solid var(--border); border-radius: 6px;
  padding: 2px 6px; color: var(--text-muted);
}

.empty-state {
  text-align: center;
  padding: 32px 16px;
  background: var(--bg-elevated);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
}
.empty-state--failed { border-color: var(--failed-text); color: var(--failed-text); }
.empty-icon { font-size: 1.8rem; display: block; margin-bottom: 8px; }
.empty-detail { font-size: 0.85rem; opacity: 0.85; }

.history-strip {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
}
.history-day {
  text-decoration: none;
  color: inherit;
  border-radius: 10px;
  padding: 8px 4px;
  text-align: center;
  font-size: 0.7rem;
  border: 1px solid var(--border);
}
.history-icon { display: block; font-size: 0.95rem; }
.history-date { display: block; color: var(--text-muted); margin-top: 2px; }
.history-label { display: block; font-weight: 600; margin-top: 1px; }
.day--ok { background: var(--ok-bg); color: var(--ok-text); }
.day--none { background: var(--none-bg); color: var(--none-text); }
.day--failed { background: var(--failed-bg); color: var(--failed-text); }
.day--skipped { background: var(--skipped-bg); color: var(--skipped-text); }
.day--unknown { opacity: 0.4; }

.history-detail { margin-top: 16px; }
.history-detail-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
  margin-bottom: 8px;
  background: var(--bg-elevated);
}
.history-detail-item summary { cursor: pointer; font-weight: 600; }
.history-detail-item .hw-grid { margin-top: 12px; }

.site-footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.85rem; }
.site-footer a { color: var(--accent); }
.disclaimer { font-size: 0.78rem; }

@media (max-width: 480px) {
  .history-strip { grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .history-day { font-size: 0.62rem; padding: 6px 2px; }
}
`;
