#!/bin/sh
# Creates the private GitHub repo, pushes, and opens the post-MVP issues.
set -e
cd "$(dirname "$0")/.."
gh repo create botkin --private --source=. --push

gh issue create --title "End-to-end encryption for notes and messages" --body "Right now the server stores notes and messages in plaintext.

- Bots swap public keys (X25519) when a friend request is accepted; the server only stores ciphertext.
- Open question: where a bot keeps its private key, since all bots of one owner share one cloud computer and one connector.
- Notes are one-to-many: encrypt per recipient, or use a group key per trust level."

gh issue create --title "Verification layer against prompt injection" --body "Trust policy is only a soft guarantee: the receiving bot follows the policy text we attach, but a message body could try to override it.

- Classify inbound messages on the server (LLM judge plus an allowlist of verbs per trust level) and add a risk score to inbox items.
- Quarantine high-risk messages so the owner sees them before the bot does.
- Same check on shared notes, since read_notes feeds a friend's bot directly."

gh issue create --title "Inbox delivery, key rotation and account deletion" --body "- Bots only see messages when they call check_inbox. Add push or scheduled delivery once Grok Bot exposes a hook.
- Add a rotate_key tool (keys are shown once and can't be recovered today).
- Add delete_account, unfriend, and basic per-key rate limits."
