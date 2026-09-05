import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { harness, deferred, until } from './harness.mjs';

const snapshots = h => h.entries.filter(e => e.customType === 'telegram-reload-checkpoint-v1');
const claims = h => h.entries.filter(e => e.customType === 'telegram-reload-claim-v1');
const text = content => content.filter(p => p.type === 'text').map(p => p.text).join('\n');
const ticks = async () => { await immediate(); await immediate(); };

test('tool dispatches real command explicitly, coalesces, waits for final reply AND attachments across two instances', async t => {
  const h = await harness(t);
  await h.receive('current'); await h.start();
  const path = join(h.home, 'answer.txt'); await writeFile(path, 'offline'); await h.attach([path]);
  await h.receive('next'); await h.receive('last');
  const reply = deferred(), attachment = deferred(); let replyStarted = false, attachmentStarted = false;
  h.networkGate = async method => {
    if (method === 'sendMessage') { replyStarted = true; await reply.promise; }
    if (method === 'sendDocument') { attachmentStarted = true; await attachment.promise; }
  };
  await h.reloadTool(); await h.reloadTool();
  const duplicate = h.command('telegram-reload'); await duplicate;
  assert.deepEqual(h.submissions.at(-1).opts, { deliverAs: 'followUp', expandPromptTemplates: true });
  assert.equal(h.submissions.filter(s => s.content === '/telegram-reload').length, 1);
  await h.end('final'); const settling = h.settle();
  await until(() => replyStarted); assert.equal(h.generation, 1); assert.equal(h.sent.length, 1);
  reply.resolve(); await until(() => attachmentStarted); assert.equal(h.generation, 1);
  attachment.resolve(); await settling; await until(() => h.generation === 2 && h.sent.length === 2);
  assert.match(text(h.sent[1]), /next/);
  assert.deepEqual(h.lifecycle, ['shutdown', 'instantiate', 'start']);
  assert.equal(snapshots(h).length, 1); assert.equal(claims(h).length, 1);
  assert.equal(snapshots(h)[0].data.turns.length, 2);
  await h.start(); await h.end(); await h.settle(); assert.match(text(h.sent[2]), /last/);
  assert.equal(h.maxPolls, 1); assert.equal(h.errors.length, 0);
  assert.ok(!JSON.stringify(h.entries).includes('FAKE-OFFLINE'));
});

test('quiescing flushes album debounce, waits downloads and preserves FIFO image/file inputs', async t => {
  const h = await harness(t);
  await h.start('local');
  await h.receive('album', { media_group_id: 'a', photo: [{ file_id: 'image' }] });
  await h.receive('', { media_group_id: 'a', document: { file_id: 'doc', file_name: 'note.txt' } });
  await h.receive('after album');
  const download = deferred(); let downloading = false;
  h.networkGate = async method => { if (method === 'download') { downloading = true; await download.promise; } };
  const reloading = h.command('telegram-reload'); await h.end(); await h.settle();
  await until(() => downloading); assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0);
  download.resolve(); await reloading; await until(() => h.sent.length === 1);
  assert.match(text(h.sent[0]), /album/); assert.match(text(h.sent[0]), /note.txt/);
  assert.equal(h.sent[0].filter(p => p.type === 'image').length, 1);
  assert.equal(snapshots(h)[0].data.turns.length, 2); assert.equal(h.maxPolls, 1);
});

test('stop and transitive held history survive handoff without unsolicited dispatch', async t => {
  const h = await harness(t); await h.start('local');
  await h.receive('first'); await h.receive('stop'); await h.receive('second'); await h.receive('stop');
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(h.sent.length, 0); assert.equal(snapshots(h)[0].data.held, true);
  await h.receive('third'); await until(() => h.sent.length === 1);
  const prompt = text(h.sent[0]); assert.ok(prompt.indexOf('first') < prompt.indexOf('second')); assert.ok(prompt.indexOf('second') < prompt.indexOf('third'));
});

test('cursor is continuous and server messages during the poller gap are not acknowledged away', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('queued');
  const gap = deferred(); let stopped = false;
  h.reloadHook = async phase => { if (phase === 'after') { stopped = true; await gap.promise; } };
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await until(() => stopped);
  assert.equal(h.polling, false);
  const cursor = JSON.parse(await readFile(join(h.home, '.pi/agent/telegram.json'), 'utf8')).lastUpdateId;
  assert.equal(cursor, 1);
  h.serverMessage('arrived during gap');
  gap.resolve(); await reload; await until(() => h.polling);
  assert.equal(h.network.find(n => n.method === 'getUpdates' && n.body.timeout === 0).body.offset, 2);
  // The readiness probe saw (but did not consume) the gap update; the subsequent
  // long poll receives it at the same cursor, then advances only after ingress.
  assert.equal(h.network.filter(n => n.method === 'getUpdates').at(-1).body.offset, 3);
  await h.start(); await h.end(); await h.settle();
  assert.match(text(h.sent[1]), /arrived during gap/); assert.equal(h.maxPolls, 1);
});

test('in-flight ingress completes before snapshot, even if stop polling aborted its getUpdates signal', async t => {
  const h = await harness(t); const gate = deferred(); let entered = false;
  h.networkGate = async method => { if (method === 'sendMessage') { entered = true; await gate.promise; } };
  const receive = h.receive('stop'); await until(() => entered);
  const reload = h.command('telegram-reload'); await ticks(); assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0);
  gate.resolve(); await reload; await receive;
  assert.equal(snapshots(h)[0].data.held, true); assert.equal(snapshots(h)[0].data.cursor, 1); assert.equal(h.maxPolls, 1);
});

test('submitted void admission and suspended preflight refuse reload instead of replay', async t => {
  const h = await harness(t); await h.receive('unacknowledged');
  await h.command('telegram-reload'); assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0);
  assert.match(h.notices.at(-1).text, /refused/);
  await h.emit('before_agent_start', { prompt: 'foreign preflight', systemPrompt: '' });
  await h.command('telegram-reload'); assert.equal(h.generation, 1); assert.equal(h.sent.length, 1);
});

test('disconnected explicit reload stays disconnected; ordinary lifecycle never reconnects', async t => {
  const h = await harness(t, { connected: false });
  await h.command('telegram-reload'); assert.equal(h.generation, 2); assert.equal(h.network.length, 0);
  assert.equal(snapshots(h)[0].data.connected, false);
  for (const reason of ['reload', 'new', 'fork', 'resume', 'startup']) {
    await h.replace(reason); assert.equal(h.network.length, 0);
  }
});

test('duplicate restore callback and later ordinary reload cannot replay claimed checkpoint', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('only once');
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload; await ticks();
  const requests = h.network.length; await h.emit('session_start', { reason: 'reload' });
  assert.equal(h.network.length, requests); assert.equal(claims(h).length, 1);
  await h.replace('reload'); assert.equal(h.polling, false); assert.equal(h.sent.length, 1);
});

for (const mutation of ['invalid', 'foreign-process', 'foreign-session', 'foreign-file', 'stale', 'pairing', 'bot', 'token', 'cursor']) {
  test(`${mutation} checkpoint/config fails closed without exposing credentials`, async t => {
    const h = await harness(t); await h.start('local'); await h.receive('private queued work');
    h.reloadHook = async phase => {
      if (phase !== 'after') return;
      if (mutation === 'invalid') snapshots(h)[0].data.turns = 'invalid';
      if (mutation === 'foreign-process') delete globalThis[Symbol.for('pi-telegram.explicit-reload.v1')];
      if (mutation === 'foreign-session') h.sessionId = 'different';
      if (mutation === 'foreign-file') h.sessionFile = join(h.home, 'fork.jsonl');
      if (mutation === 'stale') {
        const now = Date.now(); t.mock.method(Date, 'now', () => now + 180_000);
      }
      if (['pairing', 'bot', 'token', 'cursor'].includes(mutation)) {
        const path = join(h.home, '.pi/agent/telegram.json'); const cfg = JSON.parse(await readFile(path, 'utf8'));
        if (mutation === 'pairing') cfg.allowedUserId = 8;
        if (mutation === 'bot') cfg.botId = 999;
        if (mutation === 'token') cfg.botToken = 'OTHER-FAKE-OFFLINE';
        if (mutation === 'cursor') cfg.lastUpdateId++;
        await writeFile(path, JSON.stringify(cfg));
      }
    };
    const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
    assert.equal(h.polling, false); assert.equal(h.sent.length, 0); assert.equal(snapshots(h).length, 1);
    assert.ok(!JSON.stringify(h.notices).includes('FAKE-OFFLINE'));
  });
}

test('preparation failure retains evidence and blocks subsequent dispatch and reload certification', async t => {
  const h = await harness(t); await h.start('local');
  h.networkGate = async method => { if (method === 'download') throw new Error('offline failure'); };
  await h.receive('failed image', { photo: [{ file_id: 'bad' }] }); await h.receive('later');
  await h.end(); await h.settle(); await h.command('telegram-reload');
  assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0); assert.equal(h.sent.length, 0);
  assert.match(h.notices.at(-1).text, /refused/);
});

test('idle is rechecked after asynchronous quiescing', async t => {
  const h = await harness(t); await h.start('local');
  await h.receive('album', { media_group_id: 'album', photo: [{ file_id: 'photo' }] });
  const gate = deferred(); let downloading = false;
  h.networkGate = async method => { if (method === 'download') { downloading = true; await gate.promise; } };
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await until(() => downloading);
  h.pending = true; gate.resolve(); await reload;
  assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0); assert.equal(h.polling, false);
  h.pending = false; await h.command('telegram-reload'); assert.equal(snapshots(h)[0].data.turns.length, 1);
});

test('append failure leaves old queue recoverable and stopped without a capability', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('keep');
  h.appendHook = () => { throw new Error('disk full'); };
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(h.generation, 1); assert.equal(h.polling, false); assert.equal(snapshots(h).length, 0);
  await h.settle(); await ticks(); // unrelated idle events must not run the disconnected queue
  assert.equal(h.sent.length, 0);
  h.appendHook = () => {}; await h.command('telegram-reload'); assert.equal(snapshots(h)[0].data.turns.length, 1);
});

for (const phase of ['before', 'after']) {
  test(`host reload failure ${phase} shutdown retains checkpoint and never uses stale API`, async t => {
    const h = await harness(t); await h.start('local'); await h.receive('recover me');
    h.reloadHook = async point => { if (point === phase) throw new Error('host failure'); };
    const reload = h.command('telegram-reload'); const observed = reload.catch(e => e);
    await h.end(); await h.settle(); const error = await observed;
    if (phase === 'after') assert.match(error.message, /after teardown/);
    assert.equal(snapshots(h)[0].data.turns.length, 1); assert.equal(h.polling, false);
    h.reloadHook = async () => {};
    await h.replace('reload'); assert.equal(h.polling, false); assert.equal(h.sent.length, 0);
  });
}

test('reconnection failure retains original checkpoint and restored work, blocks connect, does not loop', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('retain forever');
  h.reloadHook = async phase => { if (phase === 'after') h.networkGate = async method => { if (method === 'getUpdates') throw new Error('offline'); }; };
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(h.polling, false); assert.equal(h.sent.length, 0); assert.equal(claims(h).length, 1);
  assert.match(snapshots(h)[0].data.turns[0].historyText, /retain forever/);
  assert.match(h.notices.at(-1).text, /recovery required/);
  const requests = h.network.length; t.mock.timers.tick(100_000); await ticks();
  await h.command('telegram-connect'); assert.equal(h.network.length, requests);
});

test('reload requested while host already says idle still waits for final network cleanup', async t => {
  const h = await harness(t); await h.receive('active'); await h.start(); await h.receive('queued');
  const gate = deferred(); let entered = false;
  h.networkGate = async method => { if (method === 'sendMessage') { entered = true; await gate.promise; } };
  await h.end('final'); const settling = h.settle(); await until(() => entered);
  // waitForIdle now returns immediately, but bridge finalizingReply is still true.
  const reload = h.command('telegram-reload'); await ticks(); assert.equal(h.generation, 1);
  gate.resolve(); await settling; await reload;
  assert.equal(h.generation, 2); assert.equal(snapshots(h)[0].data.turns.length, 1);
});

test('uncertain outbound reply is retained locally and never put into a replay checkpoint', async t => {
  const h = await harness(t); await h.receive('active'); await h.start(); await h.receive('next');
  h.networkGate = async method => { if (method === 'sendMessage') throw new Error('uncertain network delivery'); };
  const reload = h.command('telegram-reload'); await h.end('final'); await h.settle(); await reload;
  assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0);
  assert.equal(h.sent.filter(c => text(c).includes(' active')).length, 1);
  assert.match(h.notices.map(n => n.text).join('\n'), /uncertain reply/);
});

test('claim append failure retains the checkpoint, revokes capability, and blocks replay', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('save this');
  h.appendHook = type => { if (type === 'telegram-reload-claim-v1') throw new Error('disk full'); };
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(snapshots(h).length, 1); assert.equal(claims(h).length, 0); assert.equal(h.polling, false);
  await h.emit('session_start', { reason: 'reload' }); assert.equal(h.polling, false);
  h.appendHook = () => {}; await h.replace('reload'); assert.equal(h.polling, false);
});

test('ingress failure after cursor write is evidence, not a certified empty snapshot', async t => {
  const h = await harness(t);
  h.networkGate = async method => { if (method === 'sendMessage') throw new Error('command reply failed'); };
  // receive() waits for a replacement poll, which is intentionally delayed by
  // the normal poller's error backoff. Release that fake timer explicitly.
  const receiving = h.receive('stop'); await until(() => h.statuses.some(s => s.includes('command reply failed')));
  await h.command('telegram-reload'); assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0);
  h.networkGate = undefined; t.mock.timers.tick(3000); await receiving;
  await h.command('telegram-status'); assert.match(h.notices.at(-1).text, /failed preparations\/ingress: 0\/1/);
});

test('disconnected queue is retained without model/network work until explicit connect', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('paused queue');
  await h.command('telegram-disconnect');
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(snapshots(h)[0].data.connected, false); assert.equal(h.sent.length, 0);
  await h.settle(); assert.equal(h.sent.length, 0); assert.equal(h.polling, false);
  await h.command('telegram-connect'); await until(() => h.sent.length === 1);
  assert.match(text(h.sent[0]), /paused queue/);
});

for (const phase of ['before', 'after']) test(`swallowed host reload error ${phase} shutdown cannot authorize a later ordinary reload`, async t => {
  const h = await harness(t); await h.start('local'); await h.receive('must not replay');
  h.reloadMode = 'swallow-error';
  h.reloadHook = async point => { if (point === phase) throw new Error('host reported failure'); };
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(snapshots(h).length, 1); assert.equal(h.errors.length, 1);
  h.reloadMode = 'normal'; h.reloadHook = async () => {};
  await h.replace('reload'); await ticks();
  assert.equal(h.polling, false); assert.equal(h.sent.length, 0); assert.equal(claims(h).length, 0);
});

test('omitted replacement extension cannot leave permission for later ordinary reload', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('recover manually');
  h.reloadMode = 'omit-extension';
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(h.generation, 2); assert.equal(snapshots(h).length, 1); assert.equal(h.polling, false);
  h.reloadMode = 'normal'; await h.replace('reload'); await ticks();
  assert.equal(h.generation, 3); assert.equal(h.polling, false); assert.equal(h.sent.length, 0);
  assert.equal(claims(h).length, 0);
});

test('named but never-flushed session refuses a non-durable handoff', async t => {
  const h = await harness(t, { persisted: false });
  await h.start('local'); await h.receive('retain in old instance'); await h.receive('stop');
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0); assert.equal(h.polling, true);
  assert.match(h.notices.at(-1).text, /refused|persisted/i);
});

test('stop arriving during an album download keeps that prepared turn held through reload', async t => {
  const h = await harness(t); await h.start('local');
  const gate = deferred(); let downloading = false;
  h.networkGate = async method => { if (method === 'download') { downloading = true; await gate.promise; } };
  await h.receive('held album', { media_group_id: 'a', photo: [{ file_id: 'photo' }] });
  t.mock.timers.tick(1200); await until(() => downloading);
  await h.receive('stop');
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await ticks();
  assert.equal(h.generation, 1); gate.resolve(); await reload;
  assert.equal(snapshots(h)[0].data.held, true); assert.equal(h.sent.length, 0);
  await h.receive('release'); await until(() => h.sent.length === 1);
  assert.match(text(h.sent[0]), /held album/); assert.match(text(h.sent[0]), /Attachments:/);
  assert.equal(h.maxPolls, 1);
});

// Only the harness-owned fake session stat is delayed. Rebind named built-in
// exports both when mocking and restoring; never leave a mock for the next case.
for (const result of ['not-file', 'missing', 'throw-isFile']) {
  for (const hold of ['none', 'stop']) {
    test(`pre-quiesce ${result} refusal restores a consumed drain (${hold})`, async t => {
      const h = await harness(t);
      const fs = (await import('node:fs/promises')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const original = fs.stat, persistence = deferred(), download = deferred();
      let checking = false, downloading = false;
      const mock = t.mock.method(fs, 'stat', async (path, ...args) => {
        if (path !== h.ctx.sessionManager.getSessionFile()) return original(path, ...args);
        checking = true;
        await persistence.promise;
        if (result === 'missing') throw new Error('fake missing session');
        return { isFile() { if (result === 'throw-isFile') throw new Error('fake stat error'); return false; } };
      });
      syncBuiltinESMExports();
      try {
        h.networkGate = async method => { if (method === 'download') { downloading = true; await download.promise; } };
        await h.receive('first', { document: { file_id: 'fake-doc', file_name: 'fake.txt' } });
        await until(() => downloading);
        await h.receive('second');
        const reload = h.command('telegram-reload');
        await until(() => checking);
        if (hold === 'stop') await h.receive('stop');
        download.resolve();
        for (let i = 0; i < 100; i++) {
          const d = await h.diagnostic();
          if (d.queued === 2 && !d.preparing && !d.drainScheduled) break;
          await ticks();
        }
        const blocked = await h.diagnostic();
        assert.equal(blocked.queued, 2); assert.equal(blocked.preparing, false);
        assert.equal(blocked.drainScheduled, false); assert.equal(blocked.reloadPending, true);
        assert.equal(h.sent.length, 0);
        const polls = h.network.filter(n => n.method === 'getUpdates').length;
        persistence.resolve(); await reload; await ticks();
        assert.equal(h.generation, 1); assert.equal(snapshots(h).length, 0);
        assert.deepEqual(h.lifecycle, []);
        assert.equal(h.network.filter(n => n.method === 'getUpdates').length, polls);
        assert.equal(h.polling, true);
        assert.equal(h.sent.length, hold === 'none' ? 1 : 0, 'refusal must restore normal guarded admission without another event');
        if (hold === 'none') {
          assert.match(text(h.sent[0]), /first/);
          await h.start(); await h.end(); await h.settle(); await ticks();
          assert.equal(h.sent.length, 2); assert.match(text(h.sent[1]), /second/);
          await h.start(); await h.end(); await h.settle(); await ticks();
          assert.equal(h.sent.length, 2);
        } else {
          await h.settle(); await ticks(); assert.equal(h.sent.length, 0);
        }
        assert.equal(h.errors.length, 0);
      } finally {
        persistence.resolve(); download.resolve(); mock.mock.restore(); syncBuiltinESMExports();
      }
    });
  }
}

for (const mode of ['held', 'disconnected', 'held-disconnected']) {
  test(`restored ${mode} diagnostic ages advance without lifecycle wakes`, async t => {
    const h = await harness(t);
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    await h.start('local'); await h.receive('queued');
    const held = mode.includes('held');
    if (held) await h.receive('stop');
    if (mode.includes('disconnected')) await h.command('telegram-disconnect');
    now += 120_000; // pre-restoration age must not be invented in the new instance
    const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
    assert.equal(h.generation, 2);
    const before = await h.diagnostic();
    assert.equal(before.queued, 1); assert.equal(before.held, held);
    assert.equal(before.agesMs.queued, 0);
    const requests = h.network.length, restoredAt = now;
    for (const elapsed of [60_000, 90_000]) {
      now += elapsed;
      const after = await h.diagnostic();
      assert.equal(after.agesMs.queued, now - restoredAt, 'queue age is restoration-relative');
      if (held) assert.equal(after.agesMs.held, after.agesMs.queued);
      assert.deepEqual(after.lifecycle.map(e => e.event), before.lifecycle.map(e => e.event));
      assert.equal(h.sent.length, 0); assert.equal(h.network.length, requests);
    }
  });
}

test('pre-quiesce missing-session catch preserves a restored disconnected queue', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('retained');
  await h.command('telegram-disconnect');
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  const requests = h.network.length;
  h.sessionFile = undefined;
  await h.command('telegram-reload'); await ticks(); await h.settle(); await ticks();
  assert.equal(h.generation, 2); assert.equal(snapshots(h).length, 1);
  assert.equal(h.sent.length, 0); assert.equal(h.network.length, requests);
  assert.equal((await h.diagnostic()).restoredDisconnected, true);
});

test('recovery-required early return cannot release restored work or restart polling', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('retained');
  h.reloadHook = async phase => { if (phase === 'after') h.networkGate = async method => { if (method === 'getUpdates') throw new Error('fake offline'); }; };
  const reload = h.command('telegram-reload'); await h.end(); await h.settle(); await reload;
  const requests = h.network.length;
  await h.command('telegram-reload'); await h.settle(); await ticks();
  assert.equal((await h.diagnostic()).recoveryRequired, true);
  assert.equal(h.generation, 2); assert.equal(snapshots(h).length, 1);
  assert.equal(h.sent.length, 0); assert.equal(h.network.length, requests);
});
