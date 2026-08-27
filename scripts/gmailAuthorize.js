import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET?.trim();
const PORT = Number(process.env.GMAIL_OAUTH_PORT || 53682);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET locally before running this helper.");
  process.exit(1);
}

for (const check of [["--version"], ["auth", "status"], ["repo", "view"]]) {
  const result = spawnSync("gh", check, { stdio: "ignore", shell: false });
  if (result.status !== 0) {
    console.error("GitHub CLI must be installed, authenticated, and run inside the target repository.");
    process.exit(1);
  }
}

const state = randomBytes(24).toString("hex");
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.readonly");
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", state);

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, REDIRECT_URI);
  if (requestUrl.pathname !== "/oauth2callback") {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    if (requestUrl.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
    const code = requestUrl.searchParams.get("code");
    if (!code) throw new Error(requestUrl.searchParams.get("error") || "Google returned no authorization code");

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.refresh_token || !token.access_token) throw new Error("Google did not return the required OAuth tokens");

    const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.emailAddress) throw new Error("Could not verify the Gmail profile");

    setSecret("GMAIL_REFRESH_TOKEN", token.refresh_token);
    setSecret("GMAIL_ACCOUNT_EMAIL", profile.emailAddress);
    const variable = spawnSync("gh", ["variable", "set", "GMAIL_ENABLED", "--body", "true"], { stdio: "ignore", shell: false });
    if (variable.status !== 0) throw new Error("Could not enable the GMAIL_ENABLED repository variable");

    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Gmail read-only access is connected. You can close this tab.");
    console.log(`Connected and verified ${profile.emailAddress}. OAuth tokens were sent directly to GitHub Secrets and were not printed or saved locally.`);
  } catch (error) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Gmail connection failed. Return to the terminal for the non-sensitive error message.");
    console.error(`Gmail connection failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

function setSecret(name, value) {
  const result = spawnSync("gh", ["secret", "set", name], { input: value, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"], shell: false });
  if (result.status !== 0) throw new Error(`Could not save ${name} to GitHub Secrets`);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this Google authorization URL in your browser:");
  console.log(authUrl.href);
  console.log("Only read-only Gmail access is requested. Waiting for the local callback…");
});
