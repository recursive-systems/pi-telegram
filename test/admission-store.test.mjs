// Pure fs-only tests. Every write is confined to fresh mkdtemp roots. No extension
// factories, existing fixtures, live state, credentials, config or operational APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import crypto from 'node:crypto';

const resolverPrototypes = [dns.Resolver.prototype, dnsPromises.Resolver.prototype];
  const socketPrototype = dgram.Socket.prototype;
  const forbidden = function () { throw new Error('Offline admission-store tripwire'); };
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) childProcess[name] = forbidden;
childProcess.ChildProcess.prototype.spawn = forbidden;
for (const mod of [net, tls]) for (const name of ['connect', 'createConnection', 'createServer']) if (name in mod) mod[name] = forbidden;
net.Socket.prototype.connect = forbidden;
net.Server.prototype.listen = forbidden;
dgram.createSocket = forbidden;
for (const mod of [http, https]) for (const name of ['request', 'get', 'createServer']) mod[name] = forbidden;
for (const name of ['connect', 'createServer', 'createSecureServer']) http2[name] = forbidden;
for (const mod of [dns, dnsPromises]) for (const name of Object.keys(mod)) if (/^(lookup|resolve|reverse)/.test(name) && typeof mod[name] === 'function') mod[name] = forbidden;
for (const mod of [dns, dnsPromises]) {
    for (const name of Object.getOwnPropertyNames(mod.Resolver.prototype))
      if (/^(resolve|reverse|setServers|cancel)/.test(name)) mod.Resolver.prototype[name] = forbidden;
    mod.Resolver = forbidden;
  }
  for (const name of ['bind', 'connect', 'send', 'addMembership', 'addSourceSpecificMembership']) dgram.Socket.prototype[name] = forbidden;
  dgram.Socket = forbidden;
  globalThis.fetch = forbidden;
globalThis.WebSocket = forbidden;
syncBuiltinESMExports();
const { AdmissionStore, AdmissionStoreError, ADMISSION_LIMITS } = await import('../admission-store.ts');
const scope = 'a'.repeat(64);
const other = 'b'.repeat(64);
const canon = x => Array.isArray(x) ? `[${x.map(canon).join(',')}]` : x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}` : JSON.stringify(x);
const input = (updateId = 1, extra = {}) => ({ sessionId: 'session', epoch: 'epoch', updateId, chatId: -100, userId: 2, messageId: 3, receivedAt: 1000, text: 'ordinary request', caption: 'caption', media: [{ retention: 'telegram-reference-only', type: 'document', fileId: 'opaque-file', name: 'sample.txt', mime: 'text/plain' }], ...extra });
const resolution = { at: 2000, note: 'Local manual disposition only' };
const isError = code => e => e instanceof AdmissionStoreError && (!code || e.code === code) && !e.message.includes('ordinary request');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'admission-unit-'));
  fs.chmodSync(root, 0o700);
  const stores = [];
  const open = (s = scope, options = {}) => { const store = AdmissionStore.open(root, s, options); stores.push(store); return store; };
  t.after(() => { stores.forEach(s => s.close()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, open, dir: path.join(root, scope), file: path.join(root, scope, 'snapshot.json') };
}
function patch(t, key, replacement) {
  const original = fs[key]; fs[key] = replacement(original); syncBuiltinESMExports();
  let restored = false;
  const restore = () => { if (!restored) { restored = true; fs[key] = original; syncBuiltinESMExports(); } };
  t.after(restore); return restore;
}

test('offline tripwires installed', () => {
  assert.throws(() => childProcess.spawn('never'), /tripwire/);
  assert.throws(() => net.connect(1), /tripwire/);
  assert.throws(() => fetch('https://invalid.invalid'), /tripwire/);
});
test('roundtrip, canonical encoding, private modes, cloned DTOs and scope isolation', t => {
  const f = fixture(t); let s = f.open();
  const i = input(); s.admit(i); i.text = 'mutated';
  const view = s.inspect(); view.records[0].input.text = 'also mutated';
  assert.equal(s.inspect().records[0].input.text, 'ordinary request');
  assert.equal(fs.statSync(f.root).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(f.dir).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(f.file).mode & 0o7777, 0o600);
  assert.equal(fs.readFileSync(f.file, 'utf8'), canon(s.inspect()));
  const before = s.inspect(); s.close(); s = f.open(); assert.deepEqual(s.inspect(), before);
  assert.equal(f.open(other).inspect().records.length, 0);
  assert.throws(() => f.open(), isError('already-open'));
  s.close(); assert.throws(() => s.admit(input(2)), isError('closed'));
});
test('duplicate identity is exact, mismatch rejected and compact tombstones retain digest', t => {
  const f = fixture(t), s = f.open(); s.admit(input());
  const generation = s.inspect().generation;
  assert.equal(s.admit(input()).admitted, false);
  assert.equal(s.inspect().generation, generation);
  for (const extra of [{ text: 'different' }, { epoch: 'different' }, { receivedAt: 1001 }, { chatId: -101 }]) {
    assert.throws(() => s.admit(input(1, extra)), isError('duplicate-mismatch'));
  }
  s.acknowledge(1, resolution); s.prune(1);
  assert.equal(s.inspect().records[0].input, null);
  assert.equal(s.admit(input()).admitted, false);
  assert.throws(() => s.admit(input(1, { caption: 'different' })), isError('duplicate-mismatch'));
});
test('grouped transitions, history marker, atomic stop generation, no authority inferred', t => {
  const f = fixture(t), s = f.open(); s.admit(input(1)); s.admit(input(2));
  s.transition([1, 2].map(updateId => ({ updateId, phase: 'queued', turnMarker: 'album-turn' })));
  assert.deepEqual(s.inspect().records.map(r => r.turnMarker), ['album-turn', 'album-turn']);
  const before = s.inspect();
  assert.throws(() => s.transition([{ updateId: 1, phase: 'active' }, { updateId: 99, phase: 'active' }]), isError('unknown-record'));
  assert.deepEqual(s.inspect(), before);
  assert.throws(() => s.stop([1, 99]), isError('unknown-record'));
  assert.deepEqual(s.inspect(), before);
  s.stop([1, 2]); assert.equal(s.inspect().generation, before.generation + 1);
  assert.equal(s.inspect().stopLatched, true);
  assert.deepEqual(s.inspect().records.map(r => r.phase), ['held', 'held']);
  s.close(); const reopened = f.open(); assert.equal(reopened.inspect().stopLatched, true);
  reopened.clearStopLatch(); assert.deepEqual(reopened.inspect().records.map(r => r.phase), ['held', 'held']);
  for (const phase of ['uncertain', 'dispatching', 'active']) reopened.transition([{ updateId: 1, phase }]);
  assert.throws(() => reopened.transition([{ updateId: 1, phase: 'handled' }]), isError());
  reopened.transition([{ updateId: 1, phase: 'handled', disposition: resolution }]);
  assert.throws(() => reopened.transition([{ updateId: 1, phase: 'queued' }]), isError('terminal-record'));
  assert.throws(() => reopened.transition([{ updateId: 2, phase: 'queued' }, { updateId: 2, phase: 'held' }]), isError('duplicate-transition'));
});
test('cursor-gated terminal pruning never removes unresolved; default recent window', t => {
  const f = fixture(t), s = f.open();
  for (let id = 0; id < 40; id++) s.admit(input(id));
  s.transition(Array.from({ length: 38 }, (_, updateId) => ({ updateId, phase: 'acknowledged', disposition: resolution })));
  assert.deepEqual(s.prune(34), { removed: 3, compacted: 32 });
  const records = s.inspect().records;
  assert.equal(records[0].updateId, 3);
  assert.equal(records.find(r => r.updateId === 35).input.text, 'ordinary request');
  assert.deepEqual(s.prune(39, 1), { removed: 34, compacted: 1 });
  assert.deepEqual(s.inspect().records.map(r => r.updateId), [37, 38, 39]);
  assert.throws(() => s.prune(39, 0), isError());
  assert.deepEqual(s.prune(39), { removed: 0, compacted: 0 });
});
test('record quota blocks, never evicts, frees only through explicit terminal prune', t => {
  const f = fixture(t), s = f.open();
  for (let id = 0; id < ADMISSION_LIMITS.records; id++) s.admit(input(id, { text: '', caption: '', media: [] }));
  assert.throws(() => s.admit(input(256)), isError('record-quota'));
  assert.equal(s.admit(input(0, { text: '', caption: '', media: [] })).admitted, false);
  assert.equal(s.prune(1000, 1).removed, 0);
  s.acknowledge(0, resolution); s.acknowledge(1, resolution); s.prune(1, 1); s.admit(input(256));
  assert.equal(s.inspect().records.length, 256);
});
test('snapshot quota blocks without poisoning or dropping obligations', t => {
  const f = fixture(t), s = f.open();
  let admitted = 0;
  while (true) {
    try { s.admit(input(admitted, { text: 'x'.repeat(65536), caption: 'y'.repeat(65536) })); admitted++; }
    catch (e) { assert.ok(isError('snapshot-quota')(e)); break; }
    assert.ok(admitted < 256);
  }
  assert.ok(admitted > 1); assert.equal(s.needsReopen, false);
  assert.equal(s.inspect().records.length, admitted);
  assert.ok(fs.statSync(f.file).size <= ADMISSION_LIMITS.snapshotBytes);
  s.transition(s.inspect().records.map(r => ({ updateId: r.updateId, phase: 'handled', turnMarker: '\u0001'.repeat(256), disposition: { at: 1, note: '\u0001'.repeat(1024) } })));
  assert.ok(s.inspect().records.every(r => r.phase === 'handled'));
});
test('strict input, bounds, unsafe numbers, unknown fields, UTF and descriptors', t => {
  const f = fixture(t), s = f.open();
  for (const extra of [
    { token: 'not-accepted' }, { rawUpdate: {} }, { updateId: Number.MAX_SAFE_INTEGER + 1 },
    { updateId: -0 }, { userId: 0 }, { chatId: NaN }, { receivedAt: Infinity },
    { sessionId: '' }, { epoch: 'x'.repeat(129) }, { text: 'x'.repeat(65537) },
    { text: '\ud800' }, { caption: '\udc00' }, { text: '\0' }, { text: 'é'.repeat(32769) },
    { media: new Array(1) }, { media: Array(17).fill(input().media[0]) },
    { media: [{ ...input().media[0], name: '../unsafe' }] },
    { media: [{ ...input().media[0], name: 'bad\nname' }] },
    { media: [{ ...input().media[0], mime: 'text/plain;secret' }] },
    { media: [{ ...input().media[0], bytes: 'not-durable' }] },
    { media: [{ ...input().media[0], retention: 'durable' }] },
    { media: [{ ...input().media[0], fileId: 'f'.repeat(1025) }] },
    { media: [{ ...input().media[0], fileId: 'bad\nreference' }] },
    { media: [{ ...input().media[0], name: 'n'.repeat(256) }] },
    { media: [{ ...input().media[0], mime: 'text/' + 'm'.repeat(123) }] },
  ]) assert.throws(() => s.admit(input(1, extra)), isError());
  const accessor = input(); Object.defineProperty(accessor, 'text', { get() { throw new Error('must not execute'); }, enumerable: true });
  assert.throws(() => s.admit(accessor), isError());
  s.admit(input(1, { text: 'emoji 🐈', caption: 'é'.repeat(32768) }));
  assert.throws(() => s.acknowledge(1, { at: 1, note: 'n'.repeat(1025) }), isError());
  assert.throws(() => s.transition([{ updateId: 1, phase: 'queued', turnMarker: 'm'.repeat(257) }]), isError());
  assert.throws(() => s.prune(NaN), isError());
});
test('corrupt, duplicate-key, noncanonical, unknown schema, nonfinite and invalid UTF snapshots fail closed', t => {
  const f = fixture(t), s = f.open(); s.admit(input()); s.close();
  const valid = fs.readFileSync(f.file);
  const data = JSON.parse(valid);
  const variants = [
    '', '{', valid.toString() + '\n', '{"generation":0,"generation":0}',
    valid.toString().replace('"generation":1', '"generation":1,"generation":1'),
    valid.toString().replace('"generation":1', '"generation":1e999'),
    valid.toString().replace('"generation":1', '"generation":1.0'),
    valid.toString().replace('"generation":1', '"generation":9007199254740992'),
    canon({ ...data, version: 2 }), canon({ ...data, extra: true }), canon({ ...data, scope: other }),
    canon({ ...data, records: [{ ...data.records[0], phase: 'finished' }] }),
    canon({ ...data, records: [{ ...data.records[0], input: null }] }),
    canon({ ...data, records: [{ ...data.records[0], fingerprint: other }] }),
    canon({ ...data, records: [data.records[0], data.records[0]] }),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]), Buffer.from([0xff, 0xfe]),
    valid.toString().replace('ordinary request', '\\ud800'),
    Buffer.alloc(ADMISSION_LIMITS.snapshotBytes + 1, 32),
  ];
  for (const bad of variants) {
    fs.writeFileSync(f.file, bad); assert.throws(() => f.open(), isError());
    assert.deepEqual(fs.readFileSync(f.file), Buffer.from(bad));
  }
  fs.writeFileSync(f.file, valid); assert.equal(f.open().inspect().records.length, 1);
});
test('unsafe roots, traversal, scope and symlink ancestors rejected', t => {
  const f = fixture(t);
  for (const id of ['../escape', '', 'a'.repeat(63), 'A'.repeat(64), `${scope}/x`]) assert.throws(() => f.open(id), isError());
  for (const root of ['relative', `${f.root}/../${path.basename(f.root)}`, f.root + '/', '/']) assert.throws(() => AdmissionStore.open(root, scope), isError());
  const link = path.join(f.root, 'link'); fs.symlinkSync(f.root, link);
  assert.throws(() => AdmissionStore.open(link, scope), isError('unsafe-path'));
  fs.chmodSync(f.root, 0o755); assert.throws(() => f.open(), isError('unsafe-permissions')); fs.chmodSync(f.root, 0o700);
  fs.symlinkSync(f.root, f.dir); assert.throws(() => f.open(), isError('unsafe-path'));
});
test('wrong expected files, hardlinks and permissions never reset canonical state', t => {
  const f = fixture(t), s = f.open(); s.admit(input()); s.close();
  const valid = fs.readFileSync(f.file);
  fs.chmodSync(f.file, 0o644); assert.throws(() => f.open(), isError('unsafe-permissions')); fs.chmodSync(f.file, 0o600);
  fs.chmodSync(f.dir, 0o755); assert.throws(() => f.open(), isError('unsafe-permissions')); fs.chmodSync(f.dir, 0o700);
  const alternate = path.join(f.root, 'alternate'); fs.renameSync(f.file, alternate);
  fs.symlinkSync(alternate, f.file); assert.throws(() => f.open(), isError('unsafe-path')); fs.unlinkSync(f.file);
  fs.linkSync(alternate, f.file); assert.throws(() => f.open(), isError('unsafe-path')); fs.unlinkSync(f.file);
  fs.mkdirSync(f.file, { mode: 0o700 }); assert.throws(() => f.open(), isError('unsafe-path')); fs.rmdirSync(f.file);
  assert.throws(() => f.open(), isError('missing-snapshot'));
  fs.writeFileSync(f.file, valid, { mode: 0o600 });
  // A foreign owner's metadata is injected without chown or privilege assumptions.
  const restore = patch(t, 'lstatSync', original => (...args) => {
    const stat = original(...args); if (args[0] === f.file) stat.uid += 1; return stat;
  });
  assert.throws(() => f.open(), isError('unsafe-permissions')); restore();
  assert.equal(f.open().inspect().records.length, 1);
});
for (const stage of ['write', 'file-fsync', 'rename', 'directory-fsync']) {
  test(`injected ${stage} interruption: no false success, poison, exact reopen`, t => {
    const f = fixture(t); let armed = false;
    const s = f.open(scope, { beforeIO(point) { if (armed && point === stage) throw new Error('injected private detail'); } });
    s.admit(input(1)); s.admit(input(2)); const before = s.inspect();
    armed = true;
    assert.throws(() => s.stop([1, 2]), isError('io-write'));
    assert.equal(s.needsReopen, true); assert.deepEqual(s.inspect(), before);
    assert.throws(() => s.admit(input(3)), isError('reopen-required'));
    assert.throws(() => s.admit(input(1)), isError('reopen-required'), 'exact duplicate must not bypass poison');
    s.close(); const reopened = f.open(), after = reopened.inspect();
    assert.equal(after.generation, before.generation + (stage === 'directory-fsync' ? 1 : 0));
    assert.equal(after.stopLatched, stage === 'directory-fsync');
    assert.deepEqual(after.records.map(r => r.phase), stage === 'directory-fsync' ? ['held', 'held'] : ['received', 'received']);
    reopened.admit(input(3));
  });
}
test('actual write short count and fsync/rename syscall failures are bounded and safe', t => {
  const f = fixture(t); let s = f.open(); s.admit(input());
  for (const kind of ['short-write', 'fsync', 'rename']) {
    let calls = 0;
    const key = kind === 'short-write' ? 'writeSync' : kind === 'fsync' ? 'fsyncSync' : 'renameSync';
    const restore = patch(t, key, original => (...args) => {
      calls++;
      if (kind === 'short-write') { original(args[0], args[1], 0, 3, 0); return 3; }
      throw new Error('deterministic syscall interruption');
    });
    assert.throws(() => s.admit(input(2)), isError()); assert.equal(calls, 1); restore();
    s.close(); s = f.open(); assert.equal(s.inspect().records.length, 1);
  }
});
test('bounded reads fail closed on short read and oversize before allocation/read', t => {
  const f = fixture(t), s = f.open(); s.admit(input()); s.close();
  let calls = 0;
  let restore = patch(t, 'readSync', () => () => { calls++; return 0; });
  assert.throws(() => f.open(), isError('short-read')); assert.equal(calls, 1); restore();
  fs.truncateSync(f.file, ADMISSION_LIMITS.snapshotBytes + 1); calls = 0;
  restore = patch(t, 'readSync', () => () => { calls++; throw new Error('must not read'); });
  assert.throws(() => f.open(), isError('snapshot-quota')); assert.equal(calls, 0); restore();
});
test('abandoned temps ignored, no scanning or broad cleanup, changed canonical poisons', t => {
  const f = fixture(t), s = f.open(); s.admit(input()); s.close();
  const abandoned = path.join(f.dir, '.snapshot-deadbeef.tmp'); fs.writeFileSync(abandoned, 'not a record', { mode: 0o600 });
  const otherFile = path.join(f.dir, 'unrelated'); fs.writeFileSync(otherFile, 'leave alone', { mode: 0o600 });
  const reopened = f.open(); assert.equal(reopened.inspect().records.length, 1); reopened.admit(input(2));
  assert.equal(fs.readFileSync(abandoned, 'utf8'), 'not a record');
  assert.equal(fs.readFileSync(otherFile, 'utf8'), 'leave alone');
  const data = reopened.inspect(); data.generation++; fs.writeFileSync(f.file, canon(data));
  assert.throws(() => reopened.admit(input(3)), isError('concurrent-change')); assert.equal(reopened.needsReopen, true);
});
test('initialization failure does not silently recreate existing missing scope state', t => {
  const f = fixture(t);
  assert.throws(() => f.open(scope, { beforeIO() { throw new Error('init interrupted'); } }), isError('io-write'));
  assert.throws(() => f.open(), isError('missing-snapshot'));
});
for (const failedFlush of [1, 2, 3]) {
  test(`reopen flush ${failedFlush} failure is not a successful reconciliation`, t => {
    const f = fixture(t), s = f.open(); s.admit(input()); s.close();
    const before = fs.readFileSync(f.file);
    let calls = 0;
    const restore = patch(t, 'fsyncSync', original => (...args) => {
      calls++;
      if (calls === failedFlush) throw new Error('flush interrupted');
      return original(...args);
    });
    assert.throws(() => f.open(), isError('io-open')); assert.equal(calls, failedFlush); restore();
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(f.open().inspect().records.length, 1);
  });
}
for (const kind of ['rename-completed-then-error', 'actual-directory-fsync']) {
  test(`${kind} reopens the complete new snapshot, never returns success`, t => {
    const f = fixture(t), s = f.open(); s.admit(input(1)); s.admit(input(2));
    let failures = 0;
    const key = kind === 'actual-directory-fsync' ? 'fsyncSync' : 'renameSync';
    const restore = patch(t, key, original => (...args) => {
      if (kind === 'rename-completed-then-error') {
        original(...args); failures++; throw new Error('ambiguous rename');
      }
      if (fs.fstatSync(args[0]).isDirectory()) { failures++; throw new Error('directory flush interrupted'); }
      return original(...args);
    });
    assert.throws(() => s.stop([1, 2]), isError('io-write'));
    assert.equal(failures, 1); assert.equal(s.needsReopen, true); restore(); s.close();
    const next = f.open().inspect();
    assert.equal(next.generation, 3); assert.equal(next.stopLatched, true);
    assert.deepEqual(next.records.map(r => r.phase), ['held', 'held']);
  });
}
test('exclusive temp collision never removes or adopts an existing file', t => {
  const f = fixture(t), s = f.open(); s.admit(input());
  const collision = path.join(f.dir, `.snapshot-${'0'.repeat(32)}.tmp`);
  fs.writeFileSync(collision, 'not owned by write attempt', { mode: 0o600 });
  const original = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.alloc(16); syncBuiltinESMExports();
  t.after(() => { crypto.randomBytes = original; syncBuiltinESMExports(); });
  assert.throws(() => s.admit(input(2)), isError('io-write'));
  assert.equal(fs.readFileSync(collision, 'utf8'), 'not owned by write attempt');
  crypto.randomBytes = original; syncBuiltinESMExports();
  s.close(); assert.equal(f.open().inspect().records.length, 1);
});
test('generation exhaustion and regular file in scope path fail closed', t => {
  const f = fixture(t), s = f.open(); s.admit(input());
  const data = s.inspect(); s.close(); data.generation = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(f.file, canon(data));
  const reopened = f.open(); assert.throws(() => reopened.stop([1]), isError('generation-exhausted'));
  assert.equal(reopened.needsReopen, false); assert.deepEqual(reopened.inspect(), data);
  fs.writeFileSync(path.join(f.root, other), 'not a directory', { mode: 0o600 });
  assert.throws(() => f.open(other), isError('unsafe-path'));
});

test('file identity accepts bounded opaque safe strings verbatim, rejects control injection and malformed Unicode', t => {
  const f = fixture(t), store = f.open();
  const media = fileId => [{ retention: 'telegram-reference-only', type: 'document', fileId }];
  const id = 'opaque:/+=? with Unicode é';
  store.admit(input(1, { media: media(id) }));
  assert.equal(store.inspect().records[0].input.media[0].fileId, id);
  for (const unsafe of ['\0', '\r\n', '\x1b[31m', '\x85', '\u2028', '\ud800', 'x'.repeat(1025)]) {
    assert.throws(() => store.admit(input(2, { media: media(unsafe) })), isError('invalid-schema'));
  }
  store.close(); assert.equal(f.open().inspect().records[0].input.media[0].fileId, id);
});

test('Resolver and direct dgram public construction routes are forbidden', () => {
for (const proto of resolverPrototypes) for (const name of Object.getOwnPropertyNames(proto))
      if (/^(resolve|reverse|setServers|cancel)/.test(name)) assert.throws(() => proto[name].call({}), /tripwire/);
    for (const name of ['bind', 'connect', 'send', 'addMembership', 'addSourceSpecificMembership']) assert.throws(() => socketPrototype[name].call({}), /tripwire/);
  for (const mod of [dns, dnsPromises]) assert.throws(() => new mod.Resolver(), /tripwire/);
  assert.throws(() => new dgram.Socket('udp4'), /tripwire/);
  assert.throws(() => dgram.createSocket('udp4'), /tripwire/);
});

for (const end of ['\n', '\r', '\u2028', '\u2029']) test(`exact hex rejects trailing ${JSON.stringify(end)} in scope and tombstone fingerprint`, t => {
  const f = fixture(t); assert.throws(() => f.open(scope + end), isError());
  const store = f.open(); store.admit(input()); store.acknowledge(1, resolution); store.prune(1000); store.close();
  // Terminal tombstones need not match an input hash: validate the exact hex itself.
  const data = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  data.records = [{ updateId: 1, fingerprint: scope + end, input: null, phase: 'acknowledged', disposition: resolution }];
  fs.writeFileSync(f.file, canon(data)); assert.throws(() => f.open(), isError());
});

for (const closeFirst of [false, true]) test(`snapshot close ambiguity never retries (close first=${closeFirst})`, t => {
  const f = fixture(t), s = f.open(); s.admit(input());
  const before = s.inspect(), bytes = fs.readFileSync(f.file);
  const close = fs.closeSync;
  let target, owned, identity, calls = 0, recycled;
  const restoreOpen = patch(t, 'openSync', original => (...args) => {
    const fd = original(...args);
    if (path.dirname(String(args[0])) === f.dir && /^\.snapshot-[a-f0-9]{32}\.tmp$/.test(path.basename(String(args[0])))) {
      target = owned = fd; identity = fs.fstatSync(fd);
    }
    return fd;
  });
  const restoreClose = patch(t, 'closeSync', original => fd => {
    if (fd !== target) return original(fd);
    calls++;
    if (calls > 1) return original(fd); // Expose the old retry, including recycled-file damage.
    if (closeFirst) {
      original(fd); owned = undefined;
      recycled = fs.openSync(path.join(f.root, 'unrelated-private'), 'wx+', 0o600);
      owned = recycled; identity = fs.fstatSync(recycled);
    }
    throw new Error('ambiguous private fixture close');
  });
  try {
    assert.throws(() => s.admit(input(2)), isError('io-write'));
    assert.equal(s.needsReopen, true); assert.deepEqual(s.inspect(), before);
    assert.throws(() => s.admit(input(2)), isError('reopen-required'));
    restoreClose(); restoreOpen();
    assert.equal(calls, 1, 'potentially recycled descriptor must never be retried');
    if (closeFirst) assert.equal(recycled, target, 'fixture must exercise descriptor recycling');
    assert.equal(fs.fstatSync(owned).ino, identity.ino);
    if (closeFirst) assert.equal(fs.writeSync(recycled, 'still open'), 10);
    assert.deepEqual(fs.readFileSync(f.file), bytes);
    s.close(); assert.deepEqual(f.open().inspect(), before);
  } finally {
    restoreClose(); restoreOpen();
    // Close only an fd still proven to refer to our exact private fixture inode.
    if (owned !== undefined) {
      let stat;
      try { stat = fs.fstatSync(owned); } catch (e) { if (e.code !== 'EBADF') throw e; }
      if (stat && stat.dev === identity.dev && stat.ino === identity.ino) close(owned);
    }
  }
});
