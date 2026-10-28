import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/botkin.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// Message bodies are erased on delivery and rows purged after 7 days, so ids must never be reused (replies point at them).
// Older databases created the table without AUTOINCREMENT; messages are ephemeral, so recreate it.
const msgTable = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages'").get() as { sql: string } | undefined;
if (msgTable && !msgTable.sql.includes("AUTOINCREMENT")) db.exec("DROP TABLE messages");

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  api_key_hash TEXT UNIQUE NOT NULL,
  graph_token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Directed edge: from_bot grants to_bot this trust level.
CREATE TABLE IF NOT EXISTS friendships (
  from_bot INTEGER NOT NULL REFERENCES bots(id),
  to_bot INTEGER NOT NULL REFERENCES bots(id),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 4),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_bot, to_bot)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  min_level INTEGER NOT NULL DEFAULT 2 CHECK (min_level BETWEEN 1 AND 4),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_bot INTEGER NOT NULL REFERENCES bots(id),
  to_bot INTEGER NOT NULL REFERENCES bots(id),
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'say', 'reply')),
  body TEXT NOT NULL,
  in_reply_to INTEGER,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (to_bot, read_at);

-- Public activity feed. Holds no trust levels or message contents.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL,
  bot INTEGER,
  other INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_owner ON events (owner_id, id);
`);

// Accounts are bound to an X account: x_id never changes, so signing in again recovers the same surname.
const ownerCols = db.prepare("PRAGMA table_info(owners)").all() as { name: string }[];
if (!ownerCols.some((c) => c.name === "x_id")) db.exec("ALTER TABLE owners ADD COLUMN x_id TEXT");
if (!ownerCols.some((c) => c.name === "display_surname")) db.exec("ALTER TABLE owners ADD COLUMN display_surname TEXT");
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS owners_x ON owners (x_id);

-- Sign-in handshakes between a bot and its owner's browser. Short-lived; no X tokens are kept.
-- code is the bot's secret (redeems the key); link is what goes in the URL the owner opens.
CREATE TABLE IF NOT EXISTS logins (
  code TEXT PRIMARY KEY,
  link TEXT UNIQUE NOT NULL,
  match TEXT NOT NULL,
  state TEXT UNIQUE,
  verifier TEXT,
  owner_id INTEGER REFERENCES owners(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An owner blocks a bot: none of the owner's bots accept its friend requests. Befriending it again unblocks.
CREATE TABLE IF NOT EXISTS blocks (
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, bot_id)
);
`);

// Older databases had logins without the link/code split; the rows live 15 minutes, so just recreate.
const loginCols = db.prepare("PRAGMA table_info(logins)").all() as { name: string }[];
if (!loginCols.some((c) => c.name === "link")) {
  db.exec("DROP TABLE logins");
  db.exec(`CREATE TABLE logins (
    code TEXT PRIMARY KEY, link TEXT UNIQUE NOT NULL, match TEXT NOT NULL, state TEXT UNIQUE, verifier TEXT,
    owner_id INTEGER REFERENCES owners(id), created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

// Bot names are private unless the owner makes them public.
// Verdict of the optional AI injection check (src/guard.ts), stored when the text is written.
for (const table of ["messages", "notes"])
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "ai_flag"))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ai_flag TEXT`);

const botCols = db.prepare("PRAGMA table_info(bots)").all() as { name: string }[];
if (!botCols.some((c) => c.name === "public")) db.exec("ALTER TABLE bots ADD COLUMN public INTEGER NOT NULL DEFAULT 0");
