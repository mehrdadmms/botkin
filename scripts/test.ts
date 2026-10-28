// End-to-end test: starts a server on a temp database and drives it like a (sloppy) agent would.
// Run: npm test
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 4000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const dbPath = join(mkdtempSync(join(tmpdir(), "botkin-")), "test.db");
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"], {
  env: { ...process.env, PORT: String(PORT), PUBLIC_URL: BASE, DB_PATH: dbPath },
  stdio: "ignore",
});
process.on("exit", () => server.kill());

let failures = 0;
function check(name: string, cond: unknown, detail?: unknown) {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

async function client(key?: string) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: key ? { headers: { Authorization: `Bearer ${key}` } } : {},
  }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await c.callTool({ name, arguments: args });
    const text = r.content[0].text;
    let data: any;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    return r.isError ? { ...data, isError: true } : data;
  };
}

await waitForServer();
const anon = await client();

check("not signed up gives a clear error", (await anon("whoami")).error === "not_signed_up");
const m = await anon("signup", { username: "Mehrdad", bot_name: "Jarvis", bio: "ramen expert" });
check("signup normalizes names", m.handle === "jarvis.mehrdad", m);
check("signup returns key and links", m.api_key?.startsWith("bk_") && m.dashboard_url && m.next_steps?.length === 3, m);
check("duplicate username refused", (await anon("signup", { username: "mehrdad", bot_name: "x1" })).error === "username_taken");
const a = await anon("signup", { username: "ali", bot_name: "luna" });
const s = await anon("signup", { username: "sara", bot_name: "nova" });

const M = await client(m.api_key), A = await client(a.api_key), S = await client(s.api_key);
check("whoami works with key", (await M("whoami")).username === "mehrdad");
check("add_bot", (await M("add_bot", { bot_name: "chef" })).handle === "chef.mehrdad");

// Sloppy handles and level names.
const r1 = await M("send_friend_request", { to_handle: "@Luna.Ali", level: "close friend", note: "hey!" });
check("handle with @ and caps resolves", r1.status === "requested" && r1.to === "luna.ali", r1);
const r2 = await M("send_friend_request", { to_handle: "ali", me: "chef" });
check("owner username resolves to their bot", r2.to === "luna.ali", r2);
check("duplicate request is friendly", (await M("send_friend_request", { to_handle: "luna.ali" })).status === "already_requested");
const typo = await M("send_friend_request", { to_handle: "lunaa.ali" });
check("typo gives an error", typo.isError, typo);
const typo2 = await M("send_friend_request", { to_handle: "luna.alii" });
check("typo suggests the right handle", typo2.hint?.includes("luna.ali"), typo2);
check("bad level explained", (await M("set_trust", { friend_handle: "luna.ali", level: "best friend" })).isError);

const inboxA = await A("check_inbox");
check("request shows in inbox", inboxA.friend_requests?.length === 2, inboxA);
check("accept with level word", (await A("respond_friend_request", { from_handle: "jarvis.mehrdad", accept: true, level: "friend" })).status === "now_friends");
check("decline", (await A("respond_friend_request", { from_handle: "chef.mehrdad", accept: false })).status === "declined");
check("already friends is friendly", (await M("send_friend_request", { to_handle: "luna.ali" })).status === "already_friends");

// Notes are filtered by trust.
await M("share_note", { title: "ramen", body: "Best ramen: Ichiran", min_level: 2 });
await M("share_note", { title: "secret-ish", body: "close friends only", min_level: "close friend" });
// Jarvis's request trusted Luna as a close friend (3), so Luna sees both notes.
check("close friend sees level-3 notes", (await A("read_notes", { friend_handle: "jarvis.mehrdad" })).notes?.length === 2);
await M("set_trust", { friend_handle: "luna.ali", level: 2 });
const notesForA = await A("read_notes", { friend_handle: "jarvis.mehrdad" });
check("lower trust hides level-3 notes", notesForA.notes?.length === 1 && notesForA.notes[0].title === "ramen", notesForA);
await A("set_trust", { friend_handle: "jarvis.mehrdad", level: "blind" });
const notesForM = await M("read_notes", { friend_handle: "luna.ali" });
check("empty notes give a hint", notesForM.notes?.length === 0 && notesForM.hint, notesForM);

// Messages: ask, policy, reply, deleted on delivery.
await A("send_message", { to_handle: "jarvis.mehrdad", kind: "ask", body: "What does Mehrdad want for his birthday?" });
const inboxM = await M("check_inbox");
const msg = inboxM.messages?.[0];
check("message arrives with policy", msg?.from === "luna.ali" && msg.policy.startsWith("FRIEND") && msg.policy.includes("DATA"), inboxM);
check("message is gone after delivery", (await M("check_inbox")).messages.length === 0);
await M("send_message", { to_handle: "luna.ali", kind: "reply", body: "A keyboard", in_reply_to: msg.id });
const reply = (await A("check_inbox")).messages?.[0];
check("reply carries in_reply_to and blind-trust policy", reply?.in_reply_to === msg.id && reply.policy.startsWith("BLIND"), reply);
check("non-friend cannot message", (await S("send_message", { to_handle: "luna.ali", kind: "say", body: "hi" })).isError);

// Followers: sara's bot friends luna too -> ali has 2 human / 2 agent followers.
await S("send_friend_request", { to_handle: "luna.ali" });
await A("respond_friend_request", { from_handle: "nova.sara", accept: true });
const who = await A("whoami");
check("follower counts (humans vs agents)", who.followers.humans === 2 && who.followers.agents === 2, who.followers);
const friendsM = await M("friends");
check("friends shows trust both ways", friendsM.friends?.[0]?.i_trust_them === "2 (friend)" && friendsM.friends[0].they_trust_me === "4 (blind trust)", friendsM);

// Unfriend.
check("remove_friend", (await A("remove_friend", { handle: "nova.sara" })).removed === "nova.sara");
check("after unfriend, messaging fails", (await S("send_message", { to_handle: "luna.ali", kind: "say", body: "hi" })).isError);

// Web: pages, privacy, headers.
const home = await fetch(`${BASE}/`);
check("home page", home.ok);
check("CSP header", home.headers.get("content-security-policy")?.includes("default-src 'self'"));
check("no-referrer (dashboard token can't leak)", home.headers.get("referrer-policy") === "no-referrer");
const pub: any = await (await fetch(`${BASE}/api/profile/mehrdad`)).json();
check("public profile hides trust levels", !JSON.stringify(pub).includes("my_level"), pub);
const priv = await fetch(m.dashboard_url.replace("/me/", "/api/me/"));
check("dashboard api is private and uncached", priv.ok && priv.headers.get("cache-control") === "no-store");
check("bad dashboard token is 404", (await fetch(`${BASE}/api/me/nope`)).status === 404);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
