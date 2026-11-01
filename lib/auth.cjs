const crypto = require("node:crypto");
const http = require("node:http");
class Auth {
  constructor(vault, openBrowser, fetcher = fetch) {
    this.vault = vault;
    this.open = openBrowser;
    this.fetch = fetcher;
    this.connecting = false;
  }
  importClient(text) {
    const c = JSON.parse(text).installed;
    if (
      !c ||
      !/\.apps\.googleusercontent\.com$/.test(c.client_id || "") ||
      !c.client_secret
    )
      throw Error("Choose the Google OAuth JSON for a Desktop app.");
    this.vault.set("client", {
      client_id: c.client_id,
      client_secret: c.client_secret,
    });
  }
  async tokenRequest(params) {
    let response;
    try {
      response = await this.fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw Error("Cannot reach Google. Check your internet connection.");
    }
    const data = await response.json();
    if (!response.ok) {
      if (data.error === "invalid_grant") {
        this.vault.set("tokens", null);
        throw Error(
          "Google authorization expired or was revoked. Connect YouTube again.",
        );
      }
      throw Error(
        "Google authorization failed. Check your Desktop app setup and reconnect.",
      );
    }
    return data;
  }
  async access() {
    const t = this.vault.get("tokens");
    const c = this.vault.get("client");
    if (!t || !c) throw Error("Connect your YouTube channel first.");
    if (t.expires > Date.now() + 60000) return t.access_token;
    if (!t.refresh_token) throw Error("Connect YouTube again to renew access.");
    const fresh = await this.tokenRequest({
      ...c,
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
    });
    this.vault.set("tokens", {
      ...t,
      ...fresh,
      expires: Date.now() + fresh.expires_in * 1000,
    });
    return fresh.access_token;
  }
  async connect(loginHint = "") {
    if (this.connecting)
      throw Error("Finish the sign-in already open in your browser.");
    const client = this.vault.get("client");
    if (!client) throw Error("Import your Google Desktop app JSON first.");
    this.connecting = true;
    const verifier = crypto.randomBytes(48).toString("base64url");
    const state = crypto.randomBytes(32).toString("base64url");
    let server, timer;
    try {
      const codePromise = new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const url = new URL(req.url, "http://127.0.0.1");
          if (
            url.pathname !== "/callback" ||
            url.searchParams.get("state") !== state
          ) {
            res.writeHead(400);
            res.end("Invalid sign-in response.");
            return;
          }
          if (!url.searchParams.get("code")) {
            res.end("Sign-in cancelled. Return to Shorts Scheduler.");
            reject(Error("Google sign-in was cancelled."));
            return;
          }
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            "<h1>YouTube connected</h1><p>You can close this tab and return to Shorts Scheduler.</p>",
          );
          resolve(url.searchParams.get("code"));
        });
        server.on("error", () =>
          reject(Error("Cannot open the local Google sign-in callback.")),
        );
        timer = setTimeout(
          () => reject(Error("Sign-in timed out. Try Connect YouTube again.")),
          180000,
        );
      });
      // Attach immediately so a server failure cannot become an unhandled rejection.
      codePromise.catch(() => {});
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const redirect = `http://127.0.0.1:${server.address().port}/callback`;
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/youtube.force-ssl",
        access_type: "offline",
        prompt: "select_account consent",
        ...(loginHint ? { login_hint: loginHint } : {}),
        state,
        code_challenge: crypto
          .createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      await this.open(url.toString());
      const code = await codePromise;
      const t = await this.tokenRequest({
        ...client,
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        grant_type: "authorization_code",
      });
      this.vault.set("tokens", {
        ...t,
        expires: Date.now() + t.expires_in * 1000,
      });
    } finally {
      clearTimeout(timer);
      server?.close();
      this.connecting = false;
    }
  }
}
module.exports = { Auth };
