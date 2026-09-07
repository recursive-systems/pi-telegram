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
attachment preparation. After an explicit handoff, queued and held ages start
once at restoration in the new instance, **not original arrival**. Diagnostic
timestamps are not checkpointed. Ages use the process wall clock.

`instance` and `loadedAt` identify this extension factory invocation. The lazy
cached **checkout version is not proof of loaded code**. The UUID is factory
identity, not immutable code attestation: even the same source creates a new UUID
on reload. Status also retains reload/recovery, failed preparation/ingress counts,
and uncertain-reply indicators; detail includes disconnected-restoration gates.

For an optional model-readable snapshot, launch an approved test/session with
`--telegram-diagnostics`. At `session_start` (after CLI/restored flags are
applied), this registers `telegram_diagnostics` once per extension instance.
The flag must be supplied when launching Pi; typing it into an existing session
is not a runtime toggle. Reload restores the previous flag value onto the **new**
factory before registration; disabled instances expose no diagnostics tool.
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

### Telegram commands and menu

Send `/commands`, `/help`, or `/start` for help. Implemented remote routes:

| Command | Response/action |
| --- | --- |
| `/status` | Model and token usage |
| `/bridge_status [detail]` | Content-free bridge diagnostics sampled directly, **without a model turn** |
| `/version` | Lazy cached checkout version, not loaded-code attestation |
| `/compact [instructions]` | Compact only while Pi is idle; optional instruction text preserves case |
| `/stop` or bare `stop` | Abort and hold queued history |
| `/telegram_reload` | Request the existing safe runtime handoff, not install/upgrade source |
| `/commands`, `/help`, `/start` | Help and a bounded local-only Pi catalog |

Only standalone text is interpreted as a command. Captions, albums and messages
with attachments stay normal model input and preserve files/FIFO. Command names
and `@bot` suffixes are case-insensitive; argument text is not lowercased. An
addressed command is refused until a bounded (2s), once-per-connection `getMe` verifies the active token username, or if its suffix differs. Configuration is not identity. Explicit disconnect/shutdown invalidates this cache and cancels delayed verification; bare commands do not wait for it. Internal handoff preserves already-verified addressing while accepted ingress drains, so an accepted `/stop@Own_Bot` still holds queued history. A new connection always verifies afresh, including after a failed handoff. Failed verification is not polled again until reconnect.
Unsupported arguments return usage. **Intentional compatibility change:** unknown
or unavailable standalone slash commands are explicitly rejected, not silently
sent to the model. Telegram `/reload` points to `/telegram_reload`; it never runs
ordinary teardown. These control/help responses do not release stop-held history.

`pi.getCommands()` is sampled dynamically for help: up to 12 validated names
from the first 200 entries (extension, prompt, skill), with visible filtering /
truncation. Names retain hyphens/colons; no aliases are invented. Metadata paths
and descriptions are omitted. These entries are **local-only, not remotely
executable**; discovery does not include Pi's interactive built-ins and grants no
permission to execute extensions, skills, templates, pickers, shell, or login.

On the first authorized ordinary private message of each connection, the bridge
best-effort publishes just the implemented routes with `setMyCommands`, scoped to
that observed chat (not the sender ID, global/default, or all-private scope).
No startup menu API calls occur while disconnected. Alternate business/guest
message contexts are not accepted as ordinary bot DMs. Existing pairing policy
is unchanged. Menu metadata is never authorization.

Registration has a two-second deadline, no retry loop and no per-message repeat;
disconnect/shutdown cancels pending work. Diagnostics report `menuState` using
fixed labels. Failure does not block ordinary ingress or finalization; `/commands` still works.
An in-flight transport that ignores cancellation can block lease handoff until it settles. A successful request does not prove the client has refreshed its menu.
Existing language-specific lists or custom menu buttons may take precedence; v1
does not overwrite those settings. Server-side menu changes are not transactional
with reload, and a stale visible command never grants execution permission.

The reload alias blocks new queue dispatch before its bounded **requested** receipt,
then submits the authorized local command and releases polling ingress immediately.
The receipt is not proof of admission, completion, or reconnection. Final replies,
files, and all existing handoff refusal gates still apply. Synchronous submission
failure clears the new reservation; swallowed asynchronous failure leaves dispatch
held for explicit local `/telegram-reload` retry, never automatic resend.

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

Run deterministic offline regression tests with Node **22.22+** using the
sanitized, separately grouped procedure under **Offline project and cross-factory tests**.
Do not use an ungrouped `test/*.test.mjs`: boundaries intentionally replace global
builtins. Declared peer dependencies must already be installed; the runner never installs them.

The historical Telegram stall remains **unproven**. Offline tests reproduce a
specific missed-finalization mechanism, not the original incident. Recovery only
reuses existing lifecycle drains for an actually observed settled event; it adds
no heartbeat, scheduler, watchdog, broad retry loop, or general liveness guarantee.

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
call it. The paired Telegram `/telegram_reload` alias schedules the same handoff
without asking a model to translate it. There is no general auto-connect option.

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
than replay uncertain work. Concurrent requests coalesce. If a completed reply
still owes settlement during manual compaction, reload waits for host idle and
may refuse while that active reply awaits its deferred drain. The original
instance retains and finalizes it; retry the explicit handoff only after that
finishes. Debt is never transferred as queued work. A finalization already in
progress (including draft flush and attachments) remains a handoff barrier.

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

No live installation, migration or reload is part of the offline test suite.
Use only the sanitized grouped procedure below; no `npm ci` or activation is
required or authorized by passing tests.

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
   the reviewed checkout, but treat those lazy version strings as checkout
   provenance, **not loaded-SHA attestation**. Record the new factory UUID from
   status after reload; it confirms a new factory, not exact source bytes.
   Do not add a second package/extension copy.
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


### Revised control boundaries and owner acceptance

Remote reload reserves its queue hold before the bounded receipt. Receipts describe
requested submission, coalescing, or refusal—not admission or reconnection. A
synchronous rejection cancels only that reservation; asynchronous interception
remains unknown and is never blindly retried. Both tool and remote scheduler check
the command catalog immediately before submission: exactly one bare bridge command
with this extension's `SourceInfo.path` is required. Missing/throwing catalogs,
foreign provenance, duplicates/namespaced collisions, and conflicting templates
are conservatively refused with a local-resolution hint (no paths sent to Telegram).
Pi dispatches extension commands before template/model processing; a missing command
can fall through, so catalog discovery alone is not authority. There is no atomic
host catalog-and-dispatch API: synchronous registry mutation/interception by other
extensions remains a host limit, not an acknowledgement or global prompt lock.

Explicit `/telegram-disconnect` cancels unsubmitted reservations and invalidates an
in-progress handoff at every existing pre-checkpoint await, including the persisted
session-file check. Accepted ingress carries its originating connection intent across
cursor/pairing writes: stale controls cannot reserve reload, compact, stop, or become
model input, and cancelled ingress cannot restart optional menu work.

Disconnect also pauses queued dispatch **in this instance**, not just new polling.
In-progress preparation and the current reply can finish; accepted ordinary text,
files, and albums retain a volatile FIFO queue plus durable input/reference
responsibility; attachment bytes and queue replay authority are not durable. Explicit
`/telegram-connect` wakes eligible queued work once without clearing stop-history,
uncertain-admission, or recovery holds. This is not durability across an ordinary
restart. The handoff's
internal poller stop is not cancellation. The supported cancellation boundary is
before checkpoint/teardown; after the terminal reload call, host lifecycle owns the
operation. Pending menu, identity and other transports must settle before lease release;
uncooperative cancellation can refuse replacement ownership.

After independent offline review, owner-only live checks: verify stale configured
username cannot control a different token's bot, then verify case-insensitive own
suffix and bare help/status/stop; check compact completion/failure; disconnect while
a reload receipt is delayed and confirm no reconnect; test a duplicate command
collision is refused; finally test authorized reload with queued files/FIFO and
one poller. Check the private menu in the client (API success is not cache refresh).
No live acceptance or publication readiness is claimed by the offline suite.

### Background completion reply routing

The jobs extension can capture the origin of an active **routing** Telegram turn
through public `pi.events`. On completion it requests a synchronous claim for
that exact original request. The bridge verifies the bounded versioned descriptor,
same-session identity, configuration digest, per-factory epoch, stop generation,
and integrity signature before accepting. The signature uses the existing
process-local reload key; it prevents edited record fields from redirecting a
reply, but is not a malicious-same-process sandbox.

Claims require a connected, idle bridge with no submitted/active/preflight turn,
FIFO/preparation/album debt, finalization, compaction, reload, stop-history,
disconnection/recovery, or uncertain-reply hold. An unavailable claim remains
pending in the job record, never becomes local input or another chat's answer.
Relevant normal lifecycle drains emit a small readiness hint for the jobs
extension's existing 500ms coalescer; there is no new watchdog.

Accepted completions use the ordinary owned Telegram queue, fresh submitted
marker, active turn, parent-model assessment and text/file finalizer.
`telegram_attach` works as usual. Continuation text/files reply to the original
message in the original private chat (including draft/message-preview paths).
The prompt identifies background results, not a fresh human instruction.
Descendant jobs inherit the **original** request, not an intervening conversation.

The optional reload checkpoint `bridgeEpoch` is restored only under the existing
one-shot, armed, unexpired, same-session/config/cursor live permit. Ordinary reload,
new/forked sessions and cold factories get new epochs; saved origins do not
reconnect or authorize replay. Any `/stop` invalidates older automatic
continuations even after unrelated new input. Explicit same-epoch reconnect may
release a disconnected origin, but never changes its destination.

Claim acknowledgement is queue ownership only. Pi's void `sendUserMessage` does
not expose asynchronous admission failures; a submitted continuation can still
need manual reconciliation. No durable inbox, parent assessment ledger, crash
recovery, send fallback repair or exactly-once guarantee is added. Existing send
fallback ambiguity is unchanged.

#### Offline project and cross-factory tests

Prerequisites: Node **22.22+** with synchronous module hooks/type stripping and
already-installed declared project peers. From any checkout, select Node through
your normal PATH **before** the runner sanitizes the child environment:

```sh
NODE=$(command -v node)
"$NODE" test/run-offline.mjs # primary checks; no external jobs repository required
# Equivalent: npm test
"$NODE" test/run-offline.mjs lease # one fixed group, in its own private environment
```

The runner uses a fresh mode-0700 HOME==TMPDIR for each explicit group, drops the
inherited environment (including Node options), and installs the existing offline
boundaries before factories. Primary groups are original, integration, config,
store, lease, portability. Do not run an ungrouped test glob. In the original
group, the 42 cross-factory cases are **skipped**, not passed, without jobs opt-in.
Runner interruption (including SIGINT/SIGTERM) can leave private scratch directories;
normal `finally` cleanup does not guarantee cleanup on signals.

Ordinary project dependency resolution is the default. For an isolated worktree
without peers, optionally supply absolute `PI_PACKAGE_DIR` (installed Pi package
root, resolving its public parser peer) and `TYPEBOX_PACKAGE_DIR` (installed
legacy `@sinclair/typebox` package root). Package entries are resolved through
Node's standard package resolver, not private build paths; no host SDK is imported
for discovery, no other checkouts are scanned, and nothing is downloaded.

Optional producer/consumer compatibility tests load both actual factories only
when the operator supplies an absolute `JOBS_SOURCE_ROOT` for a compatible jobs
checkout. These additionally require `PI_PACKAGE_DIR` for the producer's installed
loader/peers. They are not a prerequisite for the primary project checks:

```sh
JOBS_SOURCE_ROOT="$JOBS_SOURCE_ROOT" PI_PACKAGE_DIR="$PI_PACKAGE_DIR" \
  "$NODE" test/run-offline.mjs original
```

Set those variables to operator-selected directories before that command; empty
values are invalid. Optional dependency overrides are forwarded only by name.

The **separate OS suite** is never run by default. It requires POSIX directory
fsync and Python3 with stdlib `fcntl.flock`. Review the helper and private owner
fixture first, then explicitly run:

```sh
"$NODE" test/run-offline.mjs lease-os
# Optional absolute executable override: PI_TELEGRAM_PYTHON=/absolute/python3
```

Factory suites replace the exact lease helper with an inert file
fixture and the exact two job-wrapper fixtures; job output/exit files are
synthesized. **No Python, scratch script, real job or subprocess executes in
factories.** Fake fetch permits only exact fake-bot URLs. Socket/HTTP/DNS
Resolver/prototype/subprocess tripwires are defense in depth, **not an OS sandbox
or a ban on every conceivable native networking route**. Only the opted-in OS
suite executes one independently pinned Python inode with exact constant argv/fd
and the exact private Node-owner fixture. No operational PIDs are probed/signaled.

The protocol in `job-origin.ts` mirrors jobs' `origin.ts`; change/version together.


### Paired load and safe rollback

Both compatible jobs producer and Telegram consumer implementations must be
**loaded before origin capture**. Publishing source or staging a package is not
loading it. With an old or missing capture consumer, new jobs remain local;
existing uncaptured records also remain local. Never retag them or infer an
origin from the last chat. The new jobs producer holds captured origins pending
when their consumer is missing, incompatible, or otherwise ineligible. An **old
jobs producer cannot be assumed to honor captured origins**.

Before rollback, account for captured pending ownership and any already
transferred bridge-owned continuations. Keep the compatible producer/consumer
loaded to settle eligible work, or retain the records and suspend processing
until a compatible pair can safely resume within its valid session/epoch gates.
Do not run an old producer over captured pending records, erase origin metadata
or notification flags, or blindly replay work: rollback must not drop captured
pending ownership. Cold restart recovery is not promised by this protocol.

Source publication, package staging, extension activation/loading, and live
acceptance are separate operator steps; none has been performed by this patch's
offline verification.

### Durable incoming admission (bounded; no cold replay)

New authorized Telegram updates are retained under
`~/.pi/agent/telegram-inbox/<opaque-scope>/snapshot.json` **before** committing the
Telegram cursor or performing control/model effects. The scope is a
domain-separated SHA-256 of the token and authenticated user ID; neither the token
nor raw Telegram update is stored in the journal. Unsupported setup/login-like
controls retain only a bounded non-execution classification, not their arguments.
Private retained text/captions are sensitive. Media entries retain the exact opaque Telegram file ID, with safe
optional name/MIME metadata: **reference-only, not durable attachment bytes or a
promise that Telegram will still serve the file**.

Pairing and cursor are one atomic config replacement; memory advances only after
file and directory flush. Journal and config are separate files, not one atomic
transaction. A retained duplicate never repeats control/model effects. Initial
historical backlog skipping remains unchanged; there is no backfill. A missing
cursor (or missing pairing over existing tentative journal state), malformed
config, corrupt/foreign snapshot, or failed persistence requires operator repair,
not automatic deletion, initialization, reconnect or reset.

The bridge links incoming IDs through preparation, albums and stopped-history
folding. A new authenticated executable `/stop` normally retains admission and
held intent before applying local hold/abort, then commits the cursor. On
admission/quota/poison/stop/config failure it still holds/aborts locally and stops
unsafe intake/submission, without claiming durable stop or successful cursor
commit. Admission/stop failure never attempts cursor commit. Config failure after
rename may have changed disk; memory stays at its last confirmed cursor, with no
later polling acknowledgement or rollback. Stale/foreign/invalid/caption controls
and already-revoked intents do not execute. Disconnect during a pending cursor
write cannot undo a safety stop already recorded/applied before that await.
Slow downloads do not block intake of `/stop`.
`dispatching` is persisted synchronously before Pi's **void** submission API;
matching `before_agent_start` marks `active`, not successful completion. A failed
active marker retains volatile reply/origin/attachment routing and uncertainty:
the hook is not an execution veto, and no pre-agent abort is assumed to work. Only
successful existing local finalization/control handling marks `handled` (including
local abort/error reporting). This is **not goal completion, remote exactly-once
delivery, or confirmation of asynchronous control completion**. Failed/partial
final sends (including attachment failures even when the error notice succeeds)
and synchronous submission errors after possible effects retain
uncertainty; there are no new retries. Existing HTML/plain fallback remains.
Already-live subsequent FIFO messages may still run after reply uncertainty, but
uncertain ownership prevents identity changes and handoff. Synthetic job
continuations create **no incoming journal records**.

#### Local reconciliation

Use the TUI command `/telegram-inbox` (or `summary`) for content-free scope,
revision, stop latch and ID/phase/live counts. `/telegram-inbox show ID [PAGE]`
displays a zero-based page of at most 4096 quoted characters of the full retained
record, including metadata. The notification states the final page number.
Inspect **every page** locally before ACK; media has a reference-only warning. It does not inject a model turn or send anything to Telegram.
`/telegram-inbox acknowledge ID` requires a nonempty bounded reason and explicit
confirmation, then rechecks scope, exact record and live ownership. It refuses
all current volatile input, including preparing, held, submitted, active,
finalizing, failed-preparation and uncertain work. It is not offered remotely,
in RPC, or as a tool.

On cold/new/resumed/ordinary-reload activation, old nonterminal records are
**excluded from the live queue**. Explicit connection may retain new current-
process input but ordinary dispatch is gated until old ownership is reconciled.
Acknowledging the last old record may unblock those **new live queued inputs**;
it NEVER submits the old records and does not clear the stop latch. Persistence
failures need separately authorized repair; ACK is not a reset operation.

The existing one-shot same-process `/telegram-reload` capability remains the only
live queue handoff. Its checkpoint must agree on journal scope/revision/latch,
incoming IDs, immutable session/epoch and turn markers before restoring work.
Legacy permitted same-process checkpoints without incoming IDs remain compatible,
with a local warning that those turns are **not newly journal-protected**. Any
disagreement fails closed. Session entries alone never authorize replay.

#### One private profile writer, not a universal bot lock

One stable domain-separated profile lock protects this HOME profile's shared
`telegram.json`, first-unpaired intake, setup, and all journal scopes, independent
of token/principal. It is acquired before any polling/API acknowledgement,
configuration mutation, store open or local ACK. It does **not** coordinate other
HOME profiles, other bot clients or a headless bridge using the same token;
existing external one-poller coordination remains necessary.

Runtime prerequisites: POSIX owned private directories, `O_NOFOLLOW`, directory
fsync, and Python3 with stdlib `fcntl.flock` (not Windows support).
On acquisition, a read-only lazy resolver selects the first executable `python3`
in absolute PATH entries. Empty and relative entries (including `.`) are ignored; lookup is bounded
to 128 entries, 32 KiB total and 4096 bytes per path. Alternatively set
`PI_TELEGRAM_PYTHON` to one absolute Python3 executable (no arguments). An invalid
explicit override fails closed, never falls back. The operator must trust that
executable and PATH directories just as with the Node/Pi launcher; no candidates
are executed for discovery. Symlinked installed interpreters are supported.
The fixed isolated helper runs with `-I -S -c` constant code, no shell, no
configured arguments, only LANG/LC_ALL in its environment, fd3, and a three-second
timeout. Node retains the exclusive descriptor after helper exit. The mode-0700
journal root contains one stable empty mode-0600 `<profile-hash>.lock`; it is
**never deleted**, including after release. Missing support/contention fails
closed. Sanitized `python-unavailable` or `python-override-invalid` means install/provide
Python3 or correct the absolute override/PATH; `helper-unavailable` means verify
that the selected interpreter supports isolated mode and stdlib fcntl on this
POSIX filesystem. Diagnostics never expose the selected path or helper stderr.
Do not delete lockfiles or guess stale PIDs to resolve contention.

Acquisition is lazy, never at factory evaluation. Disconnect releases only after
all related volatile work is quiescent and the store is closed; otherwise it
retains ownership. Shutdown prevents further dispatch and defers descriptor
release until ongoing preparations/transports/finalizers settle. An uncooperative
old transport can therefore refuse a new factory's handoff rather than permit
concurrent writers. Kernel release on process exit does not authorize reconnect
or replay. A retired lease handle is not proof of release: ambiguous close is
never retried (the descriptor may be recycled), retains in-process exclusion and
latches controller refusal of later connect/setup/API/config/store/ACK activity.
Acquisition cleanup uncertainty is reported with sanitized fixed error codes.
New/switch/fork runtimes receive no automatic connection authority.

The store bounds each scope to 256 retained records and a 4 MiB canonical
snapshot (including reserved transition headroom); text/caption are each 64 KiB,
media references at most 16, file IDs at most 1024 bytes. Unresolved records are
never evicted. Only terminal records covered by the successfully persisted cursor
are compacted/pruned, with 32 recent tombstones retained. Quota blocks intake;
this is not a blob store, watchdog, job ledger or broader reliability framework.
Atomic rename/fsync is a local-filesystem boundary, not a hardware power-loss or
network-filesystem guarantee. Sync metadata operations can block the event loop.
Old scopes and abandoned temporary files require deliberate offline housekeeping;
no automatic migration/garbage collection is performed across scopes.

Before rollback to a version without admission, account for retained unresolved
ownership and stop intake; older versions do not honor this journal or lease.
Do not reset cursors, strip checkpoint IDs or run an older writer over unresolved
state. This implementation and its offline tests do not constitute publication,
installation, runtime activation, migration or live acceptance.
