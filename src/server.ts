import express from "express";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { db } from "./db.ts";
import { buildServer, followers, graphFor, hashKey, network, PUBLIC_URL, type Owner } from "./tools.ts";

const app = express();
app.set("trust proxy", 1); // behind Railway's proxy: req.ip is the real client
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer", // dashboard URLs carry a secret token
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000",
  });
  next();
});

// Fixed-window rate limits per client IP, kept in memory (one instance is enough for now).
const hits = new Map<string, { n: number; reset: number }>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  return ++h.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
}, 60_000).unref();

app.use((req, res, next) => {
  if (limited(`all:${req.ip}`, 300, 60_000)) return res.status(429).json({ error: "rate_limited", hint: "slow down" });
  next();
});

const ownerByKey = db.prepare("SELECT id, username, graph_token FROM owners WHERE api_key_hash = ?");
const ownerByGraph = db.prepare("SELECT id, username, graph_token FROM owners WHERE graph_token = ?");

function ownerFrom(req: express.Request): Owner | null {
  const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return key ? ((ownerByKey.get(hashKey(key)) as Owner | undefined) ?? null) : null;
}

// Stateless Streamable HTTP: a fresh server + transport per request, identity from the bearer key.
app.post("/mcp", async (req, res) => {
  const server = buildServer(ownerFrom(req), { canSignup: () => !limited(`signup:${req.ip}`, 5, 60 * 60_000) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

const notAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

// Web UI: one small page. /u/:username is a public profile, /me/:token the owner's private dashboard.
const publicDir = new URL("../public/", import.meta.url).pathname;
const appHtml = readFileSync(publicDir + "index.html", "utf8").replaceAll("{{MCP_URL}}", `${PUBLIC_URL}/mcp`);
const sendApp = (_req: express.Request, res: express.Response) => res.type("html").send(appHtml);
app.get(["/", "/terms", "/u/:username", "/me/:token"], sendApp);
app.use(express.static(publicDir, { index: false, maxAge: "5m" }));
app.get("/g/:token", (req, res) => res.redirect(301, `/me/${req.params.token}`));

const ownerByName = db.prepare("SELECT id, username, graph_token, created_at FROM owners WHERE username = ?");
const botsOf = db.prepare("SELECT handle, bio FROM bots WHERE owner_id = ? ORDER BY id");

/** Public view: never includes trust levels. */
function publicProfile(owner: Owner & { created_at: string }) {
  const net = network(owner.id);
  const strip = (s: (typeof net)["followers"]) => ({
    humans: s.humans,
    agents: s.agents.map(({ my_level, ...a }) => a),
  });
  return {
    username: owner.username,
    joined: owner.created_at,
    bots: botsOf.all(owner.id),
    followers: strip(net.followers),
    following: strip(net.following),
  };
}

app.get("/api/profile/:username", (req, res) => {
  const owner = ownerByName.get(req.params.username.toLowerCase()) as (Owner & { created_at: string }) | undefined;
  if (!owner) return res.status(404).json({ error: "not found" });
  res.json(publicProfile(owner));
});

app.get("/api/me/:token", (req, res) => {
  const owner = ownerByGraph.get(req.params.token) as Owner | undefined;
  if (!owner) return res.status(404).json({ error: "not found" });
  const full = ownerByName.get(owner.username) as Owner & { created_at: string };
  const net = network(owner.id);
  res.set("Cache-Control", "no-store");
  res.json({ ...publicProfile(full), followers: net.followers, following: net.following, graph: graphFor(owner) });
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase().slice(0, 40);
  if (!q) return res.json([]);
  const rows = db
    .prepare(
      `SELECT o.id, o.username, group_concat(b.handle, ' ') bots FROM owners o JOIN bots b ON b.owner_id = o.id
       WHERE o.username LIKE ?1 OR b.handle LIKE ?1 GROUP BY o.id ORDER BY o.username LIMIT 20`,
    )
    .all(`%${q}%`) as { id: number; username: string; bots: string }[];
  res.json(rows.map((r) => ({ username: r.username, bots: r.bots.split(" "), ...followers(r.id) })));
});
app.get("/favicon.ico", (_req, res) => res.redirect(301, "/assets/favicon.svg"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Undelivered messages expire after 7 days; delivered ones are deleted in check_inbox.
const purge = () => db.prepare("DELETE FROM messages WHERE created_at < datetime('now', '-7 days')").run();
purge();
setInterval(purge, 60 * 60 * 1000).unref();

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`botkin on :${port}  (${PUBLIC_URL}/mcp)`));
