import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(check) {
  for (let i = 0; i < 10000; i++) { if (check()) return; await immediate(); }
  assert.fail('fake lifecycle did not reach expected boundary');
}
const assistant = (text = 'answer', stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason, errorMessage: 'model failed' });

async function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const home = await mkdtemp(join(tmpdir(), 'pi-telegram-test-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  await mkdir(join(home, '.pi/agent'), { recursive: true });
  await writeFile(join(home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: 'FAKE-OFFLINE', allowedUserId: 7, lastUpdateId: 0 }));
  const handlers = new Map(), commands = new Map(), tools = new Map(), sent = [], network = [], statuses = [], errors = [];
  let idle = true, pending = false, poll, updateId = 0, onSend = () => {}, networkGate, beforeStart = async () => {};
  const ctx = { isIdle: () => idle, hasPendingMessages: () => pending, abort: () => { h.aborts++; },
    ui: { theme: { fg: (_color, text) => text }, setStatus: (_key, text) => statuses.push(text), notify() {} } };
  const emit = async (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    assert.ok(/^https:\/\/api.telegram.org\/(file\/)?botFAKE-OFFLINE\//.test(String(url)), 'only fake bot URLs allowed');
    if (String(url).includes('/file/')) {
      network.push({ method: 'download', body: {} });
      if (networkGate) await networkGate('download', {}, options.signal);
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('offline attachment').buffer };
    }
    const method = String(url).split('/').at(-1);
    const body = options.body instanceof FormData ? Object.fromEntries(options.body) : JSON.parse(options.body || '{}');
    network.push({ method, body });
    if (method === 'getUpdates') {
      const request = deferred(); poll = request;
      options.signal.addEventListener('abort', () => request.reject(new DOMException('aborted', 'AbortError')), { once: true });
      return { json: async () => ({ ok: true, result: await request.promise }) };
    }
    if (networkGate) await networkGate(method, body, options.signal);
    return { json: async () => ({ ok: true, result: method === 'getFile' ? { file_path: 'fake.txt' } : { message_id: network.length } }) };
  });
  const extension = (await import(`../index.ts?home=${encodeURIComponent(home)}`)).default;
  extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool), sendUserMessage: content => { sent.push(content); onSend(content); } });
  const h = {
    home, sent, network, statuses, errors, emit, aborts: 0,
    // Real Pi wrapper returns void; promise rejection goes to the error listener.
    asyncAdmission(preflight = async () => {}, transform = x => x) {
      onSend = content => {
        void (async () => {
          if (await preflight(content) === 'handled') return;
          await h.start(transform(content));
        })().catch(error => errors.push(error));
      };
    },
    set idle(value) { idle = value; }, set pending(value) { pending = value; }, set onSend(value) { onSend = value; },
    set networkGate(value) { networkGate = value; },
    set beforeStart(value) { beforeStart = value; },
    async receive(text, extra = {}) {
      await until(() => poll);
      const request = poll; poll = undefined;
      const id = ++updateId;
      request.resolve([{ update_id: id, message: { message_id: id, chat: { id: 70, type: 'private' }, from: { id: 7 }, text, ...extra } }]);
      await until(() => poll);
      await immediate(); await immediate();
    },
    async start(content = sent.at(-1)) {
      const prompt = typeof content === 'string' ? content : content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      await emit('before_agent_start', { prompt, systemPrompt: '' });
      await beforeStart(prompt);
      idle = false; await emit('agent_start');
      await emit('message_start', { message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    },
    async end(text = 'answer', reason = 'stop') { await emit('agent_end', { messages: [assistant(text, reason)] }); },
    async settle() { idle = true; await emit('agent_settled'); await immediate(); },
    attach: paths => tools.get('telegram_attach').execute('call', { paths }),
    async shutdown() { await emit('session_shutdown'); },
  };
  t.after(async () => { await h.shutdown(); process.env.HOME = oldHome; await rm(home, { recursive: true, force: true }); });
  await emit('session_start');
  await commands.get('telegram-connect').handler('', ctx);
  await until(() => poll);
  return h;
}

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

test('synchronous submission rejection retains queued content', async t => {
  const h = await harness(t); h.onSend = () => { throw new Error('rejected'); };
  await h.receive('retain me'); assert.match(h.statuses.at(-1), /submission failed/);
  h.onSend = () => {}; await h.settle();
  assert.equal(h.sent.length, 2); assert.deepEqual(h.sent[0], h.sent[1]);
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
