# pi-telegram

![pi-telegram screenshot](screenshot.png)

> Full pi build session: [View the session transcript](https://pi.dev/session/#14acfe07b7844c8abec55ed9fbddc17f), which captures the full pi session in which `pi-telegram` was built.

Telegram DM bridge for pi.

## Install

From git:

```bash
pi install git:github.com/recursive-systems/pi-telegram
```

Or for a single run:

```bash
pi -e git:github.com/recursive-systems/pi-telegram
```

## Configure

### Telegram

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### pi

Start pi, then run:

```bash
/telegram-setup
```

Paste the bot token when prompted.

The extension stores config in:

```text
~/.pi/agent/telegram.json
```

## Connect a pi session

The Telegram bridge is session-local. Connect it only in the pi session that should own the bot:

```bash
/telegram-connect
```

To stop polling in the current session:

```bash
/telegram-disconnect
```

Check status:

```bash
/telegram-status
```

Status is content-free: queue/admission/preflight/active/finalization/hold flags,
host idle/pending flags and phase ages. Use `/telegram-status detail` for all
fields and the last 16 lifecycle observations.
`queued` includes a submitted turn until its matching preflight claims it;
`active: false` and `queued: 0` do **not** mean outbound delivery has finished.
`finalizing`, `finalizationStage`, and detailed `previewFlushing` distinguish that wait.
`settlementOwed` means a settled event was observed but its finalization gate
was blocked. Existing lifecycle wakes can retry it after manual compaction; a
new agent run supersedes it and must settle in its own right. Compaction alone
never creates settlement debt.
`blocker` reports the current admission gate, not a diagnosis of the host.
Preparation age covers the current uninterrupted batch; queued age starts after
attachment preparation. Ages use the process wall clock.

`instance` and `loadedAt` identify this extension factory invocation. The lazy
cached **checkout version is not proof of loaded code**.

For an optional model-readable snapshot, launch an approved test/session with
`--telegram-diagnostics`. At `session_start` (after CLI/restored flags are
applied), this registers `telegram_diagnostics` once per extension instance.
It is a read-only tool with no arguments, returning the detailed lifecycle fields
(without the command's checkout git lookup). It cannot connect, replay, reset, or send.
The tool samples host state during its own calling turn; it cannot reconstruct
an earlier idle snapshot beyond the bounded previous lifecycle observations.
Metadata stays in memory; explicitly requested tool results may be retained by
Pi like any other tool result. No message text, Telegram identifiers, paths,
tokens, URLs, or network errors are included.

## Pair your Telegram account

After token setup and `/telegram-connect`:

1. Open the DM with your bot in Telegram
2. Send `/start`

The first DM user becomes the allowed Telegram user for the bridge. The extension only accepts messages from that user.

## Usage

Chat with your bot in Telegram DMs.

### Send text

Send any message in the bot DM. It is forwarded into pi with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The extension:
- downloads them to `~/.pi/agent/tmp/telegram`
- includes local file paths in the prompt
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_attach` tool. The extension then sends those files with the next Telegram reply.

Examples:
- `summarize this image`
- `read this README and summarize it`
- `write me a markdown file with the plan and send it back`
- `generate a shell script and attach it`

### Stop a run

In Telegram, send:

```text
stop
```

or:

```text
/stop
```

That aborts the active pi turn.

### Queue follow-ups

If you send more Telegram messages while pi is busy, they are queued and processed in order.

## Streaming

The extension streams assistant text previews back to Telegram while pi is generating.

It tries Telegram draft streaming first with `sendMessageDraft`. If that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

## Notes

- Only one pi session should be connected to the bot at a time
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's 4096 character limit
- Outbound files are sent via `telegram_attach`

## License

MIT

## Runtime and tests

Requires Pi **0.85.x** (verified against 0.85.0). Markdown uses `Marked` and its
public token types from the host-supplied `@earendil-works/pi-tui` peer
(`^0.85.0`, currently supplying Marked 18.0.5), not a standalone parser dependency.
The Telegram renderer remains owned here. Older Pi releases are not supported;
other existing peer scopes are unchanged. Queue behavior relies on
`session_compact_failed`, `agent_settled`, and session-level idle semantics. Telegram work waits for Pi to settle, including retries
and automatic compaction. Manual compaction success/failure also wakes the queue,
after a deferred idle/pending check. Albums reserve FIFO at first arrival, before
debounce and downloads. Each submitted prompt carries a unique turn marker;
unrelated local/jobs prompts never claim Telegram replies. `stop` holds queued
messages as ordered history for the next Telegram message.

Run deterministic offline regression tests with Node **22.22+**:

```bash
npm test
```

Outside Pi's extension loader, Node must resolve the host-supplied peers. For an
isolated checkout, use a **private** `node_modules` directory with package symlinks
to an existing Pi host's TUI and existing baseline peer dependencies. Do not run
an install against a `node_modules` symlink to another checkout. This avoids
installing a second Pi runtime just to test. The lockfile retains the existing
legacy peer dependency tree; npm's normal peer auto-install policy is unchanged.

Formatter tests use the real public Pi-supplied Marked export. Queue tests use a
temporary HOME, fake Pi lifecycle, mocked fetch, and fake timers. No bot,
credentials, or model is used.

The formatter was compared offline with the original markdown-it renderer on
40 expected-output fixtures. This is not a perfect CommonMark parity claim:
- Nested quotes are flattened because Telegram disallows nested blockquotes.
- Unsupported/malformed link destinations retain escaped Markdown source.
- Marked's raw HTML blocks remain entirely literal (including Markdown inside).
- Nonempty code blocks normalize a trailing newline, including unclosed fences.
- Numeric references and `amp`, `lt`, `gt`, `quot`, `apos` (plus the valid
  uppercase `AMP`, `LT`, `GT`, `QUOT` aliases) decode once outside code/raw HTML.
  Other named entities (e.g. `&copy;`) remain literal text instead
  of requiring an additional HTML entity-table dependency or emitting entities
  Telegram rejects. Use Unicode or numeric references for those characters.
- Marked GFM handles tables/tasks; bare URLs and single-tilde strike remain literal.
  Incomplete delimiters retain their source; unclosed fences still render as code.

Pi's extension `sendUserMessage` API returns void, **not an async admission
acknowledgement**. Preflight failures (e.g. missing model/auth), intercepted
inputs, or transformations removing the turn marker leave the submission waiting
and **block all subsequent Telegram messages** rather than risk a duplicate
resend. Transformations preserving the marker remain compatible. Pi reports
preflight errors locally. A suspended `before_agent_start`, including a foreign
prompt, also holds dispatch until `agent_start`; there is no preflight-failure
hook to safely release that guard. Work before this extension receives its hooks
is not observable; this is not a host-wide prompt admission lock.

Recovery: first preserve the affected messages/attachments in Telegram, resolve
the local preflight/interception problem, then restart/reload this extension's Pi
session and resend the desired messages from Telegram in order. Disconnect and
reconnect alone do not reset the reservation, nor does sending another message.
Ordinary teardown does not restore session-local queued work. The explicit
`/telegram-reload` handoff below is the only exception; there is no speculative
retry. Check whether an unacknowledged prompt actually
ran before resending it.

## Explicit reload handoff (test branch)

On Pi **0.85.0**, `/telegram-reload` reloads the **installed runtime**, preserving
this bridge's prepared FIFO queue and `stop` hold/history. It does **not** install
new source, upgrade Pi, or change package pins. The `telegram_reload` tool is a
thin command scheduler: the model must have **explicit user authorization** to
call it. There is no Telegram command alias or general auto-connect option.

The command blocks new queue dispatch immediately, waits for host idle **and**
the current Telegram final reply/attachments, stops and awaits its old poller
(including ingress), flushes pending album debounce, and awaits downloads. It
checks idle/pending/preflight state again after asynchronous preparation and
config verification. An initial connection must establish its cursor first.
The session JSONL file must already exist: Pi can assign a filename before its
first assistant response is saved. Such fresh, memory-only sessions refuse
handoff; let Pi save an assistant response before retrying.
Unacknowledged submissions, suspended preflight, failed
preparation/ingress, and uncertain outgoing replies **refuse** handoff rather
than replay uncertain work. Concurrent requests coalesce.

A bounded (maximum 8 MiB, otherwise refused) `telegram-reload-checkpoint-v1`
custom session entry stores only queued turns, hold state, cursor, and handoff
metadata. It is **not** a message sent to the model. Text, image inputs, and local
file references remain **private session data**; session exports/shares may
include them, so do not publish such sessions. Config credentials are never
copied into the checkpoint: pairing/bot identity is checked with a process-keyed
fingerprint, and the replacement reads the existing credential config.

The session record alone cannot reconnect anything. A short-lived, one-shot
in-process capability (no credentials or queue contents) binds its exact digest
to this process and session ID/file. Only the explicit command's reload shutdown
arms it; the new `session_start(reason: reload)` claims it before asynchronous
restoration. Claims do not erase the original checkpoint. Startup, new, fork,
resume, ordinary reload, repeated callbacks, expired capabilities (two-minute
claim window), and other Pi processes cannot replay it. Any unclaimed capability
is revoked when the originating reload returns, including errors reported only
as TUI diagnostics or an omitted replacement extension. If the old bridge was
disconnected, it stays disconnected and its queue waits for explicit connect. Connected restoration verifies a Telegram
API round trip before reporting that polling started; this is not a promise
that subsequent network requests will succeed.

### Limits and recovery

- Ordering guarantees cover **this handoff's own old/new pollers**, not foreign
  pollers manually started elsewhere with the same bot token. Keep one owner.
- Pi's `sendUserMessage` returns **void**, catches asynchronous errors, and is
  not an admission acknowledgement. The tool explicitly enables command
  dispatch (`expandPromptTemplates`); `followUp` alone does not delay extension
  commands. The command itself waits for idle. A swallowed command submission
  failure leaves dispatch held; use the local `/telegram-reload` command to
  explicitly retry. No blind resend or automatic retry loop is attempted.
- This is not crash recovery, durable message delivery, or a host-wide prompt
  admission lock. Unobservable foreign preflight and host/session persistence
  failures remain limits. A hung host/network operation may require manual
  intervention; the handoff does not force teardown or rewind the cursor.
- Preparation failure retains raw evidence/work in the old instance and blocks
  dispatch. Before ordinary teardown, preserve affected messages/files from
  Telegram. `/telegram-status` reports queue and failure counts.
- Failure before teardown leaves the old work in memory. If quiescing already
  stopped polling, it stays stopped; fix the issue and explicitly retry the
  command (or connect if abandoning the handoff). Failed downloads/uncertain
  submissions cannot be certified by retrying.
- After teardown or restoration/reconnection failure, the original custom
  checkpoint remains in the private session. The fresh instance reports failure
  and blocks dispatch/connect; it does not retry or send queued work blindly.
  If runtime loading itself fails, Pi's host error channel reports the failure;
  the old command never calls stale session APIs.
- **Deliberate recovery:** use `/session` to locate the private JSONL file. Save a
  private copy and inspect the latest checkpoint's `turns` (`content`,
  `historyText`, local attachment paths) locally. Reconcile with Telegram and
  the session's actual submitted turns/replies. Save needed files before any
  cleanup. Then perform one **ordinary** `/reload`, explicitly `/telegram-connect`,
  and resend only the messages you have determined did not run, in order. Do not
  edit claims/nonces to force replay, and do not resend an uncertain outbound
  reply. A consumed checkpoint is retained evidence, not proof of delivery.

### At-home test procedure (only after review)

No live installation or reload is part of the offline test suite. In a checkout
of the reviewed branch, with Node 22.22+:

```bash
npm ci --ignore-scripts
npm test
```

Tests isolate HOME, use fake credentials/network/host, and exercise two freshly
loaded extension instances with shared session entries. They never contact a
bot or model. Existing queue regressions run alongside handoff tests.

For an intentional live test **when you are home**, replace the placeholders
below with the reviewed commit supplied by the maintainer and your recorded
previous package pin. Do not run these steps unattended:

1. Record the existing package pin with `pi list`. Ensure no other bot poller is
   running. Save/finish pending Telegram messages and attachments in the
   **currently loaded old bridge**. **First installation cannot preserve that
   old bridge's in-memory queue:** it does not yet have this handoff code.
2. Install the reviewed source separately from reloading the runtime, using
   the **same settings scope** as the existing package. For a project-local
   installation, run this from that project's directory:
   ```bash
   npm_config_ignore_scripts=true pi install -l 'git:github.com/recursive-systems/pi-telegram@<reviewed-commit>'
   ```
   For a global installation, omit `-l`. A global update cannot override an
   existing project pin. Retain any existing dependency-pruning policy (Pi
   supplies its peer APIs); do not enable dependency install scripts for this test.
   In the intended Pi session, do one **ordinary** `/reload`, then
   `/telegram-connect`. Check `/telegram-status` and Telegram `/version` against
   the reviewed commit. Do not add a second package/extension copy.
3. Send a small Telegram request, then two distinguishable follow-ups (one with
   an image/file). While it runs, issue local `/telegram-reload`. Confirm the
   current reply/files finish first, the fresh local status reports restoration,
   and the queued requests run in order once. Send another message during the
   gap and confirm it is handled once after reconnect.
4. Repeat with Telegram `stop`: queued history must stay held until a new
   Telegram message. Repeat by explicitly asking the model to call
   `telegram_reload`; its tool result is a request, **not** proof of completion.
5. `/telegram-disconnect`, then `/telegram-reload`: it must stay disconnected.
   Also verify an ordinary `/reload` stays disconnected. Stop if status reports
   uncertainty/recovery required; follow the recovery procedure above.

**Rollback:** preserve/finish queued work first, `/telegram-disconnect`, reinstall
`git:github.com/recursive-systems/pi-telegram@<previous-pin>` in the same scope
(`-l` for a project pin, omitted for global; keep install scripts disabled), then
perform an ordinary `/reload`. Verify version/status and explicitly connect only the
intended owner. The older version does not restore these checkpoints; save and
reconcile any pending work before rollback. Installing or reverting a pin and
reloading the running runtime are distinct operations.
