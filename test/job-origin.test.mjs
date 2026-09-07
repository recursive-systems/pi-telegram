import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { harness, until, deferred } from './harness.mjs';

// Explicit opt-in only; never discover/import another production repository.
const root = process.env.JOBS_SOURCE_ROOT;
let jobsFactory;
if (root) {
  assert.ok(process.env.PI_PACKAGE_DIR, 'PI_PACKAGE_DIR required; no npm discovery');
  const packageDir = process.env.PI_PACKAGE_DIR;
  const { createJiti } = createRequire(join(packageDir, 'package.json'))('jiti');
  const alias = Object.fromEntries(['@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox'].map(name => {
    const directory = join(packageDir, 'node_modules', name);
    const info = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return [name, join(directory, info.exports?.['.']?.import ?? info.main)];
  }));
  jobsFactory = await createJiti(import.meta.url, { alias, fsCache: false }).import(join(root, '.pi/extensions/jobs/index.ts'), { default: true });
}
const replies = h => h.network.filter(n => n.method === 'sendMessage');

for (const jobsFirst of [false, true]) test(`load order jobsFirst=${jobsFirst}: completed background job assessment reaches original Telegram request after settlement`, { skip: !root }, async t => {
  const h = await harness(t, { jobsFactory, jobsFirst });
  await h.receive('start a background job and report later');
  await h.start();
  const job = (await h.tools.get('job_start').execute('job', { name: 'offline', command: "sleep 0.1; printf 'artifact\\n' > answer.txt; printf 'done\\n'", backend: 'detached' }, undefined, undefined, h.ctx)).details.job;
  await h.end('Started'); await h.settle();
  await until(() => existsSync(join(h.home, '.pi/jobs', `${job.id}.exit`)));
  t.mock.timers.tick(2000); t.mock.timers.tick(500);
  await until(() => h.sent.length === 2);
  await h.start(); await h.attach([join(h.home, 'answer.txt')]); await h.end('Parent assessed completion'); await h.settle();
  assert.equal(h.sent.length, 2, 'one original invocation and one completion invocation');
  assert.equal(replies(h).filter(n => n.body.text === 'Parent assessed completion').length, 1, 'missing hop: no parent completion assessment sent to Telegram');
  assert.equal(replies(h).filter(n => n.body.text === 'Parent assessed completion' && n.body.chat_id === 70 && n.body.reply_parameters?.message_id === 1).length, 1,
    'missing hop: parent completion assessment must reply to original Telegram request');
  const files = h.network.filter(n => n.method === 'sendDocument');
  assert.equal(files.length, 1);
  assert.equal(files[0].body.chat_id, '70');
  assert.equal(JSON.parse(files[0].body.reply_parameters).message_id, 1);
  assert.equal(await files[0].body.document.text(), 'artifact\n');
  assert.deepEqual(h.errors, []);
});

const recordPath = (h, id) => join(h.home, '.pi/jobs', `${id}.json`);
const record = (h, id) => JSON.parse(readFileSync(recordPath(h, id), 'utf8'));
const ticks = async () => { await immediate(); await immediate(); };
const wake = async t => { await ticks(); t.mock.timers.tick(500); await ticks(); };
async function startJob(h, notify = true) {
  return (await h.tools.get('job_start').execute('job', { name: 'offline', command: "printf 'done\\n'", backend: 'detached', notify }, undefined, undefined, h.ctx)).details.job;
}
async function finished(t, h, job) {
  await until(() => existsSync(join(h.home, '.pi/jobs', `${job.id}.exit`)));
  t.mock.timers.tick(2000); await wake(t);
}
async function remoteJob(t, options = {}) {
  const h = await harness(t, { jobsFactory, ...options });
  await h.receive('original request'); await h.start();
  const job = await startJob(h);
  assert.equal(job.origin.provider, 'telegram');
  assert.equal(job.origin.sessionId, 'fake-session');
  assert.equal(job.origin.replyToMessageId, 1);
  assert.ok(!JSON.stringify(job.origin).includes('FAKE-OFFLINE'));
  await h.end('Started'); await h.settle();
  return { h, job };
}

// Originals are captured through the real producer, not made-up consumer tokens.
test('descendant jobs inherit original request across an unrelated Telegram request', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  await h.receive('unrelated request'); await h.start();
  await finished(t, h, job); assert.equal(h.sent.length, 2);
  await h.end('Unrelated answer'); await h.settle(); await wake(t);
  assert.equal(h.sent.length, 3);
  await h.start();
  const descendant = await startJob(h);
  assert.deepEqual(descendant.origin, job.origin);
  await h.end('First completion'); await h.settle();
  await finished(t, h, descendant); assert.equal(h.sent.length, 4);
  await h.start(); await h.end('Descendant assessed'); await h.settle();
  assert.equal(replies(h).find(n => n.body.text === 'Descendant assessed').body.reply_parameters.message_id, 1);
  assert.deepEqual(h.errors, []);
});

test('local jobs stay local, notify:false and explicit consumption suppress completion', { skip: !root }, async t => {
  const h = await harness(t, { jobsFactory });
  await h.start('local input');
  const job = await startJob(h), quiet = await startJob(h, false), consumed = await startJob(h);
  assert.equal(job.origin, undefined);
  await finished(t, h, job); await finished(t, h, quiet); await finished(t, h, consumed);
  await h.tools.get('job_logs').execute('logs', { id: consumed.id }, undefined, undefined, h.ctx);
  await h.end('local answer'); await h.settle(); await wake(t);
  assert.equal(h.sent.length, 1); assert.equal(typeof h.sent[0], 'string');
  assert.ok(h.sent[0].includes(job.id)); assert.ok(!h.sent[0].includes(quiet.id)); assert.ok(!h.sent[0].includes(consumed.id));
  await h.start(); await h.end('local completion'); await h.settle();
  assert.equal(replies(h).length, 0);
});

test('missing consumer holds remote notification but does not starve eligible local group', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  await h.replace('reload', true);
  assert.equal(h.tools.has('telegram_attach'), false);
  assert.equal(h.bus.listenerCount('jobs:origin:claim:v1'), 0);
  assert.equal(h.bus.listenerCount('jobs:origin:capture:v1'), 0);
  assert.equal(h.bus.listenerCount('jobs:origin:ready:v1'), 1);
  await h.start('local input'); const local = await startJob(h);
  await finished(t, h, job); await finished(t, h, local);
  await h.end(); await h.settle(); await wake(t);
  assert.equal(h.sent.length, 2); assert.equal(typeof h.sent[1], 'string');
  assert.ok(h.sent[1].includes(local.id)); assert.ok(!h.sent[1].includes(job.id));
  assert.notEqual(record(h, job.id).notified, true);
  assert.equal(record(h, local.id).notified, true);
});

for (const change of [null, { provider: 'foreign' }, { version: 2 }, { chatId: 71 }, { replyToMessageId: 99 },
  { requestMarker: '[turn:11111111-1111-1111-1111-111111111111]' }, { sessionId: 'foreign' },
  { configDigest: '0'.repeat(64) }, { bridgeEpoch: '11111111-1111-1111-1111-111111111111' },
  { stopGeneration: 8 }, { signature: '0'.repeat(64) }, { credentials: 'never-accept-extra-fields' }]) {
  test(`malformed/forged/foreign origin is held: ${JSON.stringify(change)}`, { skip: !root }, async t => {
    const { h, job } = await remoteJob(t);
    const rec = record(h, job.id); rec.origin = change === null ? null : { ...job.origin, ...change };
    writeFileSync(recordPath(h, job.id), JSON.stringify(rec));
    await finished(t, h, job);
    assert.equal(h.sent.length, 1); assert.notEqual(record(h, job.id).notified, true);
    assert.deepEqual(h.errors, []);
  });
}

test('different original requests never share a continuation group', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  await h.receive('second original request', { chat: { id: 71, type: 'private' } }); await h.start(); const second = await startJob(h);
  await finished(t, h, job); await finished(t, h, second);
  await h.end(); await h.settle(); await wake(t);
  assert.equal(h.sent.length, 3);
  const firstText = JSON.stringify(h.sent[2]);
  assert.ok(firstText.includes(job.id)); assert.ok(!firstText.includes(second.id));
  assert.notEqual(record(h, second.id).notified, true);
  await h.start(); await h.end('first result'); await h.settle(); await wake(t);
  assert.equal(h.sent.length, 4);
  assert.ok(JSON.stringify(h.sent[3]).includes(second.id));
  assert.ok(!JSON.stringify(h.sent[3]).includes(job.id));
  await h.start(); await h.end('second result'); await h.settle(); await wake(t);
  for (const [text, chat, message] of [['first result', 70, 1], ['second result', 71, 2]]) {
    const matched = replies(h).filter(n => n.body.text === text);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].body.chat_id, chat);
    assert.equal(matched[0].body.reply_parameters.message_id, message);
  }
  assert.equal(h.sent.length, 4);
});

test('/stop invalidates old continuation even after unrelated new input', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  await h.receive('/stop'); await h.receive('new input'); await h.start();
  await finished(t, h, job); await h.end(); await h.settle(); await wake(t);
  assert.equal(h.sent.length, 2); assert.notEqual(record(h, job.id).notified, true);
});

test('disconnect holds, explicit same-epoch reconnect retries once', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  await h.command('telegram-disconnect'); await finished(t, h, job);
  assert.equal(h.sent.length, 1); assert.notEqual(record(h, job.id).notified, true);
  await h.command('telegram-connect'); await wake(t);
  assert.equal(h.sent.length, 2); assert.equal(record(h, job.id).notified, true);
  await wake(t); assert.equal(h.sent.length, 2);
});

for (const reason of ['authorized', 'reload', 'new', 'startup', 'fork']) test(`epoch lifecycle: ${reason}`, { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  if (reason === 'authorized') await h.command('telegram-reload');
  else { await h.replace(reason); assert.equal(h.polling, false); await h.command('telegram-connect'); }
  await finished(t, h, job);
  assert.equal(h.sent.length, reason === 'authorized' ? 2 : 1);
  assert.equal(record(h, job.id).notified === true, reason === 'authorized');
  assert.deepEqual(h.errors, []);
});

for (const gate of ['pending', 'busy', 'preflight', 'compaction', 'FIFO', 'finalization']) test(`continuation waits for ${gate}`, { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  let release, settle;
  if (gate === 'pending') h.pending = true;
  if (gate === 'busy') h.idle = false;
  if (gate === 'preflight') await h.emit('before_agent_start', { prompt: 'local preflight', systemPrompt: '' });
  if (gate === 'compaction') await h.beginManualCompaction();
  if (gate === 'FIFO') { h.idle = false; await h.receive('queued human'); }
  if (gate === 'finalization') {
    await h.receive('another request'); await h.start(); await h.end('answer');
    const barrier = deferred(); release = barrier.resolve;
    h.networkGate = async method => { if (method === 'sendMessage') await barrier.promise; };
    settle = h.settle(); await ticks();
  }
  const before = h.sent.length;
  await finished(t, h, job);
  assert.equal(h.sent.length, before); assert.notEqual(record(h, job.id).notified, true);
  if (gate === 'pending') h.pending = false;
  if (gate === 'busy') h.idle = true;
  if (gate === 'preflight') { await h.emit('agent_start'); await h.end(); }
  if (gate === 'compaction') await h.completeManualCompaction();
  if (gate === 'finalization') { release(); await settle; h.networkGate = undefined; }
  if (gate === 'FIFO') {
    h.idle = true; await h.settle(); await ticks();
    assert.equal(h.sent.length, before + 1); assert.match(JSON.stringify(h.sent.at(-1)), /queued human/);
    await h.start(); await h.end();
  }
  await h.settle(); await wake(t);
  assert.equal(h.sent.length, before + (gate === 'FIFO' ? 2 : 1));
  assert.equal(record(h, job.id).notified, true);
});

test('synchronous rejected submission retains producer ownership; retry does not duplicate', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  h.onSend = () => { throw new Error('fake synchronous rejection'); };
  await finished(t, h, job);
  assert.notEqual(record(h, job.id).notified, true);
  assert.equal((await h.diagnostic()).queued, 0); assert.equal((await h.diagnostic()).submitted, false);
  h.onSend = () => {};
  await h.settle(); await wake(t);
  assert.equal(record(h, job.id).notified, true);
  const before = h.sent.length; await wake(t); assert.equal(h.sent.length, before);
  assert.deepEqual(h.errors, []);
});

test('async host preflight rejection remains bridge-owned, not falsely retried by jobs', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  h.asyncAdmission(async () => { throw new Error('fake async host rejection'); });
  await finished(t, h, job);
  assert.equal(record(h, job.id).notified, true);
  assert.equal((await h.diagnostic()).submitted, true);
  assert.equal(h.errors.length, 1);
  await h.settle(); await wake(t);
  assert.equal(h.sent.length, 2);
});

test('routed suppression and exact-origin batching retain existing semantics', { skip: !root }, async t => {
  const h = await harness(t, { jobsFactory });
  await h.receive('request'); await h.start();
  const first = await startJob(h), second = await startJob(h), quiet = await startJob(h, false), consumed = await startJob(h);
  for (const job of [first, second, quiet, consumed]) await finished(t, h, job);
  await h.tools.get('job_status').execute('status', { id: consumed.id }, undefined, undefined, h.ctx);
  await h.end(); await h.settle(); await wake(t);
  assert.equal(h.sent.length, 2);
  const text = JSON.stringify(h.sent[1]);
  assert.ok(text.includes(first.id) && text.includes(second.id));
  assert.ok(!text.includes(quiet.id) && !text.includes(consumed.id));
  assert.equal(record(h, first.id).notified, true); assert.equal(record(h, second.id).notified, true);
});

test('an active but no-longer-routing Telegram turn cannot lend its origin to local jobs', { skip: !root }, async t => {
  const h = await harness(t, { jobsFactory });
  await h.receive('request'); await h.start();
  await h.emit('message_start', { message: { role: 'user', content: 'unrelated local steering' } });
  const job = await startJob(h); assert.equal(job.origin, undefined);
  await finished(t, h, job); await h.end(); await h.settle();
});

test('late asynchronous claim callback is not producer acknowledgement', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  h.bus.removeAllListeners('jobs:origin:claim:v1');
  h.bus.on('jobs:origin:claim:v1', async request => { await immediate(); request.accept(); });
  await finished(t, h, job); await ticks();
  assert.notEqual(record(h, job.id).notified, true); assert.equal(h.sent.length, 1);
});

test('changed real configuration on reconnect refuses a captured route', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  await h.command('telegram-disconnect');
  writeFileSync(join(h.home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: 'FAKE-OFFLINE', allowedUserId: 8, lastUpdateId: 1 }));
  await h.command('telegram-connect'); await finished(t, h, job);
  assert.equal(h.sent.length, 1); assert.notEqual(record(h, job.id).notified, true);
});

for (const fallback of [false, true]) test(`continuation reply address survives preview pipeline: fallback=${fallback}`, { skip: !root }, async t => {
  const { h, job } = await remoteJob(t); await finished(t, h, job); await h.start();
  if (fallback) h.networkGate = async method => { if (method === 'sendMessageDraft') throw new Error('fake unsupported draft'); };
  await h.emit('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'partial completion' }] } });
  t.mock.timers.tick(750); await ticks();
  await h.end('final completion'); await h.settle();
  const message = replies(h).filter(n => n.body.text === (fallback ? 'partial completion' : 'final completion'));
  assert.equal(message.length, 1); assert.equal(message[0].body.reply_parameters.message_id, 1);
  assert.equal(message[0].body.chat_id, 70); assert.equal(h.sent.length, 2);
});


test('setup cancellation wakes a completion held during fake UI input without an agent event', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  const path = join(h.home, '.pi/agent/telegram.json');
  const before = readFileSync(path, 'utf8');
  let ready = 0, claims = 0;
  h.bus.on('jobs:origin:ready:v1', () => ready++);
  h.bus.on('jobs:origin:claim:v1', () => claims++);
  const input = deferred();
  h.ctx.ui.input = () => input.promise;
  const setup = h.command('telegram-setup');
  await finished(t, h, job);
  assert.equal(h.sent.length, 1);
  assert.notEqual(record(h, job.id).notified, true);
  const blockedClaims = claims;
  input.resolve(undefined); await setup; await wake(t);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(h.sent.length, 2);
  assert.equal(record(h, job.id).notified, true);
  await wake(t); assert.equal(h.sent.length, 2);
  assert.equal(ready, 1, 'one ordinary ready hint after cancellation');
  assert.equal(claims, blockedClaims + 1, 'one claim retry, no duplicate wake');
  assert.deepEqual(h.errors, []);
});

test('rejected continuation upload sends one error threaded to the original request without retry', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  await h.receive('unrelated', { chat: { id: 71, type: 'private' } });
  await h.start(); await h.end(); await h.settle();
  await finished(t, h, job); await h.start();
  const path = join(h.home, 'result.txt'); writeFileSync(path, 'offline');
  await h.attach([path]);
  h.networkGate = async method => { if (method === 'sendDocument') throw new Error('fake rejected upload'); };
  await h.end('assessed'); await h.settle(); await wake(t);
  const failures = replies(h).filter(n => n.body.text.includes('Failed to send attachment'));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].body.chat_id, 70);
  assert.equal(failures[0].body.reply_parameters?.message_id, 1);
  assert.equal(h.network.filter(n => n.method === 'sendDocument').length, 1);
  await wake(t); assert.equal(h.sent.length, 3);
  assert.deepEqual(h.errors, []);
});

test('origin listeners unsubscribe before host teardown and ready hints remain bounded', { skip: !root }, async t => {
  const { h, job } = await remoteJob(t);
  const names = ['jobs:origin:capture:v1', 'jobs:origin:claim:v1', 'jobs:origin:ready:v1'];
  const old = names.map(name => h.bus.listeners(name));
  for (const listeners of old) assert.equal(listeners.length, 1);
  await h.shutdown(); // Assert extension unsubscribe itself, before host removeAllListeners.
  for (const name of names) assert.equal(h.bus.listenerCount(name), 0);
  await h.replace('reload'); await h.command('telegram-connect');
  names.forEach((name, i) => {
    assert.equal(h.bus.listenerCount(name), 1);
    assert.ok(!h.bus.listeners(name).includes(old[i][0]));
  });
  let ready = 0, claims = 0;
  h.bus.on(names[2], () => ready++);
  h.bus.on(names[1], () => claims++);
  await finished(t, h, job); // Old epoch remains pending, even when new bridge is ready.
  const before = { ready, claims };
  await wake(t); await wake(t);
  assert.deepEqual({ ready, claims }, before, 'no self-sustaining ready/claim loop');
  assert.ok(ready <= 1); assert.ok(claims <= 1);
  assert.equal(h.sent.length, 1);
  assert.notEqual(record(h, job.id).notified, true);
  assert.deepEqual(h.errors, []);
});
