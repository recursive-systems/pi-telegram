import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHmac, createHash } from 'node:crypto';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { harness, deferred, until } from './harness.mjs';
import { telegramCommands, telegramHelp } from '../telegram-commands.ts';

const CHECKPOINT = 'telegram-reload-checkpoint-v1';
const CLAIM = 'telegram-reload-claim-v1';
const replies = h => h.network.filter(n => n.method === 'sendMessage').map(n => n.body.text).join('\n');
const text = content => content.filter(p => p.type === 'text').map(p => p.text).join('\n');
const ticks = async () => { await immediate(); await immediate(); };
const processState = () => globalThis[Symbol.for('pi-telegram.explicit-reload.v1')];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const savedCheckpoints = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  .map(line => JSON.parse(line)).filter(entry => entry.customType === CHECKPOINT).map(entry => entry.data);

test('/new is an explicit remote route, listed in help and in the scoped menu', async t => {
  assert.deepEqual(telegramCommands.filter(c => c.command === 'new').map(c => c.args), ['']);
  assert.match(telegramHelp([]), /\/new/);
  const h = await harness(t);
  await h.receive('/help');
  const menu = h.network.filter(n => n.method === 'setMyCommands').at(-1);
  assert.deepEqual(menu.body.commands, telegramCommands.map(({ command, description }) => ({ command, description })));
  assert.ok(menu.body.commands.some(c => c.command === 'new'));
  assert.match(replies(h), /\/new/);
  assert.equal(h.sent.length, 0);
});

test('happy path: /new replaces the session, keeps Telegram connected and confirms from the new instance', async t => {
  const h = await harness(t);
  const oldFile = h.sessionFile, oldSession = h.sessionId;
  await h.start('local'); await h.end(); await h.settle();
  await h.receive('/new');
  await until(() => h.generation === 2 && h.polling);
  // Replacement session: fresh identity, no inherited entries, checkpoint left behind.
  assert.notEqual(h.sessionFile, oldFile); assert.notEqual(h.sessionId, oldSession);
  assert.equal(h.entries.filter(e => e.customType === CHECKPOINT).length, 0);
  assert.deepEqual(h.entries.filter(e => e.customType === CLAIM).map(e => e.data.nonce).length, 1);
  const saved = await savedCheckpoints(oldFile);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].reason, 'telegram-new');
  assert.equal(saved[0].sessionFile, oldFile); assert.equal(saved[0].sessionId, oldSession);
  assert.deepEqual(saved[0].turns, []); assert.equal(saved[0].held, false); assert.equal(saved[0].connected, true);
  assert.equal(h.entries.filter(e => e.customType === CLAIM)[0].data.nonce, saved[0].nonce);
  // Cursor continuity: the probe and the resumed poller start after the /new update.
  const cursor = JSON.parse(await readFile(join(h.home, '.pi/agent/telegram.json'), 'utf8')).lastUpdateId;
  assert.equal(cursor, 1);
  assert.equal(h.network.find(n => n.method === 'getUpdates' && n.body.timeout === 0).body.offset, 2);
  assert.match(replies(h), /Requested \/telegram-new submission/);
  assert.match(replies(h), /New session started; Telegram reconnected/);
  assert.equal(h.sent.length, 0, 'no model turn is produced by /new');
  assert.equal(h.maxPolls, 1); assert.equal(h.errors.length, 0);
  assert.equal(processState().permits.size, 0, 'permit is consumed exactly once');
  assert.ok(!JSON.stringify(h.entries).includes('FAKE-OFFLINE'));
  // The replacement instance is an ordinary connected bridge.
  await h.receive('after the switch'); await until(() => h.sent.length === 1);
  assert.match(text(h.sent[0]), /after the switch/);
});

test('local /telegram-new works without a Telegram request and sends no receipt', async t => {
  const h = await harness(t);
  await h.start('local'); await h.end(); await h.settle();
  await h.command('telegram-new');
  await until(() => h.generation === 2 && h.polling);
  assert.equal((await savedCheckpoints(join(h.home, 'session.jsonl')))[0].request, undefined);
  assert.ok(!/New session started/.test(replies(h)));
  assert.ok(h.notices.some(n => /New Pi session started/.test(n.text)));
});

test('queued Telegram work refuses /new instead of being replayed or dropped', async t => {
  const h = await harness(t);
  await h.start('local');
  await h.receive('queued work that must survive');
  await h.receive('/new');
  await ticks();
  assert.equal(h.generation, 1); assert.equal(h.entries.length, 0);
  assert.match(replies(h), /New session refused: this bridge has queued/);
  assert.equal(h.polling, true, 'a refusal before teardown never disconnects');
  // The queued turn still runs in the original session.
  await h.end(); await h.settle(); await until(() => h.sent.length === 1);
  assert.match(text(h.sent[0]), /queued work that must survive/);
});

test('stop-held history refuses /new', async t => {
  const h = await harness(t);
  await h.start('local'); await h.receive('held'); await h.receive('stop');
  await h.end(); await h.settle();
  await h.receive('/new'); await ticks();
  assert.equal(h.generation, 1); assert.equal(h.entries.length, 0);
  assert.equal((await h.diagnostic()).held, true);
  assert.match(replies(h), /New session refused/);
  assert.equal(h.polling, true);
});

test('host still busy after quiescing refuses /new and reports it to Telegram', async t => {
  const h = await harness(t);
  await h.start('local');
  await h.receive('album', { media_group_id: 'album', photo: [{ file_id: 'photo' }] });
  const gate = deferred(); let downloading = false;
  h.networkGate = async method => { if (method === 'download') { downloading = true; await gate.promise; } };
  const requesting = h.receive('/new');
  await h.end(); await h.settle(); await until(() => downloading);
  h.pending = true; gate.resolve(); await requesting;
  for (let i = 0; i < 1000 && (await h.diagnostic()).reloadPending; i++) await ticks();
  assert.equal(h.generation, 1); assert.equal(h.entries.length, 0);
  assert.equal(h.polling, false, 'quiesced refusal stays disconnected until explicit connect');
  assert.match(replies(h), /New session refused before teardown/);
  assert.match(replies(h), /telegram-connect/);
});

test('a cancelled session_before_switch releases the permit and never reconnects', async t => {
  const h = await harness(t);
  await h.start('local'); await h.end(); await h.settle();
  h.cancelSwitch = true;
  await h.receive('/new');
  for (let i = 0; i < 1000 && (await h.diagnostic()).reloadPending; i++) await ticks();
  assert.equal(h.generation, 1); assert.equal(h.polling, false);
  assert.equal(processState().permits.size, 0, 'cancellation revokes the capability');
  assert.equal((await savedCheckpoints(h.sessionFile)).length, 1, 'checkpoint is retained as evidence');
  assert.match(replies(h), /New session cancelled locally/);
  assert.ok(h.notices.some(n => /cancelled by another extension/.test(n.text)));
  // No later lifecycle event may reconnect on the retained checkpoint.
  h.cancelSwitch = false;
  for (const reason of ['reload', 'new', 'startup']) {
    await h.replace(reason, false, { previousSessionFile: h.sessionFile });
    assert.equal(h.polling, false);
  }
  assert.equal(h.entries.filter(e => e.customType === CLAIM).length, 0);
});

test('an extension veto (cancel:true) is honoured like a local cancellation', async t => {
  const h = await harness(t, { companionFactory: api => api.on('session_before_switch', async () => ({ cancel: true })) });
  await h.start('local'); await h.end(); await h.settle();
  await h.command('telegram-new');
  assert.equal(h.generation, 1); assert.equal(h.polling, false);
  assert.equal(processState().permits.size, 0);
  assert.ok(h.notices.some(n => /cancelled by another extension/.test(n.text)));
});

for (const mode of ['absent', 'expired', 'unarmed', 'foreign-reason', 'own-session']) {
  test(`stale on-disk checkpoint with an ${mode} permit never reconnects a later /new`, async t => {
    const h = await harness(t, { connected: false });
    const cfg = JSON.parse(await readFile(join(h.home, '.pi/agent/telegram.json'), 'utf8'));
    const state = processState();
    const stale = join(h.home, 'previous.jsonl');
    const saved = {
      version: 1, reason: mode === 'foreign-reason' ? 'telegram-reload' : 'telegram-new',
      nonce: `stale-${mode}`,
      sessionId: mode === 'own-session' ? 'fake-session' : 'previous-session',
      sessionFile: mode === 'own-session' ? join(h.home, 'session.jsonl') : stale,
      request: { chatId: 70, messageId: 1 },
      configDigest: createHmac('sha256', state.key).update(JSON.stringify([cfg.botToken, cfg.botId, cfg.botUsername, cfg.allowedUserId])).digest('hex'),
      connected: true, cursor: 0, held: false, stopGeneration: 0, turns: [],
    };
    await writeFile(stale, JSON.stringify({ type: 'custom', customType: CHECKPOINT, data: saved }) + '\n');
    if (mode !== 'absent') state.permits.set(saved.nonce, { digest: digest(saved), armed: mode !== 'unarmed', expires: Date.now() + (mode === 'expired' ? -1 : 120_000) });
    try {
      const calls = h.network.length;
      await h.replace('new', false, { previousSessionFile: stale });
      await ticks();
      assert.equal(h.polling, false);
      assert.equal(h.network.length, calls, 'no API call is made without a live capability');
      assert.equal(h.entries.filter(e => e.customType === CLAIM).length, 0);
      assert.ok(h.notices.some(n => /No valid live Telegram new-session handoff/.test(n.text)));
      // An ordinary restart cannot use it either.
      await h.replace('startup');
      assert.equal(h.polling, false); assert.equal(h.network.length, calls);
    } finally { state.permits.delete(saved.nonce); }
  });
}

test('a telegram-new checkpoint can never be claimed by a reload start', async t => {
  const h = await harness(t, { connected: false });
  const cfg = JSON.parse(await readFile(join(h.home, '.pi/agent/telegram.json'), 'utf8'));
  const state = processState();
  const saved = {
    version: 1, reason: 'telegram-new', nonce: 'cross-kind-fixture',
    sessionId: 'fake-session', sessionFile: join(h.home, 'session.jsonl'),
    configDigest: createHmac('sha256', state.key).update(JSON.stringify([cfg.botToken, cfg.botId, cfg.botUsername, cfg.allowedUserId])).digest('hex'),
    connected: true, cursor: 0, held: false, stopGeneration: 0, turns: [],
  };
  h.entries.push({ type: 'custom', customType: CHECKPOINT, data: saved });
  state.permits.set(saved.nonce, { digest: digest(saved), armed: true, expires: Date.now() + 120_000 });
  try {
    await h.replace('reload');
    await ticks();
    assert.equal(h.polling, false); assert.equal(h.network.length, 0);
    assert.equal(h.entries.filter(e => e.customType === CLAIM).length, 0);
    assert.ok(h.notices.some(n => /No valid live Telegram reload handoff/.test(n.text)));
    assert.equal(state.permits.has(saved.nonce), false, 'the mismatched capability is consumed, not left armed');
  } finally { state.permits.delete(saved.nonce); }
});

test('a claimed /new permit is single-use: repeated starts cannot reconnect again', async t => {
  const h = await harness(t);
  const oldFile = h.sessionFile;
  await h.start('local'); await h.end(); await h.settle();
  await h.receive('/new');
  await until(() => h.generation === 2 && h.polling);
  const claims = h.entries.filter(e => e.customType === CLAIM).length;
  assert.equal(claims, 1);
  assert.equal(processState().permits.size, 0);
  const calls = h.network.length;
  // Same instance: repeated session_start is ignored outright.
  await h.emit('session_start', { reason: 'new', previousSessionFile: oldFile });
  assert.equal(h.network.length, calls);
  assert.equal(h.entries.filter(e => e.customType === CLAIM).length, claims);
  // Fresh instance pointed at the same previous file: the capability is gone.
  await h.replace('new', false, { previousSessionFile: oldFile });
  await until(() => h.notices.some(n => /No valid live Telegram new-session handoff/.test(n.text)));
  assert.equal(h.polling, false);
  assert.equal(h.network.length, calls);
  assert.equal(h.entries.filter(e => e.customType === CLAIM).length, claims, 'no second claim is written');
});

test('a replacement session without this extension cannot leave permission behind', async t => {
  const h = await harness(t);
  const oldFile = h.sessionFile;
  await h.start('local'); await h.end(); await h.settle();
  h.newSessionMode = 'omit-extension';
  await h.command('telegram-new');
  await until(() => h.generation === 2);
  await ticks();
  assert.equal(h.polling, false);
  assert.equal(processState().permits.size, 0, 'the capability is revoked when the originating call returns');
  assert.equal((await savedCheckpoints(oldFile)).length, 1);
  h.newSessionMode = 'normal';
  await h.replace('new', false, { previousSessionFile: oldFile });
  await ticks();
  assert.equal(h.polling, false);
  assert.equal(h.entries.filter(e => e.customType === CLAIM).length, 0);
});

test('a disconnected bridge stays disconnected across /new', async t => {
  const h = await harness(t, { connected: false });
  await h.command('telegram-new');
  await until(() => h.notices.some(n => /remains disconnected/.test(n.text)));
  assert.equal(h.polling, false); assert.equal(h.network.length, 0);
  assert.equal((await savedCheckpoints(join(h.home, 'session.jsonl')))[0].connected, false);
});

test('config drift between checkpoint and replacement blocks reconnection', async t => {
  const h = await harness(t);
  await h.start('local'); await h.end(); await h.settle();
  h.newSessionHook = async phase => {
    if (phase !== 'after') return;
    const path = join(h.home, '.pi/agent/telegram.json');
    const cfg = JSON.parse(await readFile(path, 'utf8'));
    cfg.allowedUserId = 8;
    await writeFile(path, JSON.stringify(cfg));
  };
  await h.receive('/new');
  await until(() => h.notices.some(n => /recovery required/.test(n.text)));
  await ticks();
  assert.equal(h.polling, false);
  assert.equal((await h.diagnostic()).recoveryRequired, true);
  assert.ok(!JSON.stringify(h.notices).includes('FAKE-OFFLINE'));
});

test('a truncated checkpoint in the previous session file fails closed and reports it', async t => {
  const h = await harness(t);
  await h.start('local'); await h.end(); await h.settle();
  h.newSessionHook = async phase => {
    if (phase === 'after') await writeFile(join(h.home, 'session.jsonl'), `{"type":"custom","customType":"${CHECKPOINT}","data":{"nonce"`);
  };
  await h.receive('/new');
  await until(() => h.notices.some(n => /could not be read/.test(n.text)));
  await ticks();
  assert.equal(h.polling, false);
  assert.equal(h.entries.filter(e => e.customType === CLAIM).length, 0);
});

test('a missing previous session file is an ordinary silent cold start (fresh local /new never touched Telegram)', async t => {
  const h = await harness(t);
  await h.start('local'); await h.end(); await h.settle();
  let calls;
  h.newSessionHook = async phase => {
    if (phase !== 'after') return;
    await rm(join(h.home, 'session.jsonl'));
    calls = h.network.length;
  };
  await h.receive('/new');
  await until(() => h.generation === 2);
  await ticks();
  assert.equal(h.polling, false);
  assert.equal(h.network.length, calls, 'no API call without a readable checkpoint');
  assert.equal(h.entries.filter(e => e.customType === CLAIM).length, 0);
  assert.ok(!h.notices.some(n => /could not be read/.test(n.text)), 'ENOENT is absence, not damage');
  assert.ok(!h.notices.some(n => /No valid live/.test(n.text)));
});

test('an oversized session file refuses /new before teardown and stays connected', async t => {
  const h = await harness(t);
  await h.start('local'); await h.end(); await h.settle();
  const originalStat = fsPromises.stat;
  const file = h.sessionFile;
  const mocked = t.mock.method(fsPromises, 'stat', async (path, ...args) => {
    const info = await originalStat(path, ...args);
    if (path === file) Object.defineProperty(info, 'size', { value: 64 * 1024 * 1024 + 1 });
    return info;
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await h.receive('/new');
  await ticks();
  assert.equal(h.generation, 1); assert.equal(h.polling, true, 'refused before any teardown');
  assert.equal((await savedCheckpoints(file)).length, 0, 'no checkpoint is written');
  assert.equal(processState().permits.size, 0);
  assert.match(replies(h), /previous session file too large/);
  assert.ok(h.notices.some(n => /too large/.test(n.text)));
  assert.equal((await h.diagnostic()).reloadPending, false);
});

test('/new takes no arguments', async t => {
  const h = await harness(t);
  await h.receive('/new extra');
  await ticks();
  assert.match(replies(h), /^Usage: \/new$/m);
  assert.equal(h.submissions.length, 0); assert.equal(h.generation, 1);
});

test('a /new checkpoint armed by a reload-kind shutdown never reconnects', async t => {
  const h = await harness(t);
  const oldFile = h.sessionFile;
  await h.start('local'); await h.end(); await h.settle();
  // The host's real shutdown{new} follows but is ignored: this instance is already closed.
  let calls;
  h.newSessionHook = async phase => { if (phase === 'before') { await h.emit('session_shutdown', { reason: 'reload' }); calls = h.network.length; } };
  await h.receive('/new');
  await until(() => h.generation === 2);
  await until(() => h.notices.some(n => /No valid live Telegram new-session handoff/.test(n.text)));
  await ticks();
  assert.equal(h.polling, false);
  assert.equal(h.entries.filter(e => e.customType === CLAIM).length, 0);
  assert.equal(h.network.length, calls, 'no API call from the replacement');
  assert.equal((await savedCheckpoints(oldFile)).length, 1);
  assert.equal(processState().permits.size, 0);
});

test('a reload checkpoint armed by a new-kind shutdown never reconnects', async t => {
  const h = await harness(t);
  await h.start('local'); await h.end(); await h.settle();
  let calls;
  h.reloadHook = async phase => { if (phase === 'before') { await h.emit('session_shutdown', { reason: 'new' }); calls = h.network.length; } };
  await h.command('telegram-reload');
  await until(() => h.generation === 2);
  await until(() => h.notices.some(n => /No valid live Telegram reload handoff/.test(n.text)));
  await ticks();
  assert.equal(h.polling, false);
  assert.equal(h.entries.filter(e => e.customType === CLAIM).length, 0);
  assert.equal(h.network.length, calls);
  assert.equal(processState().permits.size, 0);
});

test('a previous session without a checkpoint starts cold and silent', async t => {
  const h = await harness(t, { connected: false });
  const previous = join(h.home, 'plain.jsonl');
  await writeFile(previous, JSON.stringify({ type: 'session', id: 'previous-session' }) + '\n');
  const notices = h.notices.length, calls = h.network.length;
  await h.replace('new', false, { previousSessionFile: previous });
  await ticks();
  assert.equal(h.polling, false); assert.equal(h.network.length, calls);
  assert.equal(h.notices.length, notices);
});

test('a never-persisted session refuses /new and reports it remotely', async t => {
  const h = await harness(t, { persisted: false });
  await h.receive('/new');
  await ticks();
  assert.equal(h.generation, 1); assert.equal(h.polling, true);
  assert.match(replies(h), /has not been saved to disk yet/);
});

test('/new coalesces with a pending reload request without claiming a new session', async t => {
  const h = await harness(t);
  await h.start('local');
  await h.receive('/reload');
  await h.receive('/new');
  assert.match(replies(h), /A Telegram handoff is already pending; \/new was not submitted/);
  assert.equal(h.submissions.filter(s => s.content === '/telegram-new').length, 0);
  await h.end(); await h.settle(); await until(() => h.generation === 2 && h.polling);
  assert.equal((await savedCheckpoints(join(h.home, 'session.jsonl')))[0].reason, 'telegram-reload');
});

test('a foreign or missing telegram-new command refuses the remote route', async t => {
  const h = await harness(t, { reloadCatalog: [{ name: 'telegram-new', source: 'extension', sourceInfo: { path: '/foreign' } }] });
  await h.receive('/new');
  assert.equal(h.submissions.length, 0); assert.equal(h.sent.length, 0);
  assert.match(replies(h), /refused or cancelled/i);
  assert.equal(h.generation, 1);
});

test('explicit disconnect cancels a delayed /new reservation', async t => {
  const h = await harness(t); const gate = deferred(); let entered = false;
  h.networkGate = async (method, body) => { if (method === 'sendMessage' && body.text.startsWith('Requested /telegram-new')) { entered = true; await gate.promise; } };
  h.push('/new'); await until(() => entered);
  const disconnecting = h.command('telegram-disconnect'); gate.resolve(); await disconnecting; await ticks();
  assert.equal(h.submissions.length, 0); assert.equal(h.generation, 1); assert.equal(h.polling, false);
  assert.equal((await h.diagnostic()).reloadPending, false);
});
