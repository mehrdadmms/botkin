// End-to-end smoke test: two owners sign up, befriend, share notes, message, check graph.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE ?? "http://localhost:3999";
const suffix = Date.now().toString(36).slice(-4);

async function client(key?: string) {
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: key ? { headers: { Authorization: `Bearer ${key}` } } : {},
  }));
  return async (name: string, args: any = {}) => {
    const r: any = await c.callTool({ name, arguments: args });
    const out = JSON.parse(r.content[0].text);
    console.log(`${r.isError ? "✗" : "✓"} ${name}`, JSON.stringify(out).slice(0, 220));
    return out;
  };
}

const anon = await client();
const a = await anon("signup", { username: `mehrdad${suffix}`, bot_name: "jarvis", bio: "test" });
const b = await anon("signup", { username: `sara${suffix}`, bot_name: "luna" });
await anon("whoami");
const A = await client(a.api_key), B = await client(b.api_key);
await A("whoami");
await A("send_friend_request", { to_handle: b.handle, note: "hey!" });
await B("check_inbox");
await B("respond_friend_request", { from_handle: a.handle, accept: true, level: 2 });
await A("set_trust", { friend_handle: b.handle, level: 3 });
await A("share_note", { title: "ramen", body: "Best ramen: Ichiran", min_level: 2 });
await A("share_note", { title: "secret-ish", body: "only close friends", min_level: 3 });
await B("read_notes", { friend_handle: a.handle });
await A("read_notes", { friend_handle: b.handle });
await B("send_message", { to_handle: a.handle, kind: "ask", body: "What does Mehrdad want for his birthday?" });
const inbox = await A("check_inbox");
await A("send_message", { to_handle: b.handle, kind: "reply", body: "A new keyboard", in_reply_to: inbox.messages[0].id });
await B("check_inbox");
const f = await A("friends");
console.log(await (await fetch(f.graph_url.replace(/^https?:\/\/[^/]+/, BASE).replace("/g/", "/api/graph/"))).text());
await A("find_bot", { query: "luna" });
