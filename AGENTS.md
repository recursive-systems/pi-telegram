# pi-telegram-extension

Our fork of [badlogic/pi-telegram](https://github.com/badlogic/pi-telegram)
(MIT) — a Telegram DM bridge implemented as a **pi TUI extension**. Lives at
`recursive-systems/pi-telegram` (public, MIT). Installed into pi user
settings as a local-path package (`pi list` shows it), so edits here take
effect in any new pi session — no reinstall needed.

**This is the canonical place to extend Telegram support.** The sibling
`../pi-telegram/` repo is a headless always-on bridge with the same bot token;
see its AGENTS.md for the one-poller-per-token handoff protocol (`/stop`).

## Config

- Token + pairing live in `~/.pi/agent/telegram.json` (written by
  `:telegram-setup`; same `@PITelegramDevBot` token as the bridge's `.env`)
- Single paired user (`allowedUserId`), first `/start` claims it

## Extension notes (as of vendoring, pi 0.84.4)

- `index.ts` + `markdown-to-telegram.ts` (zero runtime deps except
  `markdown-it`, which pi installs automatically via `dependencies`)
- Imports still use the `@mariozechner/*` peer scope — they resolve today
  (pi ships compat modules + this dir has its own `node_modules`). If a pi
  upgrade breaks them, retarget to `@earendil-works/pi-ai`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, and
  `typebox`; verified typecheck-clean against 0.84.4 in the sibling bridge
  repo on 2026-09-02.

## Features worth porting from the sibling bridge (`../pi-telegram/src`)

- ~~`markdown-to-telegram.ts` — markdown → Telegram-safe HTML replies~~
  (ported 2026-09-02; wired into previews, final messages, and
  `sendTextReply` with plain-text fallback on API rejection)
- `/model` command — `ctx.model` is exposed by the ExtensionAPI
- Multi-ID allowlist instead of single paired user
