import express from "express";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mountAuth } from "./auth.ts";
import { db } from "./db.ts";
import { activity, buildServer, connections, graphFor, hashKey, network, PUBLIC_URL, type Owner } from "./tools.ts";

const app = express();
app.set("trust proxy", 1); // behind Railway's proxy: req.ip is the real client
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net/npm/force-graph@1.51.5/dist/force-graph.min.js; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
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

// Bots call from their platform's shared IPs, so the per-IP limit is loose; the real limit is per account below.
app.use((req, res, next) => {
  if (limited(`all:${req.ip}`, 1200, 60_000)) return res.status(429).json({ error: "rate_limited", hint: "slow down" });
  next();
});

const ownerByKey = db.prepare("SELECT id, username, display_surname, graph_token FROM owners WHERE api_key_hash = ?");
const ownerByGraph = db.prepare("SELECT id, username, display_surname, graph_token FROM owners WHERE graph_token = ?");

function ownerFrom(req: express.Request): Owner | null {
  const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return key ? ((ownerByKey.get(hashKey(key)) as Owner | undefined) ?? null) : null;
}

// Stateless Streamable HTTP: a fresh server + transport per request, identity from the bearer key.
app.post("/mcp", async (req, res) => {
  const owner = ownerFrom(req);
  if (owner && limited(`owner:${owner.id}`, 240, 60_000))
    return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "rate_limited: this account is calling too fast, wait a minute" }, id: null });
  const server = buildServer(owner, { canSignup: () => !limited(`login:${req.ip}`, 30, 60 * 60_000) });
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

mountAuth(app);

// Web UI: one small page. /u/:username is a public profile, /me/:token the owner's private dashboard.
const publicDir = new URL("../public/", import.meta.url).pathname;
const appHtml = readFileSync(publicDir + "index.html", "utf8").replaceAll("{{MCP_URL}}", `${PUBLIC_URL}/mcp`);
const sendApp = (_req: express.Request, res: express.Response) => res.type("html").send(appHtml);
app.get(["/", "/terms", "/u/:username", "/me/:token"], sendApp);
app.use(express.static(publicDir, { index: false, maxAge: "5m" }));
app.get("/g/:token", (req, res) => res.redirect(301, `/me/${req.params.token}`));

const ownerByName = db.prepare("SELECT id, username, display_surname, graph_token, created_at FROM owners WHERE username = ?");
const botsOf = db.prepare("SELECT handle, bio, public FROM bots WHERE owner_id = ? ORDER BY id");

type Net = ReturnType<typeof network>;
/** Public view of connected bots: no trust levels, private bot names hidden. */
const masked = (bots: Net["bots"]) =>
  bots.map(({ my_level, ...b }) => (b.public ? b : { ...b, handle: null, bio: "" }));

/** Public view: no trust levels, no private bot names. */
function publicProfile(owner: Owner & { created_at: string }) {
  const net = network(owner.id);
  const bots = botsOf.all(owner.id) as { handle: string; bio: string; public: number }[];
  return {
    username: owner.username,
    display_surname: owner.display_surname,
    joined: owner.created_at,
    bots: bots.filter((b) => b.public).map(({ handle, bio }) => ({ handle, bio })),
    private_bots: bots.filter((b) => !b.public).length,
    connections: { humans: net.humans, bots: masked(net.bots) },
    activity: activity(owner.id, false),
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
  res.json({
    ...publicProfile(full),
    bots: botsOf.all(owner.id),
    private_bots: 0,
    // Your connections and the bots asking to connect are known to you, so names are shown.
    connections: { humans: net.humans, bots: net.bots },
    requests: net.requests,
    activity: activity(owner.id, true),
    graph: graphFor(owner),
  });
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase().slice(0, 40);
  if (!q) return res.json([]);
  const rows = db
    .prepare(
      `SELECT o.id, o.username, o.display_surname, group_concat(CASE WHEN b.public THEN b.handle END, ' ') bots
       FROM owners o JOIN bots b ON b.owner_id = o.id
       WHERE o.username LIKE ?1 OR (b.public AND b.handle LIKE ?1) GROUP BY o.id ORDER BY o.username LIMIT 20`,
    )
    .all(`%${q}%`) as { id: number; username: string; display_surname: string | null; bots: string | null }[];
  res.json(rows.map((r) => ({ username: r.username, display_surname: r.display_surname, bots: r.bots ? r.bots.split(" ") : [], ...connections(r.id) })));
});
app.get("/favicon.ico", (_req, res) => res.redirect(301, "/assets/favicon.svg"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Messages expire after 7 days (delivered ones already lost their body in check_inbox and are only kept as receipts).
// Activity older than 90 days is dropped.
const purge = () => {
  db.prepare("DELETE FROM messages WHERE created_at < datetime('now', '-7 days')").run();
  db.prepare("DELETE FROM events WHERE created_at < datetime('now', '-90 days')").run();
  db.prepare("DELETE FROM logins WHERE created_at < datetime('now', '-1 hour')").run();
};
purge();
setInterval(purge, 60 * 60 * 1000).unref();

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`botkin on :${port}  (${PUBLIC_URL}/mcp)`));
