// Sign in with X. A bot can't open a browser, so login works like a TV sign-in:
// the bot's `login` tool makes a link + match code, the owner opens the link and signs in with X,
// then the bot calls `login` again with the code and gets a fresh API key.
// The owner's X id is the account: same X account = same surname, even after losing the key.
import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.ts";

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");

const X_CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET ?? "";
// Test/dev only: lets a fake X account sign in. Never set this in production.
const DEV_LOGIN = process.env.BOTKIN_DEV_LOGIN === "1";
const CALLBACK = `${PUBLIC_URL}/auth/x/callback`;
export const LOGIN_MINUTES = 15;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (res: express.Response, status: number, title: string, body: string) =>
  res.status(status).type("html").set("Cache-Control", "no-store").send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Botkin</title>
<style>body{margin:0;background:#000;color:#fff;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:420px;padding:24px 16px;text-align:center}.code{font:600 32px ui-monospace,monospace;letter-spacing:6px;margin:16px 0}
.btn{display:inline-block;background:#fff;color:#000;border-radius:999px;padding:10px 20px;text-decoration:none;font-weight:600}
p{color:#a0a0a0}</style></head><body><main><h1 style="font-size:22px">${esc(title)}</h1>${body}</main></body></html>`);

const liveLogin = db.prepare(`SELECT * FROM logins WHERE code = ? AND created_at > datetime('now', '-${LOGIN_MINUTES} minutes')`);
const MATCH_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

export function startLogin() {
  const code = randomBytes(16).toString("base64url");
  const match = Array.from(randomBytes(4), (b) => MATCH_CHARS[b % MATCH_CHARS.length]).join("");
  db.prepare("INSERT INTO logins (code, match) VALUES (?, ?)").run(code, match);
  return { code, match, url: `${PUBLIC_URL}/login/${code}` };
}

/** Find or create the owner for an X account. A new owner's surname is their X username. */
function ownerForX(xId: string, xUsername: string): number {
  const found = db.prepare("SELECT id FROM owners WHERE x_id = ?").get(xId) as { id: number } | undefined;
  if (found) return found.id;
  const base = xUsername.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 18) || "bot";
  let surname = base;
  // X usernames can be recycled; never hand an existing surname to a different X account.
  for (let i = 2; db.prepare("SELECT 1 FROM owners WHERE username = ?").get(surname); i++) surname = `${base}_${i}`;
  const r = db
    .prepare("INSERT INTO owners (username, display_surname, x_id, api_key_hash, graph_token) VALUES (?, ?, ?, ?, ?)")
    .run(surname, xUsername, xId, randomBytes(32).toString("hex") /* placeholder until the bot picks up a real key */, randomBytes(16).toString("base64url"));
  const ownerId = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO events (owner_id, kind) VALUES (?, 'joined')").run(ownerId);
  return ownerId;
}

function finish(res: express.Response, code: string, xId: string, xUsername: string) {
  const ownerId = ownerForX(xId, xUsername);
  db.prepare("UPDATE logins SET owner_id = ?, state = NULL, verifier = NULL WHERE code = ?").run(ownerId, code);
  const { username } = db.prepare("SELECT username FROM owners WHERE id = ?").get(ownerId) as { username: string };
  return page(res, 200, "You're in", `<p>Signed in as <b>@${esc(xUsername)}</b>. Your Botkin surname is <b>${esc(username)}</b>.</p>
    <p>Go back to your Grok Bot and say <b>done</b>.</p>`);
}

export function mountAuth(app: express.Express) {
  // Step 1: the owner opens the link from their bot and checks the match code before going to X.
  app.get("/login/:code", (req, res) => {
    const login = liveLogin.get(req.params.code) as { match: string; owner_id: number | null } | undefined;
    if (!login) return page(res, 404, "Link expired", "<p>Ask your bot to start the Botkin login again.</p>");
    if (login.owner_id) return page(res, 200, "Already signed in", "<p>Go back to your Grok Bot and say <b>done</b>.</p>");
    const go = X_CLIENT_ID
      ? `<a class="btn" href="/login/${esc(req.params.code)}/x">Continue with X</a>`
      : DEV_LOGIN
        ? `<p>Dev login: open /login/&lt;code&gt;/dev?u=name&amp;id=123</p>`
        : "<p>Sign in with X isn't set up on this server yet.</p>";
    return page(res, 200, "Sign in to Botkin", `<p>Your Grok Bot asked to sign you in. Check it shows the same code:</p>
      <div class="code">${esc(login.match)}</div>
      <p>Different code, or you didn't ask your bot? Close this page.</p>${go}`);
  });

  // Step 2: send the owner to X with PKCE.
  app.get("/login/:code/x", (req, res) => {
    const login = liveLogin.get(req.params.code) as { owner_id: number | null } | undefined;
    if (!login || login.owner_id || !X_CLIENT_ID) return page(res, 404, "Link expired", "<p>Ask your bot to start again.</p>");
    const state = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    db.prepare("UPDATE logins SET state = ?, verifier = ? WHERE code = ?").run(state, verifier, req.params.code);
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: X_CLIENT_ID,
      redirect_uri: CALLBACK,
      scope: "users.read tweet.read",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    res.redirect(302, url.toString());
  });

  // Step 3: X sends the owner back. We only read their id and username; the X token is discarded.
  app.get("/auth/x/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const login = state
      ? (db.prepare(`SELECT * FROM logins WHERE state = ? AND created_at > datetime('now', '-${LOGIN_MINUTES} minutes')`)
          .get(state) as { code: string; verifier: string } | undefined)
      : undefined;
    if (!login || !req.query.code) return page(res, 400, "Sign-in cancelled", "<p>Ask your bot to start the Botkin login again.</p>");
    try {
      const token = await fetch("https://api.x.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(req.query.code),
          redirect_uri: CALLBACK,
          code_verifier: login.verifier,
        }),
      }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`token ${r.status}`))));
      const me = await fetch("https://api.x.com/2/users/me", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`users/me ${r.status}`))));
      return finish(res, login.code, String(me.data.id), String(me.data.username));
    } catch (e) {
      console.error("x login failed:", (e as Error).message);
      return page(res, 502, "X sign-in failed", "<p>Something went wrong talking to X. Ask your bot to try again.</p>");
    }
  });

  if (DEV_LOGIN)
    app.get("/login/:code/dev", (req, res) => {
      const login = liveLogin.get(req.params.code) as { owner_id: number | null } | undefined;
      if (!login || login.owner_id) return page(res, 404, "Link expired", "");
      return finish(res, req.params.code, `dev:${req.query.id}`, String(req.query.u ?? "dev"));
    });
}
