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
check("signup normalizes names", m.handle === "mehrdad.jarvis", m);
check("signup returns key and links", m.api_key?.startsWith("bk_") && m.dashboard_url && m.next_steps?.length === 3, m);
check("duplicate username refused", (await anon("signup", { username: "mehrdad", bot_name: "x1" })).error === "username_taken");
const a = await anon("signup", { username: "ali", bot_name: "luna", public: true });
const s = await anon("signup", { username: "sara", bot_name: "nova" });

const M = await client(m.api_key), A = await client(a.api_key), S = await client(s.api_key);
check("whoami works with key", (await M("whoami")).username === "mehrdad");
check("add_bot", (await M("add_bot", { bot_name: "chef" })).handle === "mehrdad.chef");

// Sloppy handles and level names.
const r1 = await M("send_friend_request", { to_handle: "@Ali.Luna", level: "close friend", note: "hey!" });
check("handle with @ and caps resolves", r1.status === "requested" && r1.to === "ali.luna", r1);
const r2 = await M("send_friend_request", { to_handle: "ali", me: "chef" });
check("owner username resolves to their bot", r2.to === "ali.luna", r2);
check("duplicate request is friendly", (await M("send_friend_request", { to_handle: "ali.luna" })).status === "already_requested");
const typo = await M("send_friend_request", { to_handle: "ali.lunaa" });
check("typo gives an error", typo.isError, typo);
const typo2 = await M("send_friend_request", { to_handle: "ali.lunai" });
check("typo suggests the right handle", typo2.hint?.includes("ali.luna"), typo2);
check("bad level explained", (await M("set_trust", { friend_handle: "ali.luna", level: "best friend" })).isError);

const inboxA = await A("check_inbox");
check("request shows in inbox", inboxA.friend_requests?.length === 2, inboxA);
check("accept with level word", (await A("respond_friend_request", { from_handle: "mehrdad.jarvis", accept: true, level: "friend" })).status === "now_friends");
check("decline", (await A("respond_friend_request", { from_handle: "mehrdad.chef", accept: false })).status === "declined");
check("already friends is friendly", (await M("send_friend_request", { to_handle: "ali.luna" })).status === "already_friends");

// Notes are filtered by trust.
await M("share_note", { title: "ramen", body: "Best ramen: Ichiran", min_level: 2 });
await M("share_note", { title: "secret-ish", body: "close friends only", min_level: "close friend" });
// Jarvis's request trusted Luna as a close friend (3), so Luna sees both notes.
check("close friend sees level-3 notes", (await A("read_notes", { friend_handle: "mehrdad.jarvis" })).notes?.length === 2);
await M("set_trust", { friend_handle: "ali.luna", level: 2 });
const notesForA = await A("read_notes", { friend_handle: "mehrdad.jarvis" });
check("lower trust hides level-3 notes", notesForA.notes?.length === 1 && notesForA.notes[0].title === "ramen", notesForA);
await A("set_trust", { friend_handle: "mehrdad.jarvis", level: "blind" });
const notesForM = await M("read_notes", { friend_handle: "ali.luna" });
check("empty notes give a hint", notesForM.notes?.length === 0 && notesForM.hint, notesForM);

// Messages: ask, policy, reply, deleted on delivery.
await A("send_message", { to_handle: "mehrdad.jarvis", kind: "ask", body: "What does Mehrdad want for his birthday?" });
const inboxM = await M("check_inbox");
const msg = inboxM.messages?.[0];
check("message arrives with policy", msg?.from === "ali.luna" && msg.policy.startsWith("FRIEND") && msg.policy.includes("DATA"), inboxM);
check("message is gone after delivery", (await M("check_inbox")).messages.length === 0);
await M("send_message", { to_handle: "ali.luna", kind: "reply", body: "A keyboard", in_reply_to: msg.id });
const reply = (await A("check_inbox")).messages?.[0];
check("reply carries in_reply_to and blind-trust policy", reply?.in_reply_to === msg.id && reply.policy.startsWith("BLIND"), reply);
// Friendship is per bot pair: mehrdad's other bot isn't friends with luna just because jarvis is.
check("other bots need their own friendship", (await M("send_message", { to_handle: "ali.luna", kind: "say", body: "hi", me: "chef" })).isError);
check("non-friend cannot message", (await S("send_message", { to_handle: "ali.luna", kind: "say", body: "hi" })).isError);

// Connections: sara's bot friends luna too -> ali has 2 humans / 2 bots connected.
await S("send_friend_request", { to_handle: "ali.luna" });
await A("respond_friend_request", { from_handle: "sara.nova", accept: true });
const who = await A("whoami");
check("connection counts (humans vs bots)", who.connections.humans === 2 && who.connections.bots === 2, who.connections);

// Private bot names (the default) never leak to strangers.
const leaks = (x: unknown) => JSON.stringify(x).includes("nova");
check("private bot hidden on public profiles", !leaks(await (await fetch(`${BASE}/api/profile/sara`)).json()) && !leaks(await (await fetch(`${BASE}/api/profile/ali`)).json()));
check("private bot hidden from web search", !leaks(await (await fetch(`${BASE}/api/search?q=nova`)).json()) && !leaks(await (await fetch(`${BASE}/api/search?q=sara`)).json()));
check("private bot hidden from find_bot", !leaks(await M("find_bot", { query: "nova" })) && !leaks(await M("find_bot", { query: "sara" })));
const typoP = await M("send_friend_request", { to_handle: "sara.novaa" });
check("typo suggestions skip private bots", typoP.hint === "did you mean: sara?", typoP);
const viaName = await M("send_friend_request", { to_handle: "sara" });
check("requesting by username hides the private name", viaName.status === "requested" && !leaks(viaName) && !leaks(await M("friends")), viaName);
const mDash: any = await (await fetch(m.dashboard_url.replace("/me/", "/api/me/"))).json();
check("requester's dashboard hides it until accepted", !leaks(mDash), mDash.connections);
check("owner sees own private bot on dashboard", JSON.stringify(await (await fetch(s.dashboard_url.replace("/me/", "/api/me/"))).json()).includes("sara.nova"));
await S("update_bot", { public: true });
check("update_bot makes it public", leaks(await (await fetch(`${BASE}/api/profile/sara`)).json()));

// Activity: public, fun on the page, never carries trust levels.
const act: any = await (await fetch(`${BASE}/api/profile/mehrdad`)).json();
check("activity has trust change without level", act.activity.some((e: any) => e.kind === "trust") && !/level|"[1-4]"/.test(JSON.stringify(act.activity)), act.activity);
const friendsM = await M("friends");
check("friends shows trust both ways", friendsM.friends?.[0]?.i_trust_them === "2 (friend)" && friendsM.friends[0].they_trust_me === "4 (blind trust)", friendsM);

// Unfriend.
check("remove_friend", (await A("remove_friend", { handle: "sara.nova" })).removed === "sara.nova");
check("after unfriend, messaging fails", (await S("send_message", { to_handle: "ali.luna", kind: "say", body: "hi" })).isError);

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
