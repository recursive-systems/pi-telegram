import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { harness, deferred, until, assistant } from './harness.mjs';

const ticks = async () => { await immediate(); await immediate(); };
const snapshots = h => h.entries.filter(e => e.customType === 'telegram-reload-checkpoint-v1');
const claims = h => h.entries.filter(e => e.customType === 'telegram-reload-claim-v1');
const text = content => content.filter(p => p.type === 'text').map(p => p.text).join('\n');
const replies = h => h.network.filter(n => n.method === 'sendMessage');

for (const boundary of ['compaction busy', 'cleanup before drain']) test(`reload with settlement debt: ${boundary} retains original finalization`, async t => {
  const h = await harness(t);
  await h.receive('request'); await h.start(); await h.end('**owed** &AMP; &copy;');
  await h.settle(() => h.beginManualCompaction());
  assert.equal((await h.diagnostic()).settlementOwed, true);
  let reload, returned = false;
  const requestReload = () => { reload = h.command('telegram-reload').then(() => { returned = true; }); };
  if (boundary === 'compaction busy') {
    requestReload(); await ticks();
    assert.equal(returned, false); assert.equal(h.generation, 1);
    assert.equal(replies(h).length, 0); assert.equal(snapshots(h).length, 0);
  }
  await h.completeManualCompaction(async () => {}, async () => {
    // Fresh input is legal here, unlike inside the compaction success hook.
    if (boundary === 'cleanup before drain') requestReload();
    if (boundary === 'cleanup before drain') await reload;
    assert.equal(h.generation, 1, 'active owed reply is not checkpointed away');
    assert.equal(snapshots(h).length, 0);
    if (returned) assert.match(h.notices.at(-1).text, /refused/);
    assert.equal((await h.diagnostic()).settlementOwed, true);
  });
  await reload;
  assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0);
  assert.match(h.notices.at(-1).text, /refused/);
  t.mock.timers.tick(100); await until(() => replies(h).length === 1); await ticks();
  assert.equal(replies(h)[0].body.text, '<b>owed</b> &amp; &amp;copy;');
  assert.equal(replies(h)[0].body.parse_mode, 'HTML');
  assert.equal((await h.diagnostic()).finalizing, false);
  assert.equal((await h.diagnostic()).settlementOwed, false);
  await h.command('telegram-reload');
  assert.equal(h.generation, 2); assert.equal(snapshots(h)[0].data.turns.length, 0);
  assert.equal((await h.diagnostic()).settlementOwed, false);
  await h.settle(); await h.emit('session_compact', { reason: 'manual' });
  t.mock.timers.tick(100); await ticks();
  assert.equal(replies(h).length, 1); assert.equal(h.sent.length, 1);
  assert.equal(h.maxPolls, 1); assert.deepEqual(h.errors, []);
});

for (const barrier of ['sendMessageDraft', 'sendDocument']) test(`reload during owed ${barrier} barrier sends once before replacement`, async t => {
  const h = await harness(t);
  const file = join(h.home, 'answer.txt'); await writeFile(file, 'offline');
  await h.receive('current'); await h.start(); await h.attach([file]); await h.receive('next');
  const gate = deferred(); let blocked = false;
  h.networkGate = async method => { if (method === barrier) { blocked = true; await gate.promise; } };
  if (barrier === 'sendMessageDraft') {
    await h.emit('message_update', { message: assistant('**partial**') });
    t.mock.timers.tick(750); await until(() => blocked);
  }
  await h.end('**final** &AMP;'); await h.settle(() => h.beginManualCompaction());
  await h.completeManualCompaction(); t.mock.timers.tick(100); await ticks();
  await until(() => blocked);
  assert.equal((await h.diagnostic()).finalizing, true);
  const reload = h.command('telegram-reload'); await ticks();
  assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0); assert.equal(h.sent.length, 1);
  if (barrier === 'sendMessageDraft') assert.equal(replies(h).length, 0);
  gate.resolve(); await reload; await until(() => h.sent.length === 2);
  assert.equal(replies(h).filter(n => n.body.text === '<b>final</b> &amp;').length, 1);
  assert.equal(h.network.filter(n => n.method === 'sendDocument').length, 1);
  assert.equal(snapshots(h)[0].data.turns.length, 1); assert.match(text(h.sent[1]), /next/);
  assert.equal((await h.diagnostic()).settlementOwed, false);
  await h.emit('session_compact', { reason: 'manual' }); await ticks();
  assert.equal(replies(h).length, 1); assert.equal(h.maxPolls, 1); assert.deepEqual(h.errors, []);
});

for (const enabled of [true, false]) test(`explicit handoff restores diagnostic flag on a fresh factory: ${enabled}`, async t => {
  const h = await harness(t, { diagnosticsEnabled: enabled });
  const oldCtx = h.ctx, oldTools = h.tools, oldHandlers = h.handlers;
  const oldId = enabled ? (await h.diagnostic()).instance : undefined;
  await h.command('telegram-reload');
  assert.equal(h.generation, 2); assert.equal(h.factoryFlag, false);
  assert.deepEqual(h.factoryTools, ['telegram_reload', 'telegram_attach']);
  assert.notEqual(h.tools, oldTools); assert.equal(h.tools.has('telegram_diagnostics'), enabled);
  await h.emit('session_start', { reason: 'reload' });
  assert.equal(h.registrations.filter(n => n === 'telegram_diagnostics').length, enabled ? 1 : 0);
  const requests = h.network.length, submissions = h.submissions.length;
  await oldTools.get('telegram_reload').execute('stale', {});
  for (const event of ['agent_settled', 'session_compact', 'session_compact_failed']) {
    await oldHandlers.get(event)({ type: event, reason: 'manual' }, oldCtx);
  }
  if (enabled) {
    const currentCtx = { ...h.ctx, isIdle: () => false, hasPendingMessages: () => true };
    const d = (await h.tools.get('telegram_diagnostics').execute('new', {}, undefined, undefined, currentCtx)).details;
    assert.notEqual(d.instance, oldId, 'UUID identifies the factory even with unchanged source');
    assert.equal(d.hostIdle, false); assert.equal(d.hostPending, true); assert.equal(d.closed, false);
    await assert.rejects(oldTools.get('telegram_diagnostics').execute('old', {}, undefined, undefined, oldCtx), /stale host API/);
    const old = (await oldTools.get('telegram_diagnostics').execute('old', {}, undefined, undefined, currentCtx)).details;
    assert.equal(old.closed, true); assert.equal(old.instance, oldId);
  }
  await ticks(); assert.equal(h.network.length, requests); assert.equal(h.submissions.length, submissions);
  assert.equal(h.maxPolls, 1); assert.deepEqual(h.errors, []);
});

test('held transitive FIFO across handoff uses real host Markdown for the resumed reply', async t => {
  const h = await harness(t); await h.start('local');
  await h.receive('first'); await h.receive('/stop'); await h.receive('second'); await h.receive('/stop');
  const reload = h.command('telegram-reload'); await h.end('LOCAL PRIVATE'); await h.settle(); await reload;
  assert.equal(snapshots(h)[0].data.held, true); assert.equal(h.sent.length, 0);
  await h.emit('session_compact_failed', { reason: 'manual' }); await h.settle();
  assert.equal(h.sent.length, 0); assert.equal((await h.diagnostic()).held, true);
  await h.receive('third'); await until(() => h.sent.length === 1);
  const prompt = text(h.sent[0]);
  assert.ok(prompt.indexOf('first') < prompt.indexOf('second')); assert.ok(prompt.indexOf('second') < prompt.indexOf('third'));
  await h.start(); await h.receive('fourth');
  await h.end('**resumed** &AMP; &copy; [unsafe](javascript:alert)'); await h.settle();
  assert.equal(replies(h).filter(n => n.body.text === '<b>resumed</b> &amp; &amp;copy; [unsafe](javascript:alert)' && n.body.parse_mode === 'HTML').length, 1);
  assert.equal(h.sent.length, 2); assert.match(text(h.sent[1]), /fourth/);
  assert.ok(!h.network.some(n => n.body.text?.includes('LOCAL PRIVATE'))); assert.equal(h.maxPolls, 1);
});

for (const mode of ['swallow-error', 'omit-extension']) test(`failed handoff ${mode} revokes captured capability with diagnostics enabled`, async t => {
  const h = await harness(t); await h.start('local'); await h.receive('private queued');
  let permitMap, nonce;
  h.reloadMode = mode;
  h.reloadHook = async phase => {
    if (phase !== 'after') return;
    permitMap = globalThis[Symbol.for('pi-telegram.explicit-reload.v1')].permits;
    nonce = snapshots(h)[0].data.nonce;
    assert.equal(permitMap.get(nonce).armed, true);
    if (mode === 'swallow-error') throw new Error('fake swallowed import failure');
  };
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(permitMap.has(nonce), false); assert.equal(claims(h).length, 0);
  h.reloadMode = 'normal'; h.reloadHook = async () => {};
  await h.replace('reload'); await h.settle(); await h.emit('session_compact_failed', { reason: 'manual' }); await ticks();
  assert.equal(h.polling, false); assert.equal(h.sent.length, 0); assert.equal(claims(h).length, 0);
  assert.equal(h.tools.has('telegram_diagnostics'), true); assert.equal((await h.diagnostic()).settlementOwed, false);
});

test('restored disconnected queue stays inert across all unrelated idle wakes', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('keep disconnected');
  await h.command('telegram-disconnect');
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  const requests = h.network.length;
  await h.beginManualCompaction(); await h.completeManualCompaction();
  t.mock.timers.tick(100); await h.emit('session_compact_failed', { reason: 'manual' });
  await h.start('unrelated local'); await h.end('LOCAL'); await h.settle(); await ticks();
  assert.equal(h.sent.length, 0); assert.equal(h.network.length, requests); assert.equal(h.polling, false);
  assert.equal((await h.diagnostic()).queued, 1); assert.equal((await h.diagnostic()).settlementOwed, false);
  assert.equal((await h.diagnostic()).blocker, 'restored-disconnected');
  await h.command('telegram-connect'); await until(() => h.sent.length === 1);
  assert.match(text(h.sent[0]), /keep disconnected/); assert.equal(h.maxPolls, 1);
});
