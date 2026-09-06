import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';

export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export async function until(check) {
  for (let i = 0; i < 10000; i++) { if (check()) return; await immediate(); }
  assert.fail('fake lifecycle did not reach expected boundary');
}
export const assistant = (text = 'answer', stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason, errorMessage: 'model failed' });

export async function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const home = await mkdtemp(join(tmpdir(), 'pi-telegram-test-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  await mkdir(join(home, '.pi/agent'), { recursive: true });
  await writeFile(join(home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: 'FAKE-OFFLINE', allowedUserId: 7, lastUpdateId: 0, ...options.config }));
  let configWrite = async () => {}, pollSignal;
  const originalWriteFile = fsPromises.writeFile;
  const writeMock = t.mock.method(fsPromises, 'writeFile', async (path, ...args) => {
    if (path === join(home, '.pi/agent/telegram.json')) await configWrite(JSON.parse(args[0]));
    return originalWriteFile(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { writeMock.mock.restore(); syncBuiltinESMExports(); });
  let handlers, commands, tools, ctx, invalidate, flagValues, registrations, factoryTools, factoryFlag;
  let restoredFlags;
  const compactions = [];
  const identityUsername = options.identity ?? options.config?.botUsername;
  let discovered = options.discovered ?? [], commandSubmission = options.commandSubmission;
  const sent = [], network = [], statuses = [], errors = [], notices = [], entries = [], submissions = [], lifecycle = [], serverUpdates = [];
  let generation = 0, activePolls = 0, maxPolls = 0, idleWaiter = deferred(), reloadHook = async () => {}, appendHook = () => {};
  let sessionId = 'fake-session', sessionFile = join(home, 'session.jsonl');
  // Real Pi may name a fresh session before it has ever flushed a JSONL file.
  if (options.persisted !== false) await writeFile(sessionFile, JSON.stringify({ type: 'session', id: sessionId }) + '\n');
  let reloadMode = 'normal', sessionFileRead = () => {};
  let idle = true, compacting = false, pending = false, poll, updateId = 0, onSend = () => {}, networkGate, beforeStart = async () => {};
  const emit = async (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  async function instantiate(omitExtension = false) {
    handlers = new Map(); commands = new Map(); tools = new Map();
    flagValues = new Map(); registrations = []; factoryTools = [];
    let valid = true;
    const check = () => assert.ok(valid, 'stale host API used');
    invalidate = () => { valid = false; };
    const ownCtx = ctx = {
      getContextUsage: () => { check(); return undefined; },
      compact: opts => { check(); compactions.push(opts); },
      isIdle: () => { check(); return idle && !compacting; }, hasPendingMessages: () => { check(); return pending; },
      abort: () => { check(); h.aborts++; },
      waitForIdle: async () => { check(); if (!idle || compacting) await idleWaiter.promise; },
      sessionManager: { getEntries: () => { check(); return entries; }, getSessionId: () => { check(); return sessionId; },
        getSessionFile: () => { check(); sessionFileRead(); return sessionFile; } },
      ui: { theme: { fg: (_color, text) => { check(); return text; } }, setStatus: (_key, text) => { check(); statuses.push(text); },
        notify: (text, level) => { check(); notices.push({ text, level }); } },
      reload: async () => {
        check();
        try {
          await reloadHook('before');
          await emit('session_shutdown', { reason: 'reload' }); lifecycle.push('shutdown'); invalidate();
          await reloadHook('after');
          restoredFlags = new Map(flagValues);
          await instantiate(reloadMode === 'omit-extension'); lifecycle.push('instantiate');
          await emit('session_start', { reason: 'reload' }); lifecycle.push('start');
        } catch (error) {
          // Pi's interactive reload reports many failures locally, then resolves.
          if (reloadMode !== 'swallow-error') throw error;
          errors.push(error);
        }
      },
    };
    generation++;
    if (omitExtension) {
      // _buildRuntime restores runtime flags even if imports omitted this extension.
      for (const [name, value] of restoredFlags ?? []) flagValues.set(name, value);
      return;
    }
    const ownCommands = commands;
    const extension = (await import(`../index.ts?home=${encodeURIComponent(home)}&instance=${generation}`)).default;
    extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command),
      registerFlag: (name, options) => { if (!flagValues.has(name)) flagValues.set(name, options.default); },
      getCommands: () => { check(); if (options.catalogThrows) throw new Error('SECRET'); return [...(options.reloadCatalog ?? [{ name: 'telegram-reload', source: 'extension', sourceInfo: { path: new URL('../index.ts', import.meta.url).pathname } }]), ...discovered]; },
      getFlag: name => { check(); return flagValues.get(name); },
      registerTool: tool => { check(); registrations.push(tool.name); tools.set(tool.name, tool); },
      appendEntry: (customType, data) => {
        check(); appendHook(customType);
        const entry = { type: 'custom', customType, data: structuredClone(data) };
        entries.push(entry);
        if (options.persisted !== false) appendFileSync(sessionFile, JSON.stringify(entry) + '\n');
      },
      sendUserMessage: (content, opts) => {
        check(); submissions.push({ content, opts });
        // Faithful Pi: command dispatch is BEFORE streaming checks, and the API
        // catches async errors and returns void, never command completion.
        if (opts?.expandPromptTemplates && typeof content === 'string' && content.startsWith('/')) {
          if (commandSubmission === 'throw') throw new Error('fake synchronous submission failure');
          if (commandSubmission === 'swallow') return;
          const command = options.reloadCatalog ? undefined : ownCommands.get(content.slice(1));
          if (command) { void command.handler('', ownCtx).catch(error => errors.push(error)); return; }
        }
        sent.push(content); onSend(content);
      },
    });
    factoryTools.push(...tools.keys());
    factoryFlag = flagValues.get('telegram-diagnostics');
    // Host factories see defaults; CLI overrides/restored flags precede startup.
    if (restoredFlags) for (const [name, value] of restoredFlags) flagValues.set(name, value);
    else flagValues.set('telegram-diagnostics', options.diagnosticsEnabled ?? true);
  }
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
    if (method === 'getUpdates' && body.timeout === 0) {
      activePolls++; maxPolls = Math.max(maxPolls, activePolls);
      try { if (networkGate) await networkGate(method, body, options.signal); }
      catch (error) { activePolls--; throw error; }
      return { json: async () => { activePolls--; return { ok: true, result: serverUpdates.filter(u => u.update_id >= (body.offset ?? 0)).slice(0, body.limit) }; } };
    }
    if (method === 'getUpdates') {
      pollSignal = options.signal;
      activePolls++; maxPolls = Math.max(maxPolls, activePolls);
      const request = deferred(); poll = request;
      const available = serverUpdates.filter(u => u.update_id >= (body.offset ?? 0)).slice(0, body.limit);
      if (available.length) request.resolve(available);
      options.signal.addEventListener('abort', () => request.reject(new DOMException('aborted', 'AbortError')), { once: true });
      return { json: async () => { try { return { ok: true, result: await request.promise }; } finally { activePolls--; if (poll === request) poll = undefined; } } };
    }
    if (networkGate) await networkGate(method, body, options.signal);
    return { json: async () => ({ ok: true, result: method === 'getMe' ? { username: identityUsername } : method === 'getFile' ? { file_path: 'fake.txt' } : { message_id: network.length } }) };
  });
  const h = {
    home, sent, network, compactions, statuses, errors, notices, entries, submissions, lifecycle, emit, aborts: 0,
    set configWrite(value) { configWrite = value; },
    set discovered(value) { discovered = value; }, set commandSubmission(value) { commandSubmission = value; },
    get handlers() { return handlers; },
    get factoryFlag() { return factoryFlag; }, get factoryTools() { return factoryTools; },
    get registrations() { return registrations; }, get tools() { return tools; }, get ctx() { return ctx; },
    diagnostic: async () => (await tools.get('telegram_diagnostics').execute('diag', {}, undefined, undefined, ctx)).details,
    status: async (args = '') => { await commands.get('telegram-status').handler(args, ctx); return notices.at(-1).text; },
    serverMessage(text, extra = {}) {
      const id = ++updateId;
      serverUpdates.push({ update_id: id, message: { message_id: id, chat: { id: 70, type: 'private' }, from: { id: 7 }, text, ...extra } });
    },
    push(text, extra = {}) { const request = poll; poll = undefined; const id = ++updateId; request.resolve([{ update_id: id, message: { message_id: id, chat: { id: 70, type: "private" }, from: { id: 7 }, text, ...extra } }]); },
    get pollAborted() { return pollSignal?.aborted; },
    get generation() { return generation; }, get maxPolls() { return maxPolls; }, get polling() { return !!poll; },
    set reloadHook(value) { reloadHook = value; }, set appendHook(value) { appendHook = value; },
    set reloadMode(value) { reloadMode = value; },
    set sessionFileRead(value) { sessionFileRead = value; },
    set sessionId(value) { sessionId = value; }, set sessionFile(value) { sessionFile = value; },
    command: (name, args = '') => commands.get(name).handler(args, ctx),
    reloadTool: () => tools.get('telegram_reload').execute('call', {}, undefined, undefined, ctx),
    async replace(reason) {
      await emit('session_shutdown', { reason }); invalidate(); restoredFlags = new Map(flagValues); await instantiate(); await emit('session_start', { reason });
    },
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
      assert.equal(compacting, false, 'Pi rejects fresh prompts during compaction before before_agent_start');
      const prompt = typeof content === 'string' ? content : content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      await emit('before_agent_start', { prompt, systemPrompt: '' });
      await beforeStart(prompt);
      idle = false; await emit('agent_start');
      await emit('message_start', { message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    },
    async end(text = 'answer', reason = 'stop') { await emit('agent_end', { messages: [assistant(text, reason)] }); },
    // Host clears runActive before awaited settled observers run.
    async settle(earlierListener = async () => {}) {
      idle = true; await earlierListener(); await emit('agent_settled');
      if (!compacting) { idleWaiter.resolve(); idleWaiter = deferred(); }
      await immediate();
    },
    async beginManualCompaction() {
      assert.equal(ctx.isIdle(), true);
      compacting = true;
      await emit('session_before_compact', { reason: 'manual', willRetry: false });
    },
    async completeManualCompaction(laterListener = async () => {}, afterCleanup = async () => {}) {
      await emit('session_compact', { reason: 'manual', willRetry: false });
      await laterListener(); // success cleanup follows all awaited hooks
      compacting = false;
      await afterCleanup(); // queued input may start before the deferred drain
      idleWaiter.resolve(); idleWaiter = deferred();
      await immediate();
    },
    async failManualCompaction() {
      compacting = false;
      await emit('session_compact_failed', { reason: 'manual', willRetry: false, aborted: true });
      idleWaiter.resolve(); idleWaiter = deferred();
      await immediate();
    },
    set compacting(value) { compacting = value; },
    attach: paths => tools.get('telegram_attach').execute('call', { paths }),
    async shutdown() { await emit('session_shutdown'); },
  };
  t.after(async () => { await h.shutdown(); process.env.HOME = oldHome; await rm(home, { recursive: true, force: true }); });
  await instantiate();
  await emit('session_start', { reason: options.sessionReason ?? 'startup' });
  if (options.connected !== false) {
    await commands.get('telegram-connect').handler('', ctx);
    await until(() => poll);
  }
  return h;
}

