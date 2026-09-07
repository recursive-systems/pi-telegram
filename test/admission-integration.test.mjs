import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { harness, until, deferred } from './harness.mjs';
import { leaseBoundary } from './admission-harness-boundary.mjs';
import { AdmissionStore } from '../admission-store.ts';
import { AdmissionLease } from '../admission-lease.ts';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope = hash(['pi-telegram/admission-records/v1', 'FAKE-OFFLINE', 7]);
const profile = hash(['pi-telegram/profile-writer/v1']);
const root = h => join(fs.realpathSync(h.home), '.pi/agent/telegram-inbox');
const file = h => join(root(h), scope, 'snapshot.json');
const snapshot = h => JSON.parse(fs.readFileSync(file(h), 'utf8'));
const config = h => JSON.parse(fs.readFileSync(join(h.home, '.pi/agent/telegram.json'), 'utf8'));
const text = h => h.sent.map(c => c.filter(p => p.type === 'text').map(p => p.text).join('\n')).join('\n');
const update = (id, text, extra = {}) => ({ update_id: id, message: { message_id: id, chat: { id: 70, type: 'private' }, from: { id: 7 }, text, ...extra } });
const idle = async () => { await tick(); await tick(); };
async function fault(h) { await until(() => h.statuses.some(s => /admission interrupted/.test(s))); await idle(); }
function privateStore(h, fn) {
  const lease = AdmissionLease.acquire(root(h), profile);
  const store = AdmissionStore.open(root(h), scope);
  try { return fn(store); } finally { store.close(); lease.release(); }
}

test('durable DTO precedes config commit, preparation and void submission', async t => {
  const h = await harness(t);
  let checked = false;
  h.configWrite = async next => {
    if (next.lastUpdateId !== 1) return;
    const record = snapshot(h).records[0];
    assert.equal(record.phase, 'received'); assert.equal(record.input.text, 'request');
    assert.equal(config(h).lastUpdateId, 0); assert.equal(h.sent.length, 0);
    assert.equal(h.network.some(n => n.method === 'getFile'), false); checked = true;
  };
  h.onSend = () => assert.equal(snapshot(h).records[0].phase, 'dispatching');
  await h.receive('request'); await until(() => h.sent.length === 1);
  assert.ok(checked); assert.equal(config(h).lastUpdateId, 1);
  assert.equal(fs.statSync(join(h.home, '.pi/agent/telegram.json')).mode & 0o777, 0o600);
});

test('cursor write failure retains admission, old memory offset, no effects or continued intake', async t => {
  const h = await harness(t); h.configWrite = async () => { throw new Error('PRIVATE failure'); };
  h.push('request'); await fault(h);
  assert.equal(config(h).lastUpdateId, 0); assert.equal(snapshot(h).records[0].phase, 'received');
  assert.equal(h.sent.length, 0); assert.equal(h.polling, false);
  assert.equal(h.network.filter(n => n.method === 'getUpdates').at(-1).body.offset, 1);
  assert.ok(!h.statuses.join(' ').includes('PRIVATE'));
  h.configWrite = async () => {}; await h.command('telegram-connect'); assert.equal(h.polling, false);
});

test('journal rename failure still locally stops active work without committing cursor', async t => {
  const h = await harness(t); await h.start('local'); const original = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (...args) => { if (String(args[1]).endsWith('snapshot.json')) throw new Error('PRIVATE'); return original(...args); });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  h.push('/stop'); await fault(h);
  assert.equal(config(h).lastUpdateId, 0); assert.equal(h.aborts, 1);
  assert.equal((await h.diagnostic()).held, true);
  assert.equal(h.network.some(n => n.method === 'sendMessage'), false);
});

test('first-user pairing and cursor are one immutable commit, with one local notice and reply', async t => {
  const h = await harness(t, { config: { allowedUserId: undefined } }); let writes = 0;
  h.configWrite = async next => { writes++; assert.equal(next.allowedUserId, 7); assert.equal(next.lastUpdateId, 1); assert.equal(config(h).allowedUserId, undefined); assert.equal(snapshot(h).records.length, 1); };
  await h.receive('/start'); await idle();
  assert.equal(writes, 1); assert.equal(config(h).allowedUserId, 7);
  assert.equal(h.notices.filter(n => n.text.includes('paired with')).length, 1);
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text.includes('paired with')).length, 1);
  const count = h.network.filter(n => n.method === 'sendMessage').length;
  h.deliver(update(1, '/start')); await until(() => h.polling);
  assert.equal(h.network.filter(n => n.method === 'sendMessage').length, count);
});

test('failed first pairing commit leaves config unpaired and durable first-user responsibility', async t => {
  const h = await harness(t, { config: { allowedUserId: undefined } });
  h.configWrite = async () => { throw new Error('fail'); }; h.push('/start'); await fault(h);
  assert.equal(config(h).allowedUserId, undefined); assert.equal(snapshot(h).records[0].input.userId, 7);
  assert.equal(h.network.some(n => n.method === 'sendMessage'), false);
});

test('retained duplicate reuses immutable origin/time and never resubmits', async t => {
  const h = await harness(t); await h.receive('same'); const before = snapshot(h);
  h.deliver(update(1, 'same')); await until(() => h.polling); await idle();
  assert.deepEqual(snapshot(h), before); assert.equal(h.sent.length, 1);
});

test('semantic mismatch for retained duplicate fails closed without repeating effects', async t => {
  const h = await harness(t); await h.receive('original'); h.deliver(update(1, 'changed')); await fault(h);
  assert.equal(h.sent.length, 1); assert.equal(snapshot(h).records[0].input.text, 'original');
});

test('media remains bounded opaque reference-only; unsafe optional filename/MIME does not alter identity', async t => {
  const h = await harness(t); const gate = deferred(); let entered = false;
  h.networkGate = async method => { if (method === 'getFile') { entered = true; await gate.promise; } };
  const id = 'opaque:/+=? with Unicode é';
  await h.receive('caption-like text', { document: { file_id: id, file_name: '../\u001b[31m/..', mime_type: 'bad\r\nheader' } });
  await until(() => entered);
  const media = snapshot(h).records[0].input.media[0];
  assert.equal(media.fileId, id); assert.equal(media.retention, 'telegram-reference-only');
  assert.equal(media.name, undefined); assert.equal(media.mime, undefined);
  assert.equal(config(h).lastUpdateId, 1); assert.equal(h.sent.length, 0);
  await h.receive('/stop');
  assert.equal(snapshot(h).records[0].phase, 'held'); assert.equal(snapshot(h).stopLatched, true);
  gate.resolve(); await until(() => (snapshot(h).records[0].turnMarker));
  assert.equal(h.sent.length, 0);
});

test('albums and stopped-history folding preserve exact incoming IDs and journal markers', async t => {
  const h = await harness(t); await h.start('local');
  await h.receive('part one', { media_group_id: 'a', document: { file_id: 'one' } });
  await h.receive('part two', { media_group_id: 'a', document: { file_id: 'two' } });
  await h.receive('/stop'); t.mock.timers.tick(1200);
  await until(() => snapshot(h).records[0].turnMarker);
  assert.equal(snapshot(h).records[0].turnMarker, snapshot(h).records[1].turnMarker);
  await h.end(); await h.settle(); await h.receive('continue'); await until(() => h.sent.length === 1);
  const records = snapshot(h).records.filter(r => r.phase === 'dispatching');
  assert.deepEqual(records.map(r => r.updateId), [1, 2, 4]); assert.equal(new Set(records.map(r => r.turnMarker)).size, 1);
  await h.start(); await h.end(); await h.settle();
  assert.ok(snapshot(h).records.every(r => r.phase === 'handled'));
});

test('failed preparation retains honest media refs and blocks dispatch with live ACK refusal', async t => {
  const h = await harness(t, { input: async () => 'resolved', confirm: async () => true });
  h.networkGate = async method => { if (method === 'getFile') throw new Error('PRIVATE'); };
  await h.receive('request', { document: { file_id: 'opaque' } });
  await until(() => h.statuses.some(s => s.includes('preparation failed')));
  assert.equal(snapshot(h).records[0].input.media[0].fileId, 'opaque');
  await h.command('telegram-inbox', 'acknowledge 1'); assert.notEqual(snapshot(h).records[0].phase, 'acknowledged');
  assert.equal(h.sent.length, 0);
});

test('void host swallowing leaves dispatching ownership; unrelated lifecycle cannot mark handled', async t => {
  const h = await harness(t); h.onSend = () => {}; await h.receive('request');
  await h.start('unrelated local'); await h.end(); await h.settle();
  assert.equal(snapshot(h).records[0].phase, 'dispatching');
  await h.command('telegram-inbox', 'acknowledge 1'); assert.equal(snapshot(h).records[0].phase, 'dispatching');
});

test('matching active marker is not completion; only successful local finalization marks handled', async t => {
  const h = await harness(t); await h.receive('request'); await h.start(); assert.equal(snapshot(h).records[0].phase, 'active');
  await h.end('answer'); assert.equal(snapshot(h).records[0].phase, 'active');
  const gate = deferred(); let sending = false;
  h.networkGate = async method => { if (method === 'sendMessage') { sending = true; await gate.promise; } };
  const settling = h.settle(); await until(() => sending);
  await h.command('telegram-inbox', 'acknowledge 1'); assert.equal(snapshot(h).records[0].phase, 'active');
  gate.resolve(); await settling;
  const record = snapshot(h).records[0]; assert.equal(record.phase, 'handled'); assert.match(record.disposition.note, /local handling only/);
});

test('partial/failed final send is uncertain, not handled; current volatile uncertainty cannot be ACKed', async t => {
  const h = await harness(t); await h.receive('request'); await h.start();
  h.networkGate = async method => { if (method === 'sendMessage') throw new Error('transport'); };
  await h.end('answer'); await h.settle(); assert.equal(snapshot(h).records[0].phase, 'uncertain');
  await h.command('telegram-inbox', 'acknowledge 1'); assert.equal(snapshot(h).records[0].phase, 'uncertain');
});

test('error after synchronous host effects remains uncertain and is never automatically submitted again', async t => {
  const h = await harness(t); h.onSend = () => { throw new Error('after effect'); };
  await h.receive('request'); assert.equal(snapshot(h).records[0].phase, 'uncertain');
  h.onSend = () => {}; await h.settle(); await h.command('telegram-connect'); assert.equal(h.sent.length, 1);
});

for (const reason of ['new', 'resume', 'reload']) test(`cold ${reason}: old records excluded, new held input unblocked only by local reasoned confirmed ACK`, async t => {
  const confirmations = []; const h = await harness(t, { input: async () => 'Resolved outside this bridge', confirm: async (...args) => { confirmations.push(args); return true; } });
  await h.receive('OLD INPUT'); await h.replace(reason);
  assert.equal(h.polling, false); assert.equal(h.sent.length, 1);
  await h.command('telegram-connect'); await until(() => h.polling);
  await h.receive('NEW INPUT'); assert.equal(h.sent.length, 1); assert.equal((await h.diagnostic()).admission.interrupted, 1);
  await h.command('telegram-inbox', 'show 1'); assert.match(h.notices.at(-1).text, /OLD INPUT/); assert.match(h.notices.at(-1).text, /no durable attachment bytes/);
  await h.command('telegram-inbox', 'acknowledge 2'); assert.equal(confirmations.length, 0);
  await h.command('telegram-inbox', 'acknowledge 1'); await until(() => h.sent.length === 2);
  assert.match(confirmations[0][1], /NEW current-process queued/); assert.match(confirmations[0][1], /NEVER submits old/);
  assert.equal(snapshot(h).records[0].phase, 'acknowledged'); assert.match(text(h).split('[telegram]').at(-1), /NEW INPUT/);
  assert.doesNotMatch(text(h).split('[telegram]').at(-1), /OLD INPUT/);
});

for (const mode of ['no-ui', 'rpc', 'empty-reason', 'cancel']) test(`local ACK refuses ${mode}`, async t => {
  const h = await harness(t, { input: async () => mode === 'empty-reason' ? ' ' : 'resolved', confirm: async () => mode !== 'cancel' });
  await h.receive('old'); await h.replace('new'); await h.command('telegram-connect'); await until(() => h.polling);
  if (mode === 'no-ui') h.ctx.hasUI = false;
  if (mode === 'rpc') h.ctx.mode = 'rpc';
  await h.command('telegram-inbox', 'acknowledge 1'); assert.notEqual(snapshot(h).records[0].phase, 'acknowledged');
});

test('ACK preserves durable stop latch and never enables old work', async t => {
  const h = await harness(t, { input: async () => 'resolved', confirm: async () => true }); await h.start('local');
  await h.receive('held'); await h.receive('/stop'); await h.replace('new'); await h.command('telegram-connect'); await until(() => h.polling);
  await h.command('telegram-inbox', 'acknowledge 1'); await idle(); assert.equal(snapshot(h).stopLatched, true); assert.equal(h.sent.length, 0);
});

test('profile lease precedes first-unpaired polling, config setup, store open and ACK', async t => {
  const h = await harness(t, { connected: false, config: { allowedUserId: undefined }, input: async () => 'FAKE-OFFLINE' });
  fs.mkdirSync(root(h), { mode: 0o700 }); const lease = AdmissionLease.acquire(root(h), profile);
  try {
    await assert.rejects(h.command('telegram-connect'), /already-owned/);
    await h.command('telegram-setup'); await h.command('telegram-inbox', 'acknowledge 1');
    assert.equal(h.network.length, 0); assert.equal(config(h).lastUpdateId, 0); assert.equal(fs.existsSync(file(h)), false);
  } finally { lease.release(); }
});

test('one profile lock excludes a different token/principal, and setup cannot retag live work', async t => {
  const h = await harness(t, { input: async () => 'OTHER-TOKEN' }); await h.receive('live'); await h.command('telegram-disconnect');
  const original = snapshot(h);
  await h.command('telegram-setup'); assert.equal(config(h).botToken, 'FAKE-OFFLINE');
  fs.writeFileSync(join(h.home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: 'OTHER-TOKEN', allowedUserId: 8, lastUpdateId: 1 }));
  await h.command('telegram-connect'); assert.equal(h.polling, false); assert.deepEqual(snapshot(h), original);
  assert.throws(() => AdmissionLease.acquire(root(h), profile), /already-owned/);
});

test('quiescent disconnect releases descriptor but never deletes stable lockfile', async t => {
  const h = await harness(t); const lock = join(root(h), `${profile}.lock`), before = fs.statSync(lock).ino;
  await h.command('telegram-disconnect'); const lease = AdmissionLease.acquire(root(h), profile); lease.release();
  assert.equal(fs.statSync(lock).ino, before);
});

test('explicit reload requires journal revision agreement before restoring linked queue', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('queued'); await h.end();
  h.idle = true;
  h.reloadHook = async stage => { if (stage === 'after') privateStore(h, store => store.stop([1])); };
  await h.command('telegram-reload'); assert.equal(h.generation, 2); assert.equal((await h.diagnostic()).recoveryRequired, true);
  assert.equal((await h.diagnostic()).queued, 0); assert.equal(h.sent.length, 0); assert.equal(h.polling, false);
});

test('explicit agreed reload restores only linked live turns, with immutable journal origin', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('queued'); await h.end(); h.idle = true;
  const original = snapshot(h).records[0].input;
  await h.command('telegram-reload'); await until(() => h.sent.length === 1);
  const saved = h.entries.find(e => e.customType === 'telegram-reload-checkpoint-v1').data;
  assert.equal(saved.admission.scope, scope); assert.deepEqual(saved.turns[0].incomingIds, [1]); assert.deepEqual(snapshot(h).records[0].input, original);
});

for (const damage of ['corruption', 'foreign-scope', 'missing-cursor']) test(`${damage} never resets journal/cursor or polls`, async t => {
  const h = await harness(t); await h.receive('old'); await h.shutdown();
  if (damage === 'missing-cursor') fs.writeFileSync(join(h.home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: 'FAKE-OFFLINE', allowedUserId: 7 }));
  else if (damage === 'corruption') fs.writeFileSync(file(h), '{bad');
  else fs.writeFileSync(file(h), fs.readFileSync(file(h), 'utf8').replaceAll(scope, 'f'.repeat(64)));
  const before = fs.readFileSync(file(h), 'utf8'), calls = h.network.length;
  await h.replace('new'); await h.command('telegram-connect'); assert.equal(h.polling, false);
  assert.equal(h.network.length, calls); assert.equal(fs.readFileSync(file(h), 'utf8'), before);
});

test('quota refuses new admission/cursor without evicting old unresolved work', async t => {
  const h = await harness(t); await h.command('telegram-disconnect');
  privateStore(h, store => { for (let id = 10; id < 266; id++) store.admit({ sessionId: 'old', epoch: 'old', updateId: id, chatId: 70, userId: 7, messageId: id, receivedAt: 1, text: 'old', media: [] }); });
  await h.command('telegram-connect'); await until(() => h.polling); h.push('new'); await fault(h);
  assert.equal(snapshot(h).records.length, 256); assert.equal(config(h).lastUpdateId, 0); assert.equal(h.sent.length, 0);
});

test('stop persistence failure still aborts and holds without cursor commit', async t => {
  const h = await harness(t); await h.receive('active'); await h.start();
  const original = AdmissionStore.prototype.stop;
  t.mock.method(AdmissionStore.prototype, 'stop', () => { throw new Error('stop persist failed'); });
  h.push('/stop'); await fault(h); assert.equal(h.aborts, 1); assert.equal((await h.diagnostic()).held, true);
  assert.equal(snapshot(h).records[0].phase, 'active'); assert.equal(config(h).lastUpdateId, 1);
  AdmissionStore.prototype.stop = original;
});


test('valid same-process legacy checkpoint remains permitted but is not newly journal-protected', async t => {
  const h = await harness(t, { connected: false });
  const state = globalThis[Symbol.for('pi-telegram.explicit-reload.v1')];
  const c = config(h), marker = '[turn:legacy-fixture]';
  const saved = { version: 1, reason: 'telegram-reload', nonce: 'legacy-one-shot-fixture',
    sessionId: 'fake-session', sessionFile: join(h.home, 'session.jsonl'),
    configDigest: createHmac('sha256', state.key).update(JSON.stringify([c.botToken, c.botId, c.botUsername, c.allowedUserId])).digest('hex'),
    connected: true, cursor: 0, held: false, stopGeneration: 0,
    turns: [{ marker, chatId: 70, replyToMessageId: 1, queuedAttachments: [], content: [{ type: 'text', text: `[telegram] ${marker} legacy live input` }], historyText: 'legacy live input' }] };
  h.entries.push({ type: 'custom', customType: 'telegram-reload-checkpoint-v1', data: saved });
  state.permits.set(saved.nonce, { digest: hash(saved), armed: true, expires: Date.now() + 120000 });
  await h.replace('reload'); await until(() => h.sent.length === 1);
  assert.equal(snapshot(h).records.length, 0); assert.match(h.notices.map(n => n.text).join(' '), /not newly journal-protected/);
  assert.equal(state.permits.has(saved.nonce), false);
});

test('uncooperative old transport retains lease through teardown; failed handoff never later auto-replays', async t => {
  const h = await harness(t); const gate = deferred(); let pending = false;
  h.networkGate = async method => { if (method === 'setMyCommands') { pending = true; await gate.promise; } };
  await h.start('local'); await h.receive('queued'); await until(() => pending); await h.end(); h.idle = true;
  await h.command('telegram-reload'); assert.equal(h.generation, 2); assert.equal((await h.diagnostic()).recoveryRequired, true);
  assert.throws(() => AdmissionLease.acquire(root(h), profile), /already-owned/);
  gate.resolve(); await idle(); const lease = AdmissionLease.acquire(root(h), profile); lease.release();
  await h.command('telegram-connect'); assert.equal(h.sent.length, 0); assert.equal(h.polling, false);
});

test('cold unpaired profile with prior tentative admission requires repair, not another principal claim', async t => {
  const h = await harness(t, { config: { allowedUserId: undefined } });
  h.configWrite = async () => { throw new Error('fail'); }; h.push('first user'); await fault(h);
  await h.replace('new'); h.configWrite = async () => {}; const calls = h.network.length;
  await h.command('telegram-connect'); assert.equal(h.polling, false); assert.equal(h.network.length, calls);
  assert.equal(config(h).allowedUserId, undefined); assert.equal(snapshot(h).records[0].input.userId, 7);
});

test('synthetic origin continuation never creates or retags an incoming journal record', async t => {
  const h = await harness(t); await h.receive('original'); await h.start(); let origin;
  h.bus.emit('jobs:origin:capture:v1', { sessionId: 'fake-session', capture: value => { origin = value; } });
  assert.ok(origin); await h.end('started'); await h.settle();
  const before = snapshot(h); let accepted = false;
  h.bus.emit('jobs:origin:claim:v1', { origin, text: '[jobs] Completed background jobs: fake result', accept: () => { accepted = true; } });
  assert.ok(accepted); assert.equal(h.sent.length, 2); assert.deepEqual(snapshot(h), before);
  await h.start(); await h.end('assessment'); await h.settle(); assert.deepEqual(snapshot(h), before);
});

test('control error after abort retains uncertainty and never repeats the abort', async t => {
  const h = await harness(t); await h.start('local');
  h.networkGate = async method => { if (method === 'sendMessage') throw new Error('private'); };
  h.push('/stop'); await fault(h);
  assert.equal(h.aborts, 1); assert.equal(snapshot(h).records[0].phase, 'uncertain');
  await h.command('telegram-connect'); assert.equal(h.aborts, 1); assert.equal(h.polling, false);
});

test('terminal-only capacity is pruned with confirmed cursor before admitting new work', async t => {
  const h = await harness(t); await h.command('telegram-disconnect');
  privateStore(h, store => { for (let id = 1; id <= 256; id++) {
    store.admit({ sessionId: 'old', epoch: 'old', updateId: id, chatId: 70, userId: 7, messageId: id, receivedAt: 1, text: 'old', media: [] });
    store.acknowledge(id, { at: 1, note: 'fixture resolved' });
  } });
  fs.writeFileSync(join(h.home, '.pi/agent/telegram.json'), JSON.stringify({ ...config(h), lastUpdateId: 256 }));
  await h.command('telegram-connect'); await until(() => h.polling); h.deliver(update(257, 'new'));
  await until(() => h.sent.length === 1);
  assert.equal(config(h).lastUpdateId, 257); assert.ok(snapshot(h).records.length <= 33);
});

test('unsupported setup-like control persists only non-execution classification, not secret-like arguments', async t => {
  const h = await harness(t); let retained;
  h.configWrite = async () => { retained = snapshot(h).records[0].input.text; };
  await h.receive('/telegram-setup PRIVATE-CREDENTIAL-FIXTURE');
  assert.equal(retained, '[telegram-control:unsupported]'); assert.equal(h.sent.length, 0);
  assert.ok(!fs.readFileSync(file(h), 'utf8').includes('PRIVATE-CREDENTIAL-FIXTURE'));
});


test('ACK rechecks exact retained record after human confirmation before writing disposition', async t => {
  let ownedStore;
  const original = AdmissionStore.prototype.inspect;
  const mock = t.mock.method(AdmissionStore.prototype, 'inspect', function () { ownedStore = this; return original.call(this); });
  const h = await harness(t, { input: async () => 'resolved', confirm: async () => {
    ownedStore.transition([{ updateId: 1, phase: 'held' }]); return true;
  } });
  await h.receive('old'); await h.replace('new'); await h.command('telegram-connect'); await until(() => h.polling);
  await h.command('telegram-inbox', 'acknowledge 1');
  assert.equal(snapshot(h).records[0].phase, 'held'); assert.match(h.notices.at(-1).text, /refused/);
  mock.mock.restore();
});

test('config rename-then-error never acknowledges newer input or replays ambiguous admission', async t => {
  const h = await harness(t); const rename = fsPromises.rename;
  const mock = t.mock.method(fsPromises, 'rename', async (...args) => { await rename(...args); throw new Error('ambiguous'); });
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  h.push('ambiguous'); await fault(h);
  assert.equal(config(h).lastUpdateId, 1); assert.equal(snapshot(h).records[0].phase, 'received');
  assert.equal(h.sent.length, 0); assert.equal(h.network.filter(n => n.method === 'getUpdates').at(-1).body.offset, 1);
  mock.mock.restore(); syncBuiltinESMExports();
  await h.replace('new'); await h.command('telegram-connect'); await until(() => h.polling);
  assert.equal(h.sent.length, 0); assert.equal((await h.diagnostic()).admission.interrupted, 1);
});

for (const stage of ['admit', 'quota', 'poison', 'config-before', 'config-after']) test(`new stop with active parent survives ${stage} persistence failure`, async t => {
  const h = await harness(t);
  if (stage === 'quota') {
    await h.command('telegram-disconnect');
    privateStore(h, store => { for (let id = 10; id < 266; id++) store.admit({ sessionId: 'old', epoch: 'old', updateId: id, chatId: 70, userId: 7, messageId: id, receivedAt: 1, text: 'old', media: [] }); });
    await h.command('telegram-connect'); await until(() => h.polling);
  }
  await h.start('active parent'); let commits = 0;
  h.configWrite = async () => { commits++; if (stage === 'config-before') throw new Error('private'); };
  if (stage === 'admit') t.mock.method(AdmissionStore.prototype, 'admit', () => { throw new Error('private'); });
  if (stage === 'poison') {
    let store; const inspect = AdmissionStore.prototype.inspect;
    const m = t.mock.method(AdmissionStore.prototype, 'inspect', function () { store = this; return inspect.call(this); });
    await h.command('telegram-inbox', 'summary'); m.mock.restore(); assert.ok(store);
    const rename = fs.renameSync; const bad = t.mock.method(fs, 'renameSync', () => { throw new Error('private'); }); syncBuiltinESMExports();
    assert.throws(() => store.stop([])); bad.mock.restore(); syncBuiltinESMExports();
  }
  let renameMock;
  if (stage === 'config-after') {
    const rename = fsPromises.rename;
    renameMock = t.mock.method(fsPromises, 'rename', async (...args) => { await rename(...args); throw new Error('private'); }); syncBuiltinESMExports();
    t.after(() => { renameMock.mock.restore(); syncBuiltinESMExports(); });
  }
  h.push('/stop'); await fault(h);
  assert.equal(h.aborts, 1); assert.equal((await h.diagnostic()).held, true); assert.equal(h.polling, false);
  assert.equal(config(h).lastUpdateId, stage === 'config-after' ? 1 : 0);
  assert.equal(commits, stage.startsWith('config') ? 1 : 0);
  if (stage.startsWith('config')) assert.equal(snapshot(h).stopLatched, true);
  assert.equal(h.network.filter(n => n.method === 'getUpdates').at(-1).body.offset, 1);
});

for (const [name, value, extra] of [
  ['invalid args', '/stop now', {}], ['foreign', '/stop@foreign', {}], ['unknown address', '/stop@mybot', {}],
  ['caption', undefined, { caption: '/stop', document: { file_id: 'x' } }],
  ['unauthorized', '/stop', { from: { id: 8 } }],
]) test(`persistence failure does not execute ${name} stop`, async t => {
  const h = await harness(t); await h.start('local');
  h.configWrite = async () => { throw new Error('private'); };
  h.push(value, extra); await fault(h); assert.equal(h.aborts, 0); assert.equal((await h.diagnostic()).held, false);
});

test('stale stop duplicate and revoked disconnect intent never repeat stop effects', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('/stop'); assert.equal(h.aborts, 1);
  h.deliver(update(1, '/stop')); await until(() => h.polling); assert.equal(h.aborts, 1);
  const gate = deferred(); h.configWrite = async () => { await gate.promise; };
  h.push('/stop invalid'); await idle();
  const disconnect = h.command('telegram-disconnect'); gate.resolve(); await disconnect;
  assert.equal(h.aborts, 1);
});

test('stop local hold and abort precede awaited cursor persistence', async t => {
  const h = await harness(t); await h.start('parent');
  h.configWrite = async () => {
    assert.equal(h.aborts, 1); assert.equal((await h.diagnostic()).held, true);
    assert.equal(snapshot(h).stopLatched, true); assert.equal(config(h).lastUpdateId, 0);
  };
  await h.receive('/stop'); assert.equal(h.aborts, 1);
});

for (const synthetic of [false, true]) test(`attachment upload failure with successful notice remains uncertain (${synthetic ? 'origin-only' : 'incoming mixed'})`, async t => {
  const h = await harness(t); await h.receive('original'); await h.start(); let origin;
  h.bus.emit('jobs:origin:capture:v1', { sessionId: 'fake-session', capture: value => { origin = value; } }); assert.ok(origin);
  if (synthetic) {
    await h.end(); await h.settle(); let accepted = false;
    h.bus.emit('jobs:origin:claim:v1', { origin, text: '[jobs] Completed background jobs: fake result', accept: () => { accepted = true; } }); assert.ok(accepted); await h.start();
  }
  const a = join(h.home, 'a.txt'), b = join(h.home, 'b.txt'); fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');
  await h.attach([a, b]); let uploads = 0;
  h.networkGate = async method => { if (method === 'sendDocument' && ++uploads === 2) throw new Error('upload rejected'); };
  await h.end('answer'); await h.settle(); assert.equal(uploads, 2);
  assert.ok(h.network.some(n => n.method === 'sendMessage' && n.body.text.includes('Failed to send attachment')));
  assert.equal(snapshot(h).records[0].phase, synthetic ? 'handled' : 'uncertain');
  assert.equal((await h.diagnostic()).uncertainReply, true);
  const submissions = h.sent.length;
  let accepted = false;
  h.bus.emit('jobs:origin:claim:v1', { origin, text: '[jobs] Completed background jobs: another fake result', accept: () => { accepted = true; } });
  assert.equal(accepted, false); await idle(); assert.equal(h.sent.length, submissions);
  await h.command('telegram-reload'); assert.equal(h.generation, 1);
});

test('active write failure retains routing even when host continues after hook errors', async t => {
  const h = await harness(t, { faithfulHost: true }); await h.receive('real Telegram request');
  const transition = AdmissionStore.prototype.transition;
  t.mock.method(AdmissionStore.prototype, 'transition', function (changes) {
    if (changes.some(c => c.phase === 'active')) throw new Error('private'); return transition.call(this, changes);
  });
  const before = h.handlers.get('before_agent_start');
  h.handlers.set('before_agent_start', async (...args) => { await before(...args); throw new Error('other observer error'); });
  const original = snapshot(h).records[0];
  await h.start(); assert.equal(h.errors.length, 1);
  let origin;
  h.bus.emit('jobs:origin:capture:v1', { sessionId: original.input.sessionId, capture: value => { origin = value; } });
  assert.ok(origin);
  assert.equal(origin.provider, 'telegram'); assert.equal(origin.version, 1);
  assert.equal(origin.sessionId, original.input.sessionId);
  assert.equal(origin.requestMarker, original.turnMarker);
  assert.equal(origin.chatId, original.input.chatId);
  assert.equal(origin.replyToMessageId, original.input.messageId);
  const attachment = join(h.home, 'owned.txt'); fs.writeFileSync(attachment, 'private fixture');
  const result = await h.attach([attachment]); assert.ok(!result.isError);
  await h.end('routed answer'); await h.settle();
  assert.ok(h.network.some(n => n.method === 'sendDocument'));
  assert.ok(h.network.some(n => n.method === 'sendMessage' && n.body.text.includes('routed answer')));
  assert.equal(snapshot(h).records[0].phase, 'dispatching'); assert.equal(h.sent.length, 1);
  assert.equal((await h.diagnostic()).uncertainReply, true);
  assert.ok(h.statuses.some(s => s.includes('active marker failed')));
});

for (const closeFirst of [false, true]) test(`release uncertainty latches ownership refusal (close first=${closeFirst})`, async t => {
  const h = await harness(t); const close = fs.closeSync; let target, calls = 0;
  const m = t.mock.method(fs, 'closeSync', fd => {
    if (fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size === 0) { target = fd; calls++; if (closeFirst) close(fd); throw new Error('private'); }
    return close(fd);
  }); syncBuiltinESMExports();
  await h.command('telegram-disconnect'); m.mock.restore(); syncBuiltinESMExports();
  const before = h.network.length, bytes = fs.readFileSync(file(h), 'utf8');
  await h.command('telegram-connect'); assert.equal(h.polling, false);
  await h.command('telegram-setup'); await h.command('telegram-inbox', 'acknowledge 1');
  assert.equal(h.network.length, before); assert.equal(fs.readFileSync(file(h), 'utf8'), bytes); assert.equal(calls, 1);
  if (!closeFirst) close(target); // fixture-owned, proven-open fd only; production never retries.
});

test('video note retains reference and prepares an actual attachment rather than empty prompt', async t => {
  const h = await harness(t); await h.receive(undefined, { video_note: { file_id: 'note:opaque' } }); await until(() => h.sent.length === 1);
  assert.equal(snapshot(h).records[0].input.media[0].type, 'video_note'); assert.equal(snapshot(h).records[0].input.media[0].fileId, 'note:opaque');
  assert.match(text(h), /video-note-1.mp4/);
});

test('local paging permits inspection of entire retained record before ACK', async t => {
  const h = await harness(t); await h.receive('a'.repeat(12000) + 'FINAL-SENTINEL'); await h.replace('new'); await h.command('telegram-connect');
  let all = '';
  for (let page = 0; page < 4; page++) { await h.command('telegram-inbox', `show 1 ${page}`); all += h.notices.at(-1).text; }
  assert.match(all, /FINAL-SENTINEL/); assert.match(all, /receivedAt/); assert.equal(h.sent.length, 1);
});

for (const reason of ['new', 'resume', 'fork']) test(`faithful ${reason} settles before nonvetoing shutdown`, async t => {
  const h = await harness(t, { faithfulHost: true }); await h.receive('request'); await h.start();
  const shutdown = h.handlers.get('session_shutdown'); h.handlers.set('session_shutdown', async (...args) => { await shutdown(...args); throw new Error('observer'); });
  await h.replace(reason); assert.equal(h.generation, 2); assert.deepEqual(h.lifecycle.slice(-3), ['abort', 'settled', 'shutdown']);
  assert.equal(h.errors.length, 1); assert.equal(snapshot(h).records[0].phase, 'handled');
});

for (const closeFirst of [false, true]) test(`acquisition cleanup uncertainty cannot be bypassed by connect/setup/ACK (closed=${closeFirst})`, async t => {
  const h = await harness(t, { connected: false }); let target, closes = 0;
  const close = fs.closeSync;
  leaseBoundary.failure = Object.assign(new Error('private'), { status: 3 });
  const mock = t.mock.method(fs, 'closeSync', fd => {
    if (fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size === 0) { target = fd; closes++; if (closeFirst) close(fd); throw new Error('private'); }
    return close(fd);
  }); syncBuiltinESMExports();
  await assert.rejects(h.command('telegram-connect'), /cleanup-uncertain/);
  mock.mock.restore(); syncBuiltinESMExports(); leaseBoundary.failure = undefined;
  await assert.rejects(h.command('telegram-connect'), /uncertain/);
  await h.command('telegram-setup'); await h.command('telegram-inbox', 'acknowledge 1');
  assert.equal(h.network.length, 0); assert.equal(config(h).lastUpdateId, 0); assert.equal(fs.existsSync(file(h)), false); assert.equal(closes, 1);
  assert.equal(leaseBoundary.descriptors.has(target), !closeFirst);
  if (!closeFirst) close(target);
});

test('disconnect revokes fetched stop before ingress starts', async t => {
  const h = await harness(t); await h.start('parent');
  h.deliver(update(1, '/stop')); await h.command('telegram-disconnect');
  assert.equal(h.aborts, 0); assert.equal(config(h).lastUpdateId, 0);
});
