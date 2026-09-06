import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { harness, deferred, until } from './harness.mjs';
import { telegramCommands, parseTelegramCommand, telegramHelp } from '../telegram-commands.ts';
const replies = h => h.network.filter(n => n.method === 'sendMessage').map(n => n.body.text).join('\n');
const text = c => c.filter(p => p.type === 'text').map(p => p.text).join('\n');
const tick = async () => { await immediate(); await immediate(); };

test('registry, scoped menu and help agree; register only at first authorized chat boundary', async t => {
  const h = await harness(t);
  assert.equal(h.network.some(n => n.method === 'setMyCommands'), false);
  await h.receive('/commands'); await h.receive('/help');
  const menus = h.network.filter(n => n.method === 'setMyCommands');
  assert.equal(menus.length, 1);
  assert.deepEqual(menus[0].body.scope, { type: 'chat', chat_id: 70 });
  assert.equal(menus[0].body.language_code, '');
  assert.deepEqual(menus[0].body.commands, telegramCommands.map(({ command, description }) => ({ command, description })));
  assert.ok(menus[0].body.commands.length <= 100);
  for (const c of menus[0].body.commands) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/); assert.ok(c.description.length >= 1 && c.description.length <= 256);
    assert.ok(replies(h).includes('/' + c.command));
  }
  assert.equal(h.sent.length, 0);
});

for (const extra of [{ from: { id: 8 } }, { chat: { id: 80, type: 'group' } }, { from: { id: 7, is_bot: true } }]) {
  test('authorization before parsing/menu ' + JSON.stringify(extra), async t => {
    const h = await harness(t);
    await h.receive('/telegram_reload', extra);
    assert.equal(h.generation, 1); assert.equal(h.submissions.length, 0);
    assert.equal(h.network.some(n => n.method === 'setMyCommands'), false);
  });
}

test('suffixes preserve target checks; unknown commands are honest and never model prompts', async t => {
  const h = await harness(t, { config: { botUsername: 'Own_Bot' } });
  for (const cmd of ['/stop@other_bot', '/made_up', '/model', '/login', '/skill:foo', '/reload', '/telegram-reload']) await h.receive(cmd);
  assert.equal(h.submissions.length, 0); assert.equal((await h.diagnostic()).held, false);
  assert.match(replies(h), /not executed/); assert.match(replies(h), /safe handoff/);
  await h.receive('/STOP@oWn_bOt'); assert.equal((await h.diagnostic()).held, true);
  assert.deepEqual(parseTelegramCommand('/compact@Own_Bot Keep CASE\nAnd text', 'own_bot'), { name: 'compact', args: 'Keep CASE\nAnd text' });
});
test('unknown own username refuses addressed commands', async t => {
  const h = await harness(t); await h.receive('/telegram_reload@Own_Bot');
  assert.equal(h.submissions.length, 0); assert.match(replies(h), /unknown bot/);
});

test('argument validation, compact custom instructions and busy guard', async t => {
  const h = await harness(t);
  for (const c of telegramCommands.filter(c => c.command !== 'compact')) await h.receive('/' + c.command + ' nope');
  assert.equal(h.submissions.length, 0); assert.equal((await h.diagnostic()).held, false);
  assert.match(replies(h), /Usage:/);
  await h.receive('/compact Keep CASE\nAnd Text');
  assert.equal(h.compactions[0].customInstructions, 'Keep CASE\nAnd Text');
  await h.start('local'); await h.receive('/compact Other'); assert.equal(h.compactions.length, 1);
  assert.match(replies(h), /Cannot compact/);
});

test('captions, albums and text with attachments remain normal FIFO input, not control', async t => {
  const h = await harness(t); await h.start('local');
  await h.receive(undefined, { caption: '/stop', document: { file_id: 'file', file_name: 'note.txt' } });
  await h.receive('/telegram_reload', { photo: [{ file_id: 'image' }] });
  await h.receive(undefined, { caption: '/commands', media_group_id: 'a', document: { file_id: 'album', file_name: 'album.txt' } });
  t.mock.timers.tick(1200); await tick();
  assert.equal((await h.diagnostic()).held, false); assert.equal(h.submissions.length, 0);
  await h.end(); await h.settle(); await until(() => h.sent.length === 1);
  assert.match(text(h.sent[0]), /\/stop/); assert.match(text(h.sent[0]), /note.txt/);
  await h.start(); await h.end(); await h.settle(); await until(() => h.sent.length === 2); assert.match(text(h.sent[1]), /telegram_reload/);
  assert.equal(h.sent[1].filter(p => p.type === 'image').length, 1);
  await h.start(); await h.end(); await h.settle(); await until(() => h.sent.length === 3); assert.match(text(h.sent[2]), /album.txt/);
});

test('dynamic catalog filters names and types, bounds output, retains collision names without aliases', async t => {
  const entries = [{ name: 'foo-bar', source: 'extension', sourceInfo: { path: '/SECRET' }, description: '<SECRET>' },
    { name: 'foo_bar', source: 'prompt' }, { name: 'foo-bar:1', source: 'extension' }, { name: 'skill:foo', source: 'skill' },
    { name: '<bad>', source: 'extension' }, { name: 'wrong', source: 'builtin' }, null,
    ...Array.from({ length: 300 }, (_, i) => ({ name: 'name' + i, source: 'prompt' }))];
  const help = telegramHelp(entries);
  assert.match(help, /LOCAL ONLY, not supported remotely/); assert.match(help, /foo-bar:1/); assert.match(help, /foo_bar/);
  assert.match(help, /truncated\/filtered/); assert.ok(help.length < 3500); assert.ok(!help.includes('SECRET')); assert.ok(!help.includes('<bad>'));
  const h = await harness(t, { discovered: entries }); await h.receive('/commands');
  h.discovered = [{ name: 'fresh', source: 'skill' }]; await h.receive('/commands');
  assert.match(replies(h), /fresh/); assert.equal(h.sent.length, 0);
});

test('bridge status samples direct content-free state and controls do not release held history', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('private held'); await h.receive('/stop');
  for (const cmd of ['/bridge_status', '/bridge_status detail', '/status', '/help', '/start', '/commands', '/unknown']) await h.receive(cmd);
  assert.equal(h.sent.length, 0); assert.equal((await h.diagnostic()).held, true);
  assert.match(replies(h), /sampled without a model turn/); assert.match(replies(h), /host-busy|held/);
  assert.ok(!replies(h).includes('private held')); assert.ok(!replies(h).includes('FAKE-OFFLINE')); assert.ok(!replies(h).includes(h.home));
});

for (const mode of ['failure', 'hang', 'shutdown']) test('optional menu ' + mode + ' cannot block input or poison recovery', async t => {
  const h = await harness(t); const gate = deferred(); let signal;
  h.networkGate = async (method, _body, s) => { if (method === 'setMyCommands') { signal = s; if (mode === 'failure') throw new Error('SECRET raw error'); await gate.promise; } };
  await h.receive('normal input'); assert.equal(h.sent.length, 1);
  if (mode === 'shutdown') { await h.replace('reload'); assert.equal(signal.aborted, true); gate.resolve(); await tick(); assert.equal(h.errors.length, 0); return; }
  if (mode === 'hang') { t.mock.timers.tick(2000); await tick(); assert.equal(signal.aborted, true); }
  const d = await h.diagnostic(); assert.equal(d.failedIngress, 0); assert.equal(d.failedPreparations, 0); assert.equal(d.menuState, 'unavailable');
  await h.receive('/commands'); assert.equal(h.network.filter(n => n.method === 'setMyCommands').length, 1);
  assert.ok(!JSON.stringify(h.statuses).includes('SECRET')); gate.resolve();
  await h.start(); await h.end(); await h.settle(); await h.command('telegram-reload'); assert.equal(h.generation, 2);
});

test('safe alias invoked inside polling ingress completes without deadlock or a model turn', async t => {
  const h = await harness(t); await h.receive('/telegram_reload');
  await until(() => h.generation === 2 && h.polling); assert.equal(h.sent.length, 0); assert.equal(h.maxPolls, 1);
  assert.match(replies(h), /Requested/); assert.match(replies(h), /not an admission or reconnection/);
  assert.equal(h.errors.length, 0);
});

test('active alias coalesces and preserves final reply/files before FIFO replacement', async t => {
  const h = await harness(t); await h.receive('current'); await h.start();
  const path = join(h.home, 'out.txt'); await writeFile(path, 'fake'); await h.attach([path]);
  await h.receive('queued file', { document: { file_id: 'file', file_name: 'in.txt' } }); await h.receive('last');
  await h.receive('/telegram_reload'); await h.receive('/telegram_reload');
  assert.equal(h.submissions.filter(s => s.content === '/telegram-reload').length, 1);
  const gate = deferred(); let sending = false;
  h.networkGate = async method => { if (method === 'sendDocument') { sending = true; await gate.promise; } };
  await h.end('final reply'); const settling = h.settle(); await until(() => sending);
  assert.equal(h.generation, 1); assert.equal(h.sent.length, 1); assert.match(replies(h), /final reply/);
  gate.resolve(); await settling; await until(() => h.generation === 2 && h.sent.length === 2);
  assert.match(text(h.sent[1]), /in.txt/); await h.start(); await h.end(); await h.settle(); assert.match(text(h.sent[2]), /last/);
  assert.equal(h.maxPolls, 1); assert.equal(h.errors.length, 0);
});

test('alias while already finalizing waits for outbound barrier', async t => {
  const h = await harness(t); await h.receive('current'); await h.start(); await h.receive('next');
  const gate = deferred(); let sending = false;
  h.networkGate = async (method, body) => { if (method === 'sendMessage' && body.text === 'final') { sending = true; await gate.promise; } };
  await h.end('final'); const settling = h.settle(); await until(() => sending);
  await h.receive('/telegram_reload'); assert.equal(h.generation, 1);
  gate.resolve(); await settling; await until(() => h.generation === 2); assert.equal(h.maxPolls, 1);
});

test('alias preserves stop-held history through replacement', async t => {
  const h = await harness(t); await h.start('local'); await h.receive('held'); await h.receive('stop');
  await h.receive('/telegram_reload'); await h.end(); await h.settle(); await until(() => h.generation === 2 && h.polling);
  assert.equal(h.sent.length, 0); assert.equal((await h.diagnostic()).held, true);
  await h.receive('/commands'); assert.equal(h.sent.length, 0); await h.receive('release'); assert.match(text(h.sent[0]), /held/);
});

for (const source of ['alias', 'tool']) test('synchronous reload submission failure releases pending reservation: ' + source, async t => {
  const h = await harness(t, { commandSubmission: 'throw' });
  if (source === 'alias') await h.receive('/telegram_reload'); else assert.equal((await h.reloadTool()).details.outcome, 'refused');
  assert.equal((await h.diagnostic()).reloadPending, false); assert.equal((await h.diagnostic()).failedIngress, 0);
  await h.receive('after failure'); assert.equal(h.sent.length, 1);
});

test('unknown asynchronous command admission remains requested, held, never claims success', async t => {
  const h = await harness(t, { commandSubmission: 'swallow' }); await h.receive('/telegram_reload'); await h.receive('queued');
  assert.equal((await h.diagnostic()).reloadPending, true); assert.equal(h.sent.length, 0); assert.equal(h.generation, 1);
  assert.match(replies(h), /not an admission/); assert.ok(!/successful|reconnected/.test(replies(h)));
  h.commandSubmission = undefined; await h.command('telegram-reload'); await until(() => h.generation === 2 && h.sent.length === 1);
});

test('hung reload receipt is bounded and does not prevent explicit handoff', async t => {
  const h = await harness(t); const gate = deferred(); let entered = false;
  h.networkGate = async method => { if (method === 'sendMessage') { entered = true; await gate.promise; } };
  const receiving = h.receive('/telegram_reload'); await until(() => entered); t.mock.timers.tick(2000);
  await receiving; await until(() => h.generation === 2); gate.resolve(); assert.equal(h.errors.length, 0);
});

test('reload reservation holds FIFO even while receipt hangs and current run settles', async t => {
  const h = await harness(t); await h.receive('current'); await h.start(); await h.receive('queued');
  const gate = deferred(); let entered = false;
  h.networkGate = async (method, body) => { if (method === 'sendMessage' && body.text.startsWith('Requested')) { entered = true; await gate.promise; } };
  const receiving = h.receive('/telegram_reload'); await until(() => entered);
  await h.end('final'); await h.settle(); await tick();
  assert.equal(h.sent.length, 1); assert.equal((await h.diagnostic()).reloadPending, true);
  t.mock.timers.tick(2000); await receiving; await until(() => h.generation === 2 && h.sent.length === 2);
  gate.resolve(); assert.equal(h.maxPolls, 1);
});

for (const field of ['business_connection_id', 'guest_query_id']) test('alternate chat context does not target ordinary private menu: ' + field, async t => {
  const h = await harness(t); await h.receive('/telegram_reload', { [field]: 'alternate' });
  assert.equal(h.submissions.length, 0); assert.equal(h.network.some(n => n.method === 'setMyCommands'), false);
});

test('menu attempt is cancelled on disconnect and renewed only after authorized reconnect input', async t => {
  const h = await harness(t); const gate = deferred(); let signal;
  h.networkGate = async (method, _body, s) => { if (method === 'setMyCommands') { signal = s; await gate.promise; } };
  await h.receive('/help'); await h.command('telegram-disconnect'); assert.equal(signal.aborted, true);
  await h.command('telegram-connect'); await until(() => h.polling);
  assert.equal(h.network.filter(n => n.method === 'setMyCommands').length, 1);
  gate.resolve(); await h.receive('/commands'); assert.equal(h.network.filter(n => n.method === 'setMyCommands').length, 2);
});

test('stale configured A identity never controls verified B token', async t => {
  const h = await harness(t, { config: { botUsername: 'A_Bot' }, identity: 'B_Bot' });
  await h.receive('/stop@A_Bot'); assert.equal((await h.diagnostic()).held, false);
  await h.receive('/stop@b_BoT'); assert.equal((await h.diagnostic()).held, true);
});

test('explicit disconnect cancels delayed remote reservation', async t => {
  const h = await harness(t); const gate = deferred(); let entered = false;
  h.networkGate = async (method, body) => { if (method === 'sendMessage' && body.text.startsWith('Requested')) { entered = true; await gate.promise; } };
  h.push('/telegram_reload'); await until(() => entered);
  const disconnecting = h.command('telegram-disconnect'); gate.resolve(); await disconnecting; await tick();
  assert.equal(h.submissions.length, 0); assert.equal(h.generation, 1); assert.equal(h.polling, false);
  assert.equal((await h.diagnostic()).reloadPending, false);
});

test('foreign reload catalog refuses submission rather than prompt fallthrough', async t => {
  const h = await harness(t, { reloadCatalog: [{ name: 'telegram-reload:1', source: 'extension', sourceInfo: { path: '/foreign' } }] });
  await h.receive('/telegram_reload'); assert.equal(h.submissions.length, 0); assert.equal(h.sent.length, 0);
  assert.match(replies(h), /refused/i);
});

for (const mode of ['failure', 'timeout', 'shutdown', 'reconnect']) test('bounded identity ' + mode + ' cannot block bare controls or install stale result', async t => {
  const h = await harness(t, { connected: false, identity: 'Own_Bot' }); const gate = deferred(); let signal;
  h.networkGate = async (method, _body, s) => { if (method === 'getMe') { signal = s; if (mode === 'failure') throw new Error('SECRET'); await gate.promise; } };
  await h.command('telegram-connect'); await h.receive('/help'); await h.receive('/stop@Own_Bot');
  assert.equal((await h.diagnostic()).held, false);
  if (mode === 'shutdown') { await h.shutdown(); gate.resolve(); await tick(); assert.equal(signal.aborted, true); return; }
  if (mode === 'reconnect') { await h.command('telegram-disconnect'); assert.equal(signal.aborted, true); await h.command('telegram-connect'); }
  t.mock.timers.tick(2000); await tick(); gate.resolve(); await tick();
  await h.receive('/stop@Own_Bot'); assert.equal((await h.diagnostic()).held, false);
  await h.receive('/stop'); assert.equal((await h.diagnostic()).held, true);
  assert.ok(!JSON.stringify(h.statuses).includes('SECRET'));
});

for (const callback of ['onComplete', 'onError']) test('compact ' + callback + ' sanitized and inert after shutdown', async t => {
  const h = await harness(t); await h.receive('/compact');
  h.compactions[0][callback](new Error('SECRET')); await tick();
  assert.match(replies(h), callback === 'onComplete' ? /completed/ : /failed; inspect Pi locally/);
  assert.ok(!replies(h).includes('SECRET'));
  await h.shutdown(); const count = h.network.length;
  h.compactions[0][callback](new Error('SECRET')); await tick(); assert.equal(h.network.length, count);
});

test('throwing catalog preserves help and refuses both schedulers', async t => {
  const h = await harness(t, { catalogThrows: true }); await h.receive('/help'); await h.receive('/telegram_reload');
  assert.equal((await h.reloadTool()).details.outcome, 'refused'); assert.equal(h.submissions.length, 0); assert.ok(!replies(h).includes('SECRET'));
});

test('tool outcomes distinguish pending and closed from submission', async t => {
  const h = await harness(t, { commandSubmission: 'swallow' });
  assert.equal((await h.reloadTool()).details.outcome, 'requested');
  assert.equal((await h.reloadTool()).details.outcome, 'coalesced');
  await h.shutdown(); assert.equal((await h.reloadTool()).details.outcome, 'refused');
});

test('disconnect during reload idle await cancels before checkpoint', async t => {
  const h = await harness(t); await h.start('local'); const reload = h.command('telegram-reload');
  await h.command('telegram-disconnect'); await h.end(); await h.settle(); await reload;
  assert.equal(h.generation, 1); assert.equal(h.polling, false); assert.equal((await h.diagnostic()).reloadPending, false);
});

test('disconnect after connected snapshot during persisted-file await cancels handoff', async t => {
  const h = await harness(t); let disconnecting;
  h.sessionFileRead = () => { queueMicrotask(() => { disconnecting = h.command('telegram-disconnect'); }); };
  await h.command('telegram-reload'); await disconnecting;
  assert.equal(h.generation, 1); assert.equal(h.polling, false); assert.equal(h.entries.length, 0);
  assert.equal((await h.diagnostic()).reloadPending, false);
});

test('catalog can change during receipt: cancel only own reservation and preserve stop hold', async t => {
  const h = await harness(t); await h.receive('/stop'); const gate = deferred(); let entered = false;
  h.networkGate = async (method, body) => { if (method === 'sendMessage' && body.text.startsWith('Requested')) { entered = true; await gate.promise; } };
  const receiving = h.receive('/telegram_reload'); await until(() => entered);
  h.discovered = [{ name: 'telegram-reload', source: 'extension', sourceInfo: { path: '/foreign' } }];
  gate.resolve(); await receiving;
  assert.equal(h.submissions.length, 0); assert.equal((await h.diagnostic()).reloadPending, false); assert.equal((await h.diagnostic()).held, true);
});

for (const control of ['/telegram_reload', '/stop', '/compact']) test('cursor accepted before disconnect does not admit stale control ' + control, async t => {
  const h = await harness(t); const gate = deferred(); let entered = false;
  h.configWrite = async () => { entered = true; await gate.promise; };
  h.push(control); await until(() => entered);
  const disconnecting = h.command('telegram-disconnect'); gate.resolve(); await disconnecting; await tick();
  assert.equal(h.submissions.length, 0); assert.equal(h.entries.length, 0);
  assert.equal(h.generation, 1); assert.equal(h.polling, false);
  assert.equal(h.compactions.length, 0); assert.equal((await h.diagnostic()).held, false);
  assert.equal(h.network.filter(n => n.method === 'setMyCommands').length, 0);
  assert.equal(JSON.parse(await readFile(join(h.home, '.pi/agent/telegram.json'), 'utf8')).lastUpdateId, 1);
});

for (const boundary of ['pairing-write', 'pairing-reply']) test('origin intent survives ' + boundary, async t => {
  const h = await harness(t, { config: { allowedUserId: undefined } });
  const gate = deferred(); let entered = false, writes = 0;
  h.configWrite = async () => { if (++writes === 2 && boundary === 'pairing-write') { entered = true; await gate.promise; } };
  h.networkGate = async (method, body) => {
    if (boundary === 'pairing-reply' && method === 'sendMessage' && body.text.includes('paired')) { entered = true; await gate.promise; }
  };
  h.push('/telegram_reload'); await until(() => entered);
  const disconnecting = h.command('telegram-disconnect'); gate.resolve(); await disconnecting; await tick();
  assert.equal(h.submissions.length, 0); assert.equal(h.entries.length, 0); assert.equal(h.polling, false);
  assert.equal(h.network.filter(n => n.method === 'setMyCommands').length, 0);
});

for (const stop of ['/stop', '/stop@Own_Bot']) test('accepted ' + stop + ' after internal handoff poll abort still preserves queued history', async t => {
  const h = await harness(t, { identity: 'Own_Bot' }); await h.start('local'); await h.receive('held'); await h.end();
  // Keep host busy until ingress has accepted the stop, then let handoff quiesce.
  const gate = deferred(); let entered = false;
  h.configWrite = async () => { entered = true; await gate.promise; };
  h.push(stop); await until(() => entered); h.idle = true;
  const reload = h.command('telegram-reload');
  await until(() => h.pollAborted);
  gate.resolve(); await reload; await until(() => h.polling);
  assert.equal(h.generation, 2); assert.equal(h.sent.length, 0);
  assert.equal((await h.diagnostic()).held, true);
  assert.equal(h.entries.find(e => e.data?.cursor === 2)?.data.held, true);
  assert.equal(h.maxPolls, 1);
});

test('same-instance reconnect after quiesced handoff failure requires fresh identity verification', async t => {
  const h = await harness(t, { identity: 'Own_Bot' });
  h.appendHook = () => { throw new Error('synthetic append failure'); };
  await h.command('telegram-reload');
  assert.equal(h.generation, 1); assert.equal(h.polling, false);
  h.appendHook = () => {};
  const identity = deferred(); let entered = false;
  h.networkGate = async method => { if (method === 'getMe') { entered = true; await identity.promise; } };
  await h.command('telegram-connect'); await until(() => entered);
  await h.receive('/stop@Own_Bot'); assert.equal((await h.diagnostic()).held, false);
  identity.resolve(); await tick();
  await h.receive('/stop@Own_Bot'); assert.equal((await h.diagnostic()).held, true);
  assert.equal(h.maxPolls, 1);
});

test('accepted text and queued file prepare while disconnected; awaited reconnect wakes FIFO once', async t => {
  const h = await harness(t); await h.receive('current'); await h.start();
  const download = deferred(); let downloading = false;
  h.networkGate = async method => { if (method === 'download') { downloading = true; await download.promise; } };
  await h.receive('file first', { document: { file_id: 'file', file_name: 'held.txt' } }); await until(() => downloading);
  const cursor = deferred(); let entered = false;
  h.configWrite = async () => { entered = true; await cursor.promise; };
  h.push('text second'); await until(() => entered);
  const disconnecting = h.command('telegram-disconnect'); cursor.resolve(); await disconnecting;
  download.resolve();
  for (let i = 0; i < 10000 && (await h.diagnostic()).preparationCount; i++) await tick();
  assert.equal((await h.diagnostic()).preparationCount, 0);
  await h.end('current reply'); await h.settle(); await h.settle(); await tick();
  assert.match(replies(h), /current reply/); assert.equal(h.sent.length, 1);
  assert.equal((await h.diagnostic()).queued, 2);
  assert.equal(JSON.parse(await readFile(join(h.home, '.pi/agent/telegram.json'), 'utf8')).lastUpdateId, 3);
  await h.command('telegram-connect'); await until(() => h.sent.length === 2);
  assert.match(text(h.sent[1]), /held.txt/); await h.settle(); await tick(); assert.equal(h.sent.length, 2);
  await h.start(); await h.end(); await h.settle(); await until(() => h.sent.length === 3);
  assert.match(text(h.sent[2]), /text second/); await h.settle(); assert.equal(h.sent.length, 3); assert.equal(h.maxPolls, 1);
});

for (const hold of ['stop', 'uncertain-admission']) test('same-instance reconnect preserves ' + hold, async t => {
  const h = await harness(t);
  if (hold === 'stop') await h.start('local');
  await h.receive('retained');
  if (hold === 'stop') await h.receive('/stop');
  await h.command('telegram-disconnect'); await h.end(); await h.settle();
  const sent = h.sent.length;
  await h.command('telegram-connect'); await h.settle(); await tick();
  assert.equal(h.sent.length, sent);
  if (hold === 'stop') assert.equal((await h.diagnostic()).held, true);
});

test('album accepted at cursor suspension remains prepared under disconnect hold', async t => {
  const h = await harness(t); const gate = deferred(); let entered = false;
  h.configWrite = async () => { entered = true; await gate.promise; };
  h.push(undefined, { caption: '/stop', media_group_id: 'a', document: { file_id: 'album', file_name: 'album.txt' } });
  await until(() => entered); const disconnecting = h.command('telegram-disconnect'); gate.resolve(); await disconnecting;
  t.mock.timers.tick(1200);
  for (let i = 0; i < 10000 && (await h.diagnostic()).preparationCount; i++) await tick();
  assert.equal((await h.diagnostic()).queued, 1); assert.equal(h.sent.length, 0);
  assert.equal((await h.diagnostic()).held, false);
  await h.settle(); assert.equal(h.sent.length, 0);
  await h.command('telegram-connect'); await until(() => h.sent.length === 1);
  assert.match(text(h.sent[0]), /album.txt/); assert.match(text(h.sent[0]), /\/stop/);
});
