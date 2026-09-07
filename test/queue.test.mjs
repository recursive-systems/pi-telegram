import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { harness, deferred, until, assistant } from './harness.mjs';

test('non-Telegram busy turn drains only at settled; unrelated starts cannot claim queue', async t => {
  const h = await harness(t);
  await h.start('[jobs] completion');
  await h.receive('first');
  assert.equal(h.sent.length, 0);
  assert.match(h.statuses.at(-1), /waiting.*1 queued/);
  await h.start('local request');
  await assert.rejects(h.attach(['/irrelevant']), /active Telegram turn/);
  await h.end('LOCAL PRIVATE OUTPUT');
  assert.equal(h.sent.length, 0);
  assert.ok(!h.network.some(n => n.body.text?.includes('LOCAL PRIVATE')));
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0][0].text, /first/);
});

test('FIFO, duplicate idle events and arrivals during reserved submission', async t => {
  const h = await harness(t); h.idle = false;
  for (const text of ['one', 'two', 'three']) await h.receive(text);
  await h.settle(); await h.settle(); await h.receive('four');
  assert.equal(h.sent.length, 1);
  for (let i = 0; i < 4; i++) {
    assert.match(h.sent[i][0].text, new RegExp(['one', 'two', 'three', 'four'][i]));
    await h.start(h.sent[i]); await h.end(); await h.settle();
  }
  assert.equal(h.sent.length, 4);
});

test('reservation precedes synchronous lifecycle reentrancy', async t => {
  const h = await harness(t); const starts = [];
  h.onSend = content => { starts.push(h.start(content)); void h.emit('agent_settled'); };
  await h.receive('reentrant'); await Promise.all(starts);
  assert.equal(h.sent.length, 1);
  assert.match(h.statuses.at(-1), /processing/);
  await h.end(); await h.settle(); assert.equal(h.sent.length, 1);
});

test('pending Pi messages block dispatch; retries retain Telegram ownership until settled', async t => {
  const h = await harness(t); h.pending = true;
  await h.receive('request'); await h.settle(); assert.equal(h.sent.length, 0);
  h.pending = false; await h.settle(); await h.start();
  await h.receive('next'); await h.end('', 'error');
  await h.emit('agent_start'); await h.end('retry succeeded');
  assert.equal(h.sent.length, 1);
  await h.settle(); assert.equal(h.sent.length, 2);
  assert.ok(h.network.some(n => n.body.text === 'retry succeeded'));
  assert.ok(!h.network.some(n => n.body.text === 'model failed'));
});

for (const reason of ['error', 'aborted']) test(`${reason} does not strand future Telegram work`, async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start(); await h.receive('second');
  await h.end('', reason); await h.settle();
  assert.equal(h.sent.length, 2);
});

test('Telegram stop holds FIFO history until next user message resumes', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start(); await h.receive('held one'); await h.receive('held two');
  await h.receive('/stop'); assert.equal(h.aborts, 1);
  await h.end('', 'aborted'); await h.settle(); await h.settle();
  assert.equal(h.sent.length, 1);
  await h.receive('resume'); assert.equal(h.sent.length, 2);
  assert.match(h.sent[1][0].text, /1\. held one[\s\S]*2\. held two[\s\S]*Current Telegram message:\nresume/);
});

test('reply network wait blocks duplicate dispatch; unrelated run cannot attach or change reply', async t => {
  const h = await harness(t);
  const file = join(h.home, 'artifact.txt'); await writeFile(file, 'artifact');
  await h.receive('make file'); await h.start(); await h.attach([file]); await h.receive('second');
  await h.end('Telegram answer');
  const gate = deferred(); let waiting = false;
  h.networkGate = async method => { if (method === 'sendMessage') { waiting = true; await gate.promise; } };
  const settling = h.settle(); await until(() => waiting);
  await h.settle(); await h.receive('third');
  assert.equal(h.sent.length, 1);
  await h.start('unrelated'); await assert.rejects(h.attach([file]), /active Telegram turn/);
  await h.end('LOCAL OUTPUT');
  gate.resolve(); await settling;
  assert.equal(h.sent.length, 1); // unrelated run still busy
  await h.settle(); assert.equal(h.sent.length, 2);
  assert.ok(h.network.some(n => n.method === 'sendDocument' && n.body.chat_id === '70'));
  assert.ok(!h.network.some(n => n.body.text === 'LOCAL OUTPUT'));
});

test('reply failure releases dispatch lock', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start(); await h.receive('second'); await h.end('answer');
  h.networkGate = async () => { throw new Error('offline failure'); };
  await h.settle(); assert.equal(h.sent.length, 2);
});

test('Pi follow-up user messages cannot leak text or attachments into Telegram reply', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start();
  await h.emit('message_end', { message: assistant('Telegram answer') });
  await h.emit('message_start', { message: { role: 'user', content: [{ type: 'text', text: 'local followup' }] } });
  await assert.rejects(h.attach(['/irrelevant']), /active Telegram turn/);
  await h.emit('message_update', { message: assistant('LOCAL OUTPUT') });
  await h.end('LOCAL OUTPUT'); await h.settle();
  assert.ok(h.network.some(n => n.body.text === 'Telegram answer'));
  assert.ok(!h.network.some(n => n.body.text === 'LOCAL OUTPUT'));
});

test('synchronous submission error after effects retains uncertain ownership without retry', async t => {
  const h = await harness(t); h.onSend = () => { throw new Error('rejected'); };
  await h.receive('retain me'); assert.match(h.statuses.at(-1), /submission failed/);
  h.onSend = () => {}; await h.settle();
  assert.equal(h.sent.length, 1); assert.equal((await h.diagnostic()).uncertainReply, true);
  assert.equal((await h.diagnostic()).submitted, true);
});

test('shutdown cancels polling, preview and album timers; later hooks cannot submit', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start();
  await h.emit('message_update', { message: assistant('preview') });
  await h.receive('album', { media_group_id: 'album-1' });
  await h.receive('queued'); await h.shutdown();
  const requests = h.network.length;
  t.mock.timers.tick(10000);
  await h.settle(); await h.emit('agent_start');
  assert.equal(h.sent.length, 1); assert.equal(h.network.length, requests);
});

test('original regression: jobs completion wakes queued Telegram prompt', async t => {
  const h = await harness(t);
  await h.start('[jobs] completion'); await h.receive('waiting request');
  await h.end('job finished'); await h.settle();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0][0].text, /waiting request/);
});

test('in-flight preview finishes before final reply and next turn', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start(); await h.receive('second');
  const gate = deferred(); let waiting = false;
  h.networkGate = async (method, body) => {
    if (method === 'sendMessageDraft' && body.text === 'partial') { waiting = true; await gate.promise; }
  };
  await h.emit('message_update', { message: assistant('partial') });
  t.mock.timers.tick(750); await until(() => waiting);
  await h.end('final'); const settling = h.settle(); await h.settle();
  const diagnostic = await h.diagnostic();
  assert.equal(diagnostic.finalizing, true);
  assert.equal(diagnostic.previewFlushing, true);
  assert.equal(diagnostic.finalizationStage, 'preview-or-text');
  assert.equal(h.sent.length, 1);
  gate.resolve(); await settling;
  assert.equal(h.sent.length, 2);
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'final').length, 1);
  const requests = h.network.length;
  t.mock.timers.tick(1000); await immediate();
  assert.equal(h.network.length, requests);
});

test('shutdown during final reply aborts network and cannot dispatch queued work', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start(); await h.receive('second'); await h.end('answer');
  let waiting = false;
  h.networkGate = async (method, _body, signal) => {
    if (method !== 'sendMessage') return;
    waiting = true;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }));
  };
  const settling = h.settle(); await until(() => waiting);
  await h.shutdown(); await settling;
  const requests = h.network.length;
  t.mock.timers.tick(10000); await h.settle();
  assert.equal(h.sent.length, 1); assert.equal(h.network.length, requests);
});

test('suspended foreign pre-start blocks admission while host still reports idle', async t => {
  const h = await harness(t); const gate = deferred(); let waiting = false;
  h.beforeStart = async prompt => { if (prompt === 'foreign') { waiting = true; await gate.promise; } };
  const foreign = h.start('foreign'); await until(() => waiting);
  h.asyncAdmission();
  await h.receive('telegram'); await h.settle();
  assert.equal(h.sent.length, 0);
  gate.resolve(); await foreign; await h.end('PRIVATE'); await h.settle();
  await until(() => h.sent.length === 1);
  assert.ok(!h.network.some(n => n.body.text === 'PRIVATE'));
});

test('deferred settled drain rechecks a newly suspended foreign preflight', async t => {
  const h = await harness(t); h.idle = false; await h.receive('queued');
  const gate = deferred(); h.beforeStart = () => gate.promise;
  const settling = h.settle(); const foreign = h.start('foreign');
  await settling; assert.equal(h.sent.length, 0);
  gate.resolve(); await foreign; await h.end(); await h.settle();
  assert.equal(h.sent.length, 1);
});

for (const outcome of ['reject', 'handled', 'remove-marker']) test(`void async admission ${outcome}: no speculative resend or overtaking`, async t => {
  const h = await harness(t); const gate = deferred();
  h.asyncAdmission(async () => {
    await gate.promise;
    if (outcome === 'reject') throw new Error('missing auth (fake)');
    if (outcome === 'handled') return 'handled';
  }, () => 'transformed without identity');
  await h.receive('same'); await h.receive('same'); await h.settle();
  assert.equal(h.sent.length, 1);
  gate.resolve(); await immediate(); await immediate();
  if (outcome === 'remove-marker') { await h.end('PRIVATE'); }
  await h.settle(); await h.receive('later'); await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.errors.length, outcome === 'reject' ? 1 : 0);
  assert.ok(!h.network.some(n => n.body.text === 'PRIVATE'));
});

test('same-text arrivals keep unique identity through compatible input transformation', async t => {
  const h = await harness(t);
  h.asyncAdmission(async () => {}, content => `Other extension instructions\n${content[0].text}\nMore instructions`);
  await h.receive('same'); await until(() => h.statuses.at(-1).includes('processing'));
  await h.receive('same'); assert.equal(h.sent.length, 1);
  await h.end('first'); await h.settle();
  await until(() => h.sent.length === 2 && h.statuses.at(-1).includes('processing'));
  assert.notEqual(h.sent[0][0].text, h.sent[1][0].text);
  await h.end('second'); await h.settle();
  assert.equal(h.sent.length, 2);
  assert.ok(h.network.some(n => n.body.text === 'first'));
  assert.ok(h.network.some(n => n.body.text === 'second'));
});

test('album reserves FIFO on first arrival, including debounce and successful downloads', async t => {
  const h = await harness(t);
  await h.receive(undefined, { caption: 'album first', media_group_id: 'a', document: { file_id: 'one', file_name: 'one.txt' } });
  await h.receive('text second');
  t.mock.timers.tick(600);
  await h.receive(undefined, { caption: 'album next', media_group_id: 'a', photo: [{ file_id: 'two' }] });
  t.mock.timers.tick(600); await immediate(); assert.equal(h.sent.length, 0);
  t.mock.timers.tick(600); await until(() => h.sent.length === 1);
  assert.match(h.sent[0][0].text, /album first[\s\S]*album next/);
  assert.equal(h.sent[0][1].type, 'image');
  assert.equal(h.network.filter(n => n.method === 'download').length, 2);
  await h.start(); await h.end(); await h.settle();
  assert.match(h.sent[1][0].text, /text second/);
});

for (const album of [false, true]) test(`stop during ${album ? 'album' : 'single-file'} download cannot be undone by preparation`, async t => {
  const h = await harness(t); const gate = deferred(); let downloading = false;
  h.networkGate = async method => { if (method === 'download') { downloading = true; await gate.promise; } };
  await h.receive('before stop', { ...(album ? { media_group_id: 'a' } : {}), document: { file_id: 'one', file_name: 'one.txt' } });
  if (album) t.mock.timers.tick(1200);
  await until(() => downloading);
  await h.receive('also before stop'); await h.receive('/stop');
  gate.resolve(); await until(() => h.statuses.at(-1).includes('2 queued'));
  await h.settle(); assert.equal(h.sent.length, 0);
  await h.receive('resume'); await until(() => h.sent.length === 1);
  assert.match(h.sent[0][0].text, /1\. before stop[\s\S]*2\. also before stop[\s\S]*Current Telegram message:\nresume/);
});

test('stop during album debounce holds its earlier arrival', async t => {
  const h = await harness(t);
  await h.receive('album before stop', { media_group_id: 'a' }); await h.receive('/stop');
  t.mock.timers.tick(1200); await until(() => h.statuses.at(-1).includes('1 queued'));
  await h.settle(); assert.equal(h.sent.length, 0);
  await h.receive('resume'); await until(() => h.sent.length === 1);
  assert.match(h.sent[0][0].text, /1\. album before stop/);
});

for (const reason of ['error', 'aborted', 'long']) test(`${reason} cleanup waits for failed in-flight draft without late fallback`, async t => {
  const h = await harness(t); const gate = deferred(); let waiting = false;
  await h.receive('first'); await h.start(); await h.receive('second');
  h.networkGate = async (method, body) => {
    if (method === 'sendMessageDraft' && body.text === 'partial') { waiting = true; await gate.promise; throw new Error('no drafts'); }
  };
  await h.emit('message_update', { message: assistant('partial') });
  t.mock.timers.tick(750); await until(() => waiting);
  await h.end(reason === 'long' ? 'x'.repeat(5000) : '', reason === 'long' ? 'stop' : reason);
  const settling = h.settle(); await immediate();
  assert.equal(h.sent.length, 1);
  gate.resolve(); await settling; assert.equal(h.sent.length, 2);
  assert.ok(!h.network.some(n => n.method === 'sendMessage' && n.body.text === 'partial'));
  const requests = h.network.length; t.mock.timers.tick(1000); await immediate();
  assert.equal(h.network.length, requests);
});

for (const outcome of ['success', 'failure']) test(`manual compaction ${outcome} drains after busy-to-idle cleanup without agent_settled`, async t => {
  const h = await harness(t); h.idle = false;
  await h.emit('session_before_compact'); await h.receive('queued');
  assert.equal(h.sent.length, 0);
  // Installed Pi clears manual compaction state BEFORE emitting failure hooks.
  if (outcome === 'failure') h.idle = true;
  await h.emit(outcome === 'success' ? 'session_compact' : 'session_compact_failed', { reason: 'manual', willRetry: false });
  assert.equal(h.sent.length, 0); // success hook precedes host cleanup
  h.idle = true; await immediate(); assert.equal(h.sent.length, 1);
  await h.emit('session_compact'); await immediate(); assert.equal(h.sent.length, 1);
});

test('stale preflight, download and compaction hooks cannot send after shutdown', async t => {
  const h = await harness(t); const gate = deferred(); let downloading = false;
  h.networkGate = async method => { if (method === 'download') { downloading = true; await gate.promise; } };
  await h.receive('download', { document: { file_id: 'one' } }); await until(() => downloading);
  await h.shutdown(); const requests = h.network.length;
  gate.resolve(); await immediate(); await immediate();
  await h.start('stale'); await h.emit('session_compact'); await h.emit('session_compact_failed'); await h.settle();
  t.mock.timers.tick(10000); await immediate();
  assert.equal(h.sent.length, 0); assert.equal(h.network.length, requests);
});

test('reply failure status is not immediately replaced by connected status', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start(); await h.end();
  h.networkGate = async () => { throw new Error('offline failure'); };
  await h.settle(); assert.match(h.statuses.at(-1), /reply failed/);
});

test('deferred compaction drain rechecks pending host messages and shutdown', async t => {
  const h = await harness(t); h.idle = false; await h.receive('queued');
  await h.emit('session_compact'); h.idle = true; h.pending = true;
  await immediate(); assert.equal(h.sent.length, 0);
  h.pending = false; await h.emit('session_compact_failed');
  await h.shutdown(); await immediate(); assert.equal(h.sent.length, 0);
});

test('repeated stop during resume download preserves transitive held history', async t => {
  const h = await harness(t); await h.start('busy local work');
  await h.receive('original held B'); await h.receive('/stop');
  const gate = deferred(); let downloading = false;
  h.networkGate = async method => { if (method === 'download') { downloading = true; await gate.promise; } };
  await h.receive('resume C', { document: { file_id: 'one', file_name: 'resume.txt' } });
  await until(() => downloading); await h.receive('/stop');
  gate.resolve(); await until(() => h.statuses.at(-1).includes('1 queued'));
  await h.end('', 'aborted'); await h.settle(); assert.equal(h.sent.length, 0);
  await h.receive('resume D'); await until(() => h.sent.length === 1);
  const text = h.sent[0][0].text;
  assert.match(text, /original held B[\s\S]*resume C[\s\S]*resume\.txt[\s\S]*resume D/);
  assert.equal(text.split('original held B').length - 1, 1);
});

test('manual compaction wake survives a later slow success hook', async t => {
  const h = await harness(t); h.idle = false; await h.receive('queued');
  await h.emit('session_compact', { reason: 'manual', willRetry: false });
  // Pi awaits later extension handlers before clearing its compaction state.
  await immediate(); t.mock.timers.tick(100); await immediate();
  t.mock.timers.tick(100); await immediate(); assert.equal(h.sent.length, 0);
  h.idle = true; t.mock.timers.tick(100); await immediate();
  assert.equal(h.sent.length, 1);
  t.mock.timers.tick(1000); await immediate(); assert.equal(h.sent.length, 1);
});

test('shutdown cancels the delayed manual compaction wake', async t => {
  const h = await harness(t); h.idle = false; await h.receive('queued');
  await h.emit('session_compact', { reason: 'manual', willRetry: false });
  await immediate(); await h.shutdown(); h.idle = true;
  t.mock.timers.tick(1000); await immediate(); assert.equal(h.sent.length, 0);
});

// AgentSession._emitAgentSettled clears streaming before awaiting extension hooks.
// The command path remains usable while our settled hook awaits Telegram transport.
test('status exposes finalization despite zero active and queued turns', async t => {
  const h = await harness(t);
  await h.receive('SECRET PROMPT'); await h.start(); await h.end('SECRET REPLY');
  const gate = deferred(); let waiting = false;
  h.networkGate = async method => { if (method === 'sendMessage') { waiting = true; await gate.promise; } };
  const settling = h.settle(); await until(() => waiting);
  try {
    const status = await h.status();
    assert.match(status, /finalizing: true/);
    const d = await h.diagnostic();
    assert.equal(d.active, false); assert.equal(d.queued, 0);
    assert.equal(d.finalizing, true); assert.equal(d.hostIdle, true);
    assert.equal(d.blocker, 'finalizing');
    assert.equal(typeof d.agesMs.finalizing, 'number');
    assert.ok(!JSON.stringify(d).match(/SECRET|FAKE|https:|\/Users|allowedUser|chatId/));
  } finally { gate.resolve(); await settling; }
  assert.equal((await h.diagnostic()).finalizing, false);
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'SECRET REPLY').length, 1);
});


test('diagnostic tool is opt-in and attach stays registered', async t => {
  const h = await harness(t, { diagnosticsEnabled: false });
  assert.equal(h.tools.has('telegram_diagnostics'), false);
  assert.equal(h.tools.has('telegram_attach'), true);
  assert.match(await h.status(), /finalizing: false/);
});

test('diagnostics distinguish submitted, suspended preflight, active and held ages', async t => {
  const h = await harness(t);
  await h.receive('PRIVATE');
  let d = await h.diagnostic();
  assert.equal(d.submitted, true); assert.equal(d.queued, 1);
  assert.equal(d.blocker, 'submitted'); assert.equal(typeof d.agesMs.submitted, 'number');
  const gate = deferred(); h.beforeStart = () => gate.promise;
  const starting = h.start(); await until(() => h.statuses.at(-1).includes('waiting'));
  await immediate();
  d = await h.diagnostic();
  assert.equal(d.preflight, true); assert.equal(d.awaitingTelegramStart, true);
  assert.equal(d.active, true); assert.equal(d.submitted, false); assert.equal(d.hostIdle, true);
  assert.equal(d.blocker, 'preflight');
  gate.resolve(); await starting;
  d = await h.diagnostic(); assert.equal(d.preflight, false); assert.equal(d.hostIdle, false);
  assert.equal(d.blocker, 'active-awaiting-settlement');
  await h.receive('held'); await h.receive('/stop');
  d = await h.diagnostic(); assert.equal(d.held, true); assert.equal(typeof d.agesMs.held, 'number');
  await h.end('', 'aborted'); await h.settle();
  d = await h.diagnostic(); assert.equal(d.blocker, 'held'); assert.equal(d.queued, 1);
  assert.equal(h.sent.length, 1);
});

test('missing settlement remains observable; local/jobs continuation cannot steal reply', async t => {
  const h = await harness(t);
  await h.receive('PRIVATE REQUEST'); await h.start();
  await h.emit('message_end', { message: assistant('Telegram answer') });
  await h.end('Telegram answer');
  // agent_end handlers may enqueue background completion/local followups. Pi
  // continues before settlement, without a new before_agent_start admission.
  h.pending = true;
  let d = await h.diagnostic();
  assert.equal(d.active, true); assert.equal(d.hostIdle, false); assert.equal(d.hostPending, true);
  assert.equal(d.lifecycle.at(-1).event, 'agent-end');
  assert.ok(!h.network.some(n => n.method === 'sendMessage'));
  await h.emit('agent_start'); h.pending = false;
  await h.emit('message_start', { message: { role: 'user', content: 'LOCAL JOB FOLLOWUP' } });
  await h.emit('message_end', { message: assistant('PRIVATE LOCAL OUTPUT') });
  await h.end('PRIVATE LOCAL OUTPUT');
  d = await h.diagnostic(); assert.equal(d.routingTelegram, false); assert.equal(d.active, true);
  await h.settle();
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'Telegram answer').length, 1);
  assert.ok(!h.network.some(n => n.body.text === 'PRIVATE LOCAL OUTPUT'));
});

test('diagnostics retain skipped settlement and compaction metadata without waking or leaking', async t => {
  const h = await harness(t); h.idle = false;
  await h.receive('PRIVATE');
  await h.emit('agent_settled'); // earlier settled handler started another run
  let d = await h.diagnostic();
  assert.equal(d.hostIdle, false); assert.equal(d.queued, 1);
  assert.equal(d.lifecycle.at(-1).event, 'agent-settled-observed');
  await h.emit('session_before_compact', { reason: 'overflow' });
  await h.emit('session_compact_failed', { reason: 'overflow', errorMessage: 'SECRET https://credential/path' });
  const before = h.network.length;
  for (let i = 0; i < 40; i++) await h.emit('agent_end', { messages: [] });
  d = await h.diagnostic();
  assert.ok(d.lifecycle.length <= 16);
  const stable = await h.diagnostic();
  assert.equal(stable.instance, d.instance); assert.equal(stable.loadedAt, d.loadedAt);
  assert.equal(h.sent.length, 0); assert.equal(h.network.length, before);
  assert.ok(!JSON.stringify(d).match(/SECRET|PRIVATE|https:|FAKE/));
  await h.shutdown(); d = await h.diagnostic(); assert.equal(d.blocker, 'closed');
});

for (const slow of [false, true]) test(`owed settled reply wakes after manual compaction (slow hook: ${slow})`, async t => {
  const h = await harness(t, { diagnosticsEnabled: false });
  await h.receive('request'); await h.start(); await h.end('completed Telegram reply');
  await h.settle(async () => { await h.beginManualCompaction(); });
  assert.equal(h.network.filter(n => n.method === 'sendMessage').length, 0);
  await h.completeManualCompaction(async () => {
    if (slow) { t.mock.timers.tick(100); await immediate(); }
    assert.equal(h.network.filter(n => n.method === 'sendMessage').length, 0);
  });
  t.mock.timers.tick(100); await immediate(); await immediate();
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'completed Telegram reply').length, 1);
  assert.equal(h.sent.length, 1, 'no new local or Telegram prompt needed');
  await h.emit('session_compact', { reason: 'manual' }); await h.settle(); await h.settle();
  assert.equal(h.network.filter(n => n.method === 'sendMessage').length, 1);
});

for (const reason of ["startup", "reload"]) for (const enabled of [true, false]) test(`diagnostic flag lifecycle: ${reason} override ${enabled}, duplicate startup, fresh execution context`, async t => {
  const h = await harness(t, { diagnosticsEnabled: enabled, sessionReason: reason });
  assert.equal(h.factoryFlag, false);
  assert.deepEqual(h.factoryTools, ['telegram_reload', 'telegram_attach'], 'factory sees flag default, not CLI override');
  assert.equal(h.tools.has('telegram_diagnostics'), enabled);
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('session_start', { reason: 'resume' });
  assert.equal(h.registrations.filter(n => n === 'telegram_diagnostics').length, enabled ? 1 : 0);
  assert.equal(h.registrations.filter(n => n === 'telegram_attach').length, 1);
  if (enabled) {
    // A tool wrapper must pass its current context; no startup context capture.
    const currentCtx = { ...h.ctx, isIdle: () => false, hasPendingMessages: () => true };
    const result = await h.tools.get('telegram_diagnostics').execute('diag', {}, undefined, undefined, currentCtx);
    assert.equal(result.details.hostIdle, false); assert.equal(result.details.hostPending, true);
    assert.equal(h.ctx.isIdle(), true);
    assert.match(h.tools.get('telegram_diagnostics').description, /during this tool call/);
  }
});

test('status is concise by default with content-free bounded detail available', async t => {
  const h = await harness(t, { diagnosticsEnabled: false });
  const brief = await h.status(), detail = await h.status('detail');
  assert.ok(!brief.includes('lifecycle:')); assert.ok(detail.includes('lifecycle:'));
  assert.ok(brief.length < detail.length);
  for (const state of ['configured: true', 'paired: true', 'polling: true']) assert.ok(brief.includes(state), state);
  assert.ok(!detail.match(/FAKE|https:|allowedUser|chatId/));
});

test('owed finalization wakes on manual failure cleanup too', async t => {
  const h = await harness(t);
  await h.receive('request'); await h.start(); await h.end('reply');
  await h.settle(() => h.beginManualCompaction());
  await h.failManualCompaction();
  await until(() => h.network.some(n => n.body.text === 'reply'));
  assert.equal((await h.diagnostic()).settlementOwed, false);
});

test('transport rejection during deferred owed finalization releases the lock and preserves FIFO', async t => {
  const h = await harness(t);
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  await h.receive('first'); await h.start(); await h.receive('second'); await h.receive('third');
  h.networkGate = async (method, body) => {
    if (method === 'sendMessage' && body.text === 'failed reply') throw new Error('fake transport rejection');
  };
  await h.end('failed reply'); await h.settle(() => h.beginManualCompaction());
  await h.completeManualCompaction(); t.mock.timers.tick(100);
  await until(() => h.sent.length === 2);
  await immediate(); await immediate();
  const d = await h.diagnostic();
  assert.equal(d.finalizing, false); assert.equal(d.settlementOwed, false);
  assert.ok(d.lifecycle.some(event => event.event === 'finalization-failed'));
  assert.deepEqual(unhandled, []);
  assert.match(h.sent[1][0].text, /second/);
  assert.doesNotMatch(h.sent[1][0].text, /third/);
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'failed reply').length, 2, 'existing HTML/plain fallback only');
  await h.start(h.sent[1]); await h.end('second answer'); await h.settle();
  assert.equal(h.sent.length, 3); assert.match(h.sent[2][0].text, /third/);
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'failed reply').length, 2, 'no replay after later settlement');
  assert.deepEqual(unhandled, []);
});

test('compaction during a live model run cannot manufacture settlement debt or final reply', async t => {
  const h = await harness(t);
  await h.receive('request'); await h.start(); await h.end('not settled yet');
  // Automatic compaction belongs to the still-active run. Manual compact()
  // would first abort and wait for idle, so do not fake manual overlap here.
  h.compacting = true;
  await h.emit('session_before_compact', { reason: 'threshold' });
  await h.emit('session_compact', { reason: 'threshold' });
  h.compacting = false; t.mock.timers.tick(500); await immediate();
  assert.equal((await h.diagnostic()).settlementOwed, false);
  assert.ok(!h.network.some(n => n.method === 'sendMessage'));
  await h.emit('agent_start'); await h.end('completed'); await h.settle();
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'completed').length, 1);
});

test('compaction completion before the first settled observation does not finalize even if idle', async t => {
  const h = await harness(t);
  await h.receive('request'); await h.start(); await h.end('reply');
  await h.settle(async () => {
    await h.beginManualCompaction(); await h.completeManualCompaction();
    t.mock.timers.tick(100); await immediate();
    assert.ok(!h.network.some(n => n.method === 'sendMessage'));
  });
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'reply').length, 1);
});

test('skipped settled wake rechecks foreign preflight and run without stealing reply ownership', async t => {
  const h = await harness(t);
  await h.receive('request'); await h.start(); await h.end('Telegram reply'); await h.receive('next');
  await h.settle(() => h.beginManualCompaction());
  const gate = deferred(); h.beforeStart = () => gate.promise;
  let foreign;
  await h.completeManualCompaction(async () => {
    await assert.rejects(h.start('foreign-too-early'), /Pi rejects fresh prompts during compaction/);
  }, async () => { foreign = h.start('foreign'); await immediate(); });
  t.mock.timers.tick(100); await immediate();
  assert.equal((await h.diagnostic()).preflight, true);
  assert.equal((await h.diagnostic()).settlementOwed, true);
  assert.ok(!h.network.some(n => n.method === 'sendMessage'));
  gate.resolve(); await foreign;
  assert.equal((await h.diagnostic()).settlementOwed, false);
  await h.emit('session_compact', { reason: 'manual' }); // repeated stale completion
  t.mock.timers.tick(100); await immediate();
  assert.equal(h.sent.length, 1); assert.ok(!h.network.some(n => n.method === 'sendMessage'));
  await h.end('PRIVATE LOCAL'); await h.settle();
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'Telegram reply').length, 1);
  assert.ok(!h.network.some(n => n.body.text === 'PRIVATE LOCAL'));
  assert.equal(h.sent.length, 2);
});

test('owed finalization retains the draft and attachment barrier across compaction wake', async t => {
  const h = await harness(t);
  const file = join(h.home, 'artifact.txt'); await writeFile(file, 'artifact');
  await h.receive('first'); await h.start(); await h.attach([file]); await h.receive('second');
  const gate = deferred(); let waiting = false;
  h.networkGate = async (method, body) => {
    if (method === 'sendMessageDraft' && body.text === 'partial') { waiting = true; await gate.promise; }
  };
  await h.emit('message_update', { message: assistant('partial') });
  t.mock.timers.tick(750); await until(() => waiting);
  await h.end('final'); await h.settle(() => h.beginManualCompaction());
  await h.completeManualCompaction(); t.mock.timers.tick(100); await immediate();
  await h.emit('session_compact', { reason: 'manual' }); await h.settle();
  assert.equal((await h.diagnostic()).finalizing, true);
  assert.equal((await h.diagnostic()).previewFlushing, true);
  assert.equal(h.sent.length, 1);
  assert.ok(!h.network.some(n => n.method === 'sendDocument' || n.method === 'sendMessage'));
  gate.resolve(); await until(() => h.sent.length === 2);
  assert.equal(h.network.filter(n => n.method === 'sendMessage' && n.body.text === 'final').length, 1);
  assert.equal(h.network.filter(n => n.method === 'sendDocument').length, 1);
});

test('shutdown cancels owed finalization and delayed compaction wake', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start(); await h.end('reply'); await h.receive('second');
  await h.settle(() => h.beginManualCompaction());
  await h.completeManualCompaction(async () => { t.mock.timers.tick(100); await immediate(); });
  await h.shutdown(); const count = h.network.length;
  t.mock.timers.tick(1000); await immediate(); await h.settle();
  assert.equal(h.network.length, count); assert.equal(h.sent.length, 1);
  assert.equal((await h.diagnostic()).settlementOwed, false);
});

test('stop holds queued history and aborted owed reply remains unsent after compaction', async t => {
  const h = await harness(t);
  await h.receive('first'); await h.start(); await h.receive('held'); await h.receive('/stop');
  await h.end('', 'aborted'); await h.settle(() => h.beginManualCompaction());
  await h.completeManualCompaction(); t.mock.timers.tick(100); await immediate(); await immediate();
  assert.equal(h.network.filter(n => n.method === 'sendMessage').length, 1, 'only stop acknowledgement');
  assert.equal(h.sent.length, 1); assert.equal((await h.diagnostic()).held, true);
  await h.receive('resume'); assert.equal(h.sent.length, 2);
  assert.match(h.sent[1][0].text, /held[\s\S]*resume/);
});

test('owed finalization wake respects pending host messages', async t => {
  const h = await harness(t);
  await h.receive('request'); await h.start(); await h.end('reply');
  await h.settle(() => h.beginManualCompaction());
  h.pending = true;
  await h.completeManualCompaction(); t.mock.timers.tick(100); await immediate();
  assert.equal((await h.diagnostic()).settlementOwed, true);
  assert.ok(!h.network.some(n => n.method === 'sendMessage'));
  h.pending = false;
  // An existing lifecycle wake, not a new timer or synthetic submission.
  await h.emit('session_compact', { reason: 'manual' }); await immediate();
  await until(() => h.network.some(n => n.method === 'sendMessage' && n.body.text === 'reply'));
  assert.equal(h.sent.length, 1);
});
