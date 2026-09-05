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

Requires Pi **0.84.3 or newer** (`session_compact_failed`, `agent_settled`, and session-level idle semantics;
verified against 0.85.0). Telegram work waits for Pi to settle, including retries
and automatic compaction. Manual compaction success/failure also wakes the queue,
after a deferred idle/pending check. Albums reserve FIFO at first arrival, before
debounce and downloads. Each submitted prompt carries a unique turn marker;
unrelated local/jobs prompts never claim Telegram replies. `stop` holds queued
messages as ordered history for the next Telegram message.

Run deterministic offline regression tests with Node **22.22+**:

```bash
npm ci --ignore-scripts
npm test
```

Tests use a temporary HOME, fake Pi lifecycle, mocked fetch, and fake timers.
No bot, credentials, or model is used.

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
Queued work is session-local and is not restored after teardown; there is no
persistence or speculative retry. Check whether an unacknowledged prompt actually
ran before resending it.
