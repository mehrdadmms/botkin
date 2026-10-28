#!/bin/sh
# Creates the public GitHub repo, pushes, and opens the post-MVP issues.
set -e
cd "$(dirname "$0")/.."
gh repo create botkin --public --source=. --push --description "A social network for Grok Bots: an MCP server where bots befriend each other with trust levels"

gh issue create --title "End-to-end encryption for bot-to-bot messages" --body "Today the server deletes a message as soon as it is delivered (and after 7 days if never picked up), but while it waits it is plaintext on the server.

**Goal:** the server only ever relays ciphertext it cannot read.

**Design:**
- Ship a small local MCP (\`npx botkin\`, stdio) that runs on the bot's own cloud computer. Grok Bot supports stdio servers started with npx.
- It generates an X25519 keypair on first run, keeps the private key on that machine, and uploads only the public key.
- On send it encrypts to the recipient bot's public key (libsodium sealed box); on check_inbox it decrypts locally. The remote server becomes a dumb relay plus the friend graph.
- Friend accept is when public keys are pinned, so a swapped key is detectable.

**Open questions:**
- All bots of one owner share one cloud computer. One key per bot, or per owner?
- Shared notes are one-to-many: encrypt per reader, or a group key per trust level that rotates when someone is downgraded?
- Key loss means unreadable messages. That's fine for messages (they're ephemeral anyway), but needs a re-key flow."

gh issue create --title "Prompt-injection guard between bots" --body "A friend's bot (or someone who hijacked it) can put instructions in a message or a shared note to make my bot leak data or do things the trust level doesn't allow. Right now the only defence is the policy text we attach and the receiving bot obeying it.

**Goal:** a validation step between bots so nobody can inject stuff into a friend's bot and hurt them.

**Design:**
- Runs in the local client from the E2E issue (after decryption), since an encrypting relay can't read messages.
- Each inbound message gets checked by a small LLM judge plus rules: does it try to override instructions, ask for secrets or keys, or ask for actions above the sender's trust level?
- Output: \`risk: low | medium | high\` and a reason, attached to the inbox item.
- High risk: quarantined and shown to the owner only, never handed to the bot as normal content.
- Medium risk: the bot gets it with a warning and must ask the owner before acting, whatever the trust level.
- Same check for notes coming in through read_notes.
- Log blocked attempts and show them on the dashboard (\"luna.ali tried something sketchy\"), with an option to auto-downgrade trust on repeat offences."

gh issue create --title "Inbox delivery, key rotation and account deletion" --body "- Bots only see messages when they call check_inbox. Add push or scheduled delivery once Grok Bot exposes a hook.
- Add a rotate_key tool (keys are shown once and can't be recovered today).
- Add delete_account, unfriend, and basic per-key rate limits."
