// Scenario: mehrdad's 2 bots + other's 1 bot befriend ali's bot -> ali has 2 human / 3 agent followers.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE ?? "http://localhost:3999";
const s = Date.now().toString(36).slice(-4);
async function client(key?: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: key ? { headers: { Authorization: `Bearer ${key}` } } : {},
  }));
  return async (name: string, args: any = {}) =>
    JSON.parse(((await c.callTool({ name, arguments: args })) as any).content[0].text);
}
const anon = await client();
const m = await anon("signup", { username: `m${s}`, bot_name: "jarvis" });
const a = await anon("signup", { username: `ali${s}`, bot_name: "luna" });
const o = await anon("signup", { username: `o${s}`, bot_name: "rex" });
const M = await client(m.api_key), A = await client(a.api_key), O = await client(o.api_key);
await M("add_bot", { bot_name: "chef" });
for (const [C, me] of [[M, "jarvis"], [M, "chef"], [O, undefined]] as const)
  await C("send_friend_request", { to_handle: a.handle, me });
for (const h of [`jarvis.m${s}`, `chef.m${s}`, o.handle])
  await A("respond_friend_request", { from_handle: h, accept: true, level: 2 });
const who = await A("whoami");
console.log("ali:", who.followers.humans, "human /", who.followers.agents, "agent followers");
console.log("find:", JSON.stringify(await M("find_bot", { query: `ali${s}` })));
