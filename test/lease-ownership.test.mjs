// The per-user Telegram profile lease belongs only to a session that is connected
// (or handing its connection over). Regression: a second, never-connected
// session took the lease on reload, so the owner's next reload could not reconnect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { harness, until } from './harness.mjs';
import { AdmissionLease } from '../admission-lease.ts';

const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const profile = hash(['pi-telegram/profile-writer/v1']);
const root = h => join(fs.realpathSync(h.home), '.pi/agent/telegram-inbox');
const idle = async () => { await tick(); await tick(); };
const lease = async h => (await h.diagnostic()).admission;
// The lock is free exactly when an outside acquirer can take and give it back.
function lockFree(h) {
  fs.mkdirSync(root(h), { recursive: true, mode: 0o700 });
  try { AdmissionLease.acquire(root(h), profile).release(); return true; }
  catch (error) { if (error.code === 'already-owned' || error.code === 'contended') return false; throw error; }
}
// A second Pi session of the same user: same HOME, lock and config; its own session.
const second = (t, h, options = {}) => harness(t, { shareWith: h, connected: false, sessionId: 'session-b', sessionFileName: 'session-b.jsonl', ...options });

test('a session that never connects holds no lease, even across its own reloads', async t => {
  const h = await harness(t, { connected: false });
  assert.equal((await lease(h)).lease, false); assert.equal(lockFree(h), true);
  for (let i = 0; i < 3; i++) {
    await h.command('telegram-reload');
    const state = await h.diagnostic();
    assert.equal(state.admission.lease, false, 'a disconnected reload must not take the lease');
    assert.equal(state.recoveryRequired, false); assert.equal(state.polling, false);
    assert.equal(lockFree(h), true);
  }
  assert.equal(h.generation, 4); assert.equal(h.network.length, 0);
});

test('local inbox inspection in a disconnected session gives the lease back', async t => {
  const h = await harness(t, { connected: false });
  await h.command('telegram-inbox', 'summary');
  assert.equal((await lease(h)).lease, false); assert.equal(lockFree(h), true);
});

test('disconnect releases the lease and connect takes it again', async t => {
  const h = await harness(t);
  assert.equal((await lease(h)).lease, true); assert.equal(lockFree(h), false);
  await h.command('telegram-disconnect');
  assert.equal((await lease(h)).lease, false); assert.equal(lockFree(h), true);
  await h.command('telegram-connect'); await until(() => h.polling);
  assert.equal((await lease(h)).lease, true);
});

test('a second session starting and reloading never takes Telegram from the connected one', async t => {
  const a = await harness(t, { sessionId: 'session-a' });
  const b = await second(t, a);
  assert.equal((await lease(b)).lease, false);
  for (let round = 0; round < 3; round++) {
    await b.command('telegram-reload');
    assert.equal((await lease(b)).lease, false); assert.equal((await b.diagnostic()).recoveryRequired, false);
    await a.command('telegram-reload'); await until(() => a.polling);
    const state = await a.diagnostic();
    assert.equal(state.admission.lease, true); assert.equal(state.polling, true);
    assert.equal(state.recoveryRequired, false); assert.equal(state.admission.leaseUncertain, false);
  }
  // Telegram still works in the owner's session after all of that.
  await a.receive('still here'); await until(() => a.sent.length === 1);
  await b.shutdown();
});

test('an idle session reloading inside the owner\'s reload handoff cannot steal the lease', async t => {
  // The owner's lease is free only between its old runtime's shutdown and the new
  // runtime's restore. The idle session reloads exactly there (both reload together
  // when the profile changes). Before the fix its restore took the lease there.
  const a = await harness(t, { sessionId: 'session-a' });
  const b = await second(t, a);
  let reloadedB = false;
  a.reloadHook = async stage => { if (stage === 'after') { await b.command('telegram-reload'); reloadedB = true; } };
  await a.command('telegram-reload'); assert.ok(reloadedB);
  await until(() => a.polling);
  const state = await a.diagnostic();
  assert.equal(state.polling, true); assert.equal(state.admission.lease, true); assert.equal(state.recoveryRequired, false);
  assert.equal((await lease(b)).lease, false);
  await a.receive('after handoff'); await until(() => a.sent.length === 1);
  await b.shutdown();
});

test('owner disconnects, idle session reloads, owner reconnects without repair', async t => {
  // The incident sequence: the owner's session had stopped polling (its lease free)
  // when the other session reloaded; its /telegram-connect then needed operator repair.
  const a = await harness(t, { sessionId: 'session-a' });
  const b = await second(t, a);
  await a.command('telegram-disconnect'); assert.equal(lockFree(a), true);
  await b.command('telegram-reload'); assert.equal((await lease(b)).lease, false);
  await a.command('telegram-connect'); await until(() => a.polling);
  const state = await a.diagnostic();
  assert.equal(state.polling, true); assert.equal(state.admission.lease, true); assert.equal(state.admission.leaseUncertain, false);
  assert.ok(!a.notices.some(n => /operator repair/.test(n.text)));
  await b.shutdown();
});

test('a failed handoff that stopped polling gives the lease back; reconnect works', async t => {
  const a = await harness(t, { sessionId: 'session-a' });
  a.appendHook = () => { throw new Error('disk full'); };
  await a.command('telegram-reload');
  assert.match(a.notices.at(-1).text, /stopped before teardown/);
  assert.equal(a.polling, false); assert.equal((await lease(a)).lease, false); assert.equal(lockFree(a), true);
  a.appendHook = () => {};
  await a.command('telegram-connect'); await until(() => a.polling);
  assert.equal((await lease(a)).lease, true);
});

test('connect while another session is connected names it, latches nothing, and works once it disconnects', async t => {
  const a = await harness(t, { sessionId: 'session-a' });
  const b = await second(t, a);
  const calls = a.network.length;
  await b.command('telegram-connect');
  const refusal = b.notices.at(-1).text;
  assert.match(refusal, new RegExp(`connected in another Pi session \\(pid ${process.pid}, session session-a, cwd `));
  assert.match(refusal, /\/telegram-disconnect there/);
  assert.doesNotMatch(refusal, /operator repair/);
  let state = await b.diagnostic();
  assert.equal(state.polling, false); assert.equal(state.admission.lease, false);
  assert.equal(state.admission.leaseUncertain, false); assert.equal(state.admission.fault, false); assert.equal(state.admission.heldElsewhere, true);
  assert.match(await b.status(), /lease holder \(last refusal\): Telegram is connected in another Pi session \(pid/);
  assert.equal(a.network.length, calls, 'the refused session made no Telegram calls');
  assert.equal((await a.diagnostic()).polling, true);

  await a.command('telegram-disconnect'); await idle();
  await b.command('telegram-connect');
  await until(() => a.polling); // the shared fake server now serves b's poll
  state = await b.diagnostic();
  assert.equal(state.polling, true); assert.equal(state.admission.lease, true); assert.equal(state.admission.heldElsewhere, false);
  assert.equal(JSON.parse(fs.readFileSync(join(root(a), `${profile}.holder`), 'utf8')).sessionId, 'session-b');
  await b.command('telegram-disconnect');
  assert.equal(fs.existsSync(join(root(a), `${profile}.holder`)), false, 'holder note removed with the lease');
  await b.shutdown();
});

test('a connected handoff restored while another session holds Telegram stays disconnected, not in recovery', async t => {
  const a = await harness(t, { sessionId: 'session-a' });
  const b = await second(t, a);
  // Another session connects in the gap between the old runtime's release and the
  // new runtime's restore (only an explicit connect can do this now).
  a.reloadHook = async stage => { if (stage === 'after') await b.command('telegram-connect'); };
  await a.command('telegram-reload');
  const state = await a.diagnostic();
  assert.equal(state.recoveryRequired, false); assert.equal(state.reloadPending, false);
  assert.equal(state.admission.lease, false); assert.equal(state.admission.leaseUncertain, false);
  assert.match(a.notices.at(-1).text, /handoff not restored; this session stays disconnected\. Telegram is connected in another Pi session \(pid \d+, session session-b/);
  // Hand it back: b disconnects, a connects without any repair.
  await b.command('telegram-disconnect'); await idle();
  await a.command('telegram-connect'); await until(() => a.polling);
  assert.equal((await a.diagnostic()).polling, true);
  await b.shutdown();
});
