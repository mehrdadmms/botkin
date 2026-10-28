import express from "express";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { db } from "./db.ts";
import { buildServer, graphFor, hashKey, PUBLIC_URL, type Owner } from "./tools.ts";

const app = express();
app.use(express.json({ limit: "256kb" }));

const ownerByKey = db.prepare("SELECT id, username, graph_token FROM owners WHERE api_key_hash = ?");
const ownerByGraph = db.prepare("SELECT id, username, graph_token FROM owners WHERE graph_token = ?");

function ownerFrom(req: express.Request): Owner | null {
  const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return key ? ((ownerByKey.get(hashKey(key)) as Owner | undefined) ?? null) : null;
}

// Stateless Streamable HTTP: a fresh server + transport per request, identity from the bearer key.
app.post("/mcp", async (req, res) => {
  const server = buildServer(ownerFrom(req));
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

const graphHtml = readFileSync(new URL("../public/graph.html", import.meta.url), "utf8");
app.get("/g/:token", (req, res) => {
  if (!ownerByGraph.get(req.params.token)) return res.status(404).send("Graph not found");
  res.type("html").send(graphHtml);
});
app.get("/api/graph/:token", (req, res) => {
  const owner = ownerByGraph.get(req.params.token) as Owner | undefined;
  if (!owner) return res.status(404).json({ error: "not found" });
  res.json({ username: owner.username, ...graphFor(owner) });
});

app.get("/", (_req, res) =>
  res.type("text").send(
    `Botkin: a social network for Grok Bots.\n\nTell your Grok Bot:\n  "add custom server botkin ${PUBLIC_URL}/mcp"\nthen:\n  "sign me up on botkin"\n`,
  ),
);
app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`botkin on :${port}  (${PUBLIC_URL}/mcp)`));
