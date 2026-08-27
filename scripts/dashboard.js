import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { loadHistory } from "./history.js";
import { karachiISODate, karachiISODateOffset } from "./karachiTime.js";
import { encryptJson } from "./stateStore.js";

const OUT_PATH = new URL("../docs/index.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export async function buildDashboardPayload() {
  const history = await loadHistory();
  const todayISO = karachiISODate();
  const days = [];
  for (let i = config.dashboardHistoryDays - 1; i >= 0; i--) {
    days.push(karachiISODateOffset(-i, new Date(`${todayISO}T00:00:00Z`)));
  }
  return {
    version: 1,
    todayISO,
    generatedAt: new Date().toISOString(),
    days,
    parentHomeUrl: config.edsby.parentHomeUrl,
    children: config.edsby.children.map((child) => ({
      ...child,
      history: history[child.id] || {},
    })),
  };
}

export async function generateDashboard() {
  const encrypted = await encryptJson(await buildDashboardPayload());
  const safeEnvelope = JSON.stringify(encrypted).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow,noarchive" />
<title>Private School Monitor</title>
<style>${STYLES}</style>
</head>
<body>
  <main class="shell">
    <section id="unlock" class="unlock card">
      <div class="lock" aria-hidden="true">&#128274;</div>
      <h1>Private school monitor</h1>
      <p>This public page contains encrypted data only. Enter your dashboard key to decrypt it on this device.</p>
      <form id="unlock-form">
        <label for="passphrase">Dashboard key</label>
        <div class="unlock-row">
          <input id="passphrase" type="password" minlength="20" autocomplete="current-password" required />
          <button type="submit">Unlock</button>
        </div>
        <p id="unlock-error" class="error" role="alert"></p>
      </form>
    </section>
    <section id="app" hidden></section>
  </main>
<script>
const ENCRYPTED_PAYLOAD = ${safeEnvelope};
const text = (value) => document.createTextNode(String(value ?? ""));
const el = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.append(text(content));
  return node;
};
const b64 = (value) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

async function decrypt(passphrase) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(ENCRYPTED_PAYLOAD.salt), iterations: ENCRYPTED_PAYLOAD.iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const result = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(ENCRYPTED_PAYLOAD.iv) },
    key,
    b64(ENCRYPTED_PAYLOAD.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(result));
}

function pretty(iso) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "Asia/Karachi" })
    .format(new Date(iso + "T00:00:00Z"));
}

function statusLabel(record) {
  return ({ ok: "Updates", none: "None", partial: "Partial", failed: "Failed", skipped: "No check" })[record?.status] || "No data";
}

function cardView(card) {
  const article = el("article", "item card");
  const top = el("div", "item-top");
  top.append(el("span", "source source--" + card.source, card.source === "gmail" ? "Gmail" : "Edsby"));
  top.append(el("h3", "", card.subject));
  article.append(top);
  if (card.topics) article.append(el("p", "muted", card.topics));
  if (card.toDo) article.append(el("p", "todo", card.toDo));
  if (card.attachments?.length) article.append(el("p", "muted", "Attachments: " + card.attachments.join(", ")));
  if (card.url) {
    const link = el("a", "open-link", "Open source");
    link.href = card.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    article.append(link);
  }
  return article;
}

function dayView(iso, record, open = false) {
  const details = el("details", "day day--" + (record?.status || "unknown"));
  details.open = open;
  const summary = el("summary", "");
  summary.append(el("span", "day-date", pretty(iso)));
  summary.append(el("span", "day-status", statusLabel(record)));
  details.append(summary);
  const body = el("div", "day-body");
  if (!record) body.append(el("p", "muted", "No automation data for this date."));
  else if (record.cards?.length) record.cards.forEach(card => body.append(cardView(card)));
  else body.append(el("p", "muted", record.status === "failed" ? "The check failed." : "No matching items found."));
  if (record?.errors?.length) {
    const warning = el("div", "warning");
    warning.append(el("strong", "", "Source warning"));
    record.errors.forEach(error => warning.append(el("p", "", error)));
    body.append(warning);
  }
  details.append(body);
  return details;
}

function render(data) {
  const app = document.getElementById("app");
  app.replaceChildren();
  const header = el("header", "header");
  header.append(el("p", "eyebrow", "PRIVATE FAMILY VIEW"));
  header.append(el("h1", "", "School progress monitor"));
  header.append(el("p", "muted", "Updated " + new Date(data.generatedAt).toLocaleString()));
  app.append(header);
  data.children.forEach(child => {
    const section = el("section", "child-section");
    section.append(el("h2", "", child.name));
    section.append(el("p", "muted", "Grade " + child.grade));
    data.days.slice().reverse().forEach(iso => section.append(dayView(iso, child.history[iso], iso === data.todayISO)));
    app.append(section);
  });
  const footer = el("footer", "footer");
  const link = el("a", "", "Open Edsby");
  link.href = data.parentHomeUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  footer.append(link);
  footer.append(el("p", "muted", "Unofficial personal automation. Data is decrypted only in this browser tab."));
  app.append(footer);
  document.getElementById("unlock").hidden = true;
  app.hidden = false;
}

document.getElementById("unlock-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  const error = document.getElementById("unlock-error");
  button.disabled = true;
  button.textContent = "Unlocking…";
  error.textContent = "";
  try {
    render(await decrypt(document.getElementById("passphrase").value));
    document.getElementById("passphrase").value = "";
  } catch {
    error.textContent = "Could not decrypt. Check the dashboard key and try again.";
  } finally {
    button.disabled = false;
    button.textContent = "Unlock";
  }
});
</script>
</body>
</html>`;
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, html);
  return OUT_PATH;
}

const STYLES = `
:root { color-scheme: light dark; --bg:#f4f7fb; --panel:#fff; --text:#142033; --muted:#64748b; --line:#dbe4ef; --accent:#2563eb; --warn:#b45309; --radius:16px; }
@media(prefers-color-scheme:dark){:root{--bg:#08111f;--panel:#111c2e;--text:#e5edf7;--muted:#9aabc0;--line:#26364d;--accent:#7bb1ff;--warn:#fbbf24}}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.shell{width:min(780px,100%);margin:auto;padding:32px 16px 64px}.card,.day{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius)}
.unlock{max-width:560px;margin:10vh auto;padding:32px}.lock{font-size:2rem}.unlock h1{margin:.5rem 0}.unlock-row{display:flex;gap:10px;margin-top:8px}
label{font-weight:650}input{min-width:0;flex:1;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}button{padding:12px 18px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}button:disabled{opacity:.65}
.error{min-height:1.5em;color:#dc2626}.header{margin-bottom:32px}.header h1{margin:.2rem 0}.eyebrow{color:var(--accent);font-size:.75rem;font-weight:800;letter-spacing:.12em}.muted{color:var(--muted)}
.child-section{margin:36px 0}.child-section>h2{margin-bottom:0}.child-section>p{margin-top:2px}.day{margin:10px 0;overflow:hidden}.day summary{display:flex;justify-content:space-between;gap:12px;padding:14px 16px;cursor:pointer;font-weight:700}.day-status{color:var(--muted)}.day-body{padding:0 14px 14px}
.item{padding:14px;margin:10px 0}.item-top{display:flex;gap:10px;align-items:center}.item h3{margin:0;font-size:1rem}.source{font-size:.7rem;font-weight:800;text-transform:uppercase;padding:3px 7px;border-radius:999px;background:#dbeafe;color:#1d4ed8}.source--gmail{background:#fee2e2;color:#b91c1c}.todo{white-space:pre-wrap}.open-link,a{color:var(--accent)}
.warning{margin-top:12px;padding:12px;border-left:4px solid var(--warn);background:color-mix(in srgb,var(--warn) 10%,transparent)}.warning p{margin:.3rem 0}.footer{margin-top:40px;padding-top:18px;border-top:1px solid var(--line)}
@media(max-width:520px){.unlock{padding:24px}.unlock-row{flex-direction:column}.shell{padding-top:16px}.item-top{align-items:flex-start;flex-direction:column}}
`;
