import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import dgram from 'node:dgram';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { boundary } from './admission-lease-boundary.mjs';
const guard = boundary();
const { AdmissionLease, AdmissionLeaseError } = await import('../admission-lease.ts');
const { AdmissionStore } = await import('../admission-store.ts');
const scope = 'a'.repeat(64), other = 'b'.repeat(64);
const error = code => e => e instanceof AdmissionLeaseError && e.code === code && e.message === `Admission lease: ${code}`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.HOME), 'lease-unit-'));
  fs.chmodSync(root, 0o700); guard.roots.add(root);
  const leases = [];
  t.after(() => {
    guard.failure = undefined;
    for (const lease of leases) lease.release();
    guard.roots.delete(root); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file: path.join(root, `${scope}.lock`), acquire(id = scope) { const lease = AdmissionLease.acquire(root, id); leases.push(lease); return lease; } };
}
function patch(t, key, fn) {
  const original = fs[key]; fs[key] = fn(original); syncBuiltinESMExports();
  let restored = false;
  const restore = () => { if (!restored) { restored = true; fs[key] = original; syncBuiltinESMExports(); } };
  t.after(restore); return restore;
}

test('only exact fixed helper contract is permitted, never shells/network', () => {
  assert.throws(() => cp.spawn('anything'), /tripwire/);
  assert.throws(() => fetch('https://invalid.invalid'), /tripwire/);
  assert.throws(() => cp.execFileSync('/usr/bin/python3', ['-c', 'anything'], {}));
});
test('private root-level lease precedes store creation; scope untouched; same-process guard and stable inode', t => {
  const f = fixture(t), lease = f.acquire();
  assert.equal(lease.released, false);
  assert.equal(fs.existsSync(path.join(f.root, scope)), false);
  const initial = fs.statSync(f.file);
  assert.equal(initial.mode & 0o7777, 0o600); assert.equal(initial.size, 0);
  assert.throws(() => f.acquire(), error('already-owned'));
  const store = AdmissionStore.open(f.root, scope); store.close();
  const second = f.acquire(other); second.release();
  lease.release(); lease.release(); assert.equal(lease.released, true);
  assert.equal(fs.existsSync(f.file), true);
  f.acquire(); assert.equal(fs.statSync(f.file).ino, initial.ino);
});
test('fake kernel contention survives helper return, closes rejected descriptor, releases on owning close', t => {
  const f = fixture(t), lease = f.acquire();
  const contender = fs.openSync(f.file, 'r+');
  try {
    assert.throws(() => guard.acquireFd(contender), e => e.status === 3);
    lease.release(); guard.acquireFd(contender);
    const before = guard.held, descriptors = guard.descriptors.size;
    assert.throws(() => f.acquire(), error('contended'));
    assert.equal(guard.held, before); assert.equal(guard.descriptors.size, descriptors);
  } finally { fs.closeSync(contender); }
  f.acquire();
});
test('helper unavailable, timeout, signal and contention are fixed errors; failures leave stable file and no process guard', t => {
  const f = fixture(t);
  for (const failure of [{ code: 'ENOENT' }, { code: 'ETIMEDOUT', signal: 'SIGTERM' }, { status: 1 }, { status: 3 }]) {
    const descriptors = guard.descriptors.size;
    guard.failure = Object.assign(new Error('SECRET PRIVATE DETAIL'), failure);
    assert.throws(() => f.acquire(), error(failure.status === 3 ? 'contended' : 'helper-unavailable'));
    assert.equal(fs.existsSync(f.file), true);
    assert.equal(guard.held, 0); assert.equal(guard.descriptors.size, descriptors);
  }
  guard.failure = undefined; f.acquire();
});
test('invalid scopes, roots, symlink ancestry and permissions fail before helper', t => {
  const f = fixture(t), before = guard.calls;
  for (const scope of ['', '../x', 'A'.repeat(64), 'a'.repeat(63), ...['\n', '\r', '\u2028', '\u2029'].map(end => 'a'.repeat(64) + end)]) assert.throws(() => f.acquire(scope), error('invalid-scope'));
  for (const root of ['relative', f.root + '/', `${f.root}/../${path.basename(f.root)}`, '/']) assert.throws(() => AdmissionLease.acquire(root, scope), error('unsafe-root'));
  const link = path.join(f.root, 'link'); fs.symlinkSync(f.root, link);
  assert.throws(() => AdmissionLease.acquire(link, scope), error('unsafe-path'));
  fs.chmodSync(f.root, 0o755); assert.throws(() => f.acquire(), error('unsafe-permissions')); fs.chmodSync(f.root, 0o700);
  assert.equal(guard.calls, before);
});
test('existing unsafe lock is never replaced, repaired or removed', t => {
  const f = fixture(t), before = guard.calls;
  fs.writeFileSync(f.file, '', { mode: 0o644 });
  assert.throws(() => f.acquire(), error('unsafe-permissions')); assert.equal(fs.statSync(f.file).mode & 0o7777, 0o644);
  fs.chmodSync(f.file, 0o600); fs.writeFileSync(f.file, 'unusable');
  assert.throws(() => f.acquire(), error('unsafe-path')); assert.equal(fs.readFileSync(f.file, 'utf8'), 'unusable');
  fs.unlinkSync(f.file); fs.mkdirSync(f.file, { mode: 0o700 });
  assert.throws(() => f.acquire(), error('unsafe-path')); fs.rmdirSync(f.file);
  const alternate = path.join(f.root, 'alternate'); fs.writeFileSync(alternate, '', { mode: 0o600 });
  fs.symlinkSync(alternate, f.file); assert.throws(() => f.acquire(), error('unsafe-path')); fs.unlinkSync(f.file);
  fs.linkSync(alternate, f.file); assert.throws(() => f.acquire(), error('unsafe-path')); fs.unlinkSync(f.file);
  fs.renameSync(alternate, f.file);
  const restore = patch(t, 'lstatSync', original => (...args) => { const stat = original(...args); if (args[0] === f.file) stat.uid++; return stat; });
  assert.throws(() => f.acquire(), error('unsafe-permissions')); restore();
  assert.equal(guard.calls, before); f.acquire();
});
test('named inode disagreement fails before acquisition, no scope creation', t => {
  const f = fixture(t), before = guard.calls;
  const restore = patch(t, 'fstatSync', original => (...args) => { const stat = original(...args); if (stat.isFile()) stat.ino++; return stat; });
  assert.throws(() => f.acquire(), error('identity-changed')); restore();
  assert.equal(guard.calls, before); assert.equal(fs.existsSync(path.join(f.root, scope)), false); f.acquire();
});
for (const failedFlush of [1, 2]) test(`flush ${failedFlush} failure releases acquired fd but never deletes lock`, t => {
  const f = fixture(t); let calls = 0;
  const restore = patch(t, 'fsyncSync', original => (...args) => { if (++calls === failedFlush) throw new Error('PRIVATE'); return original(...args); });
  assert.throws(() => f.acquire(), error('io-acquire')); restore();
  assert.equal(guard.held, 0); const inode = fs.statSync(f.file).ino;
  f.acquire(); assert.equal(fs.statSync(f.file).ino, inode);
});

test('post-helper inode disagreement releases fd, retains stable lock and refuses success', t => {
  const f = fixture(t); let namedReads = 0;
  const restore = patch(t, 'lstatSync', original => (...args) => {
    const stat = original(...args);
    // Calls: pre-helper identity, test helper allowlist, post-helper identity.
    if (args[0] === f.file && ++namedReads === 3) stat.ino++;
    return stat;
  });
  assert.throws(() => f.acquire(), error('identity-changed')); restore();
  assert.equal(guard.held, 0); assert.equal(fs.existsSync(f.file), true); f.acquire();
});

test('ambiguous descriptor close is never retried and keeps same-process exclusion', t => {
  const f = fixture(t), lease = f.acquire(); let calls = 0;
  const restore = patch(t, 'closeSync', original => fd => {
    calls++; original(fd); throw new Error('private close failure');
  });
  assert.throws(() => lease.release(), error('io-release'));
  lease.release(); assert.equal(calls, 1); restore();
  assert.throws(() => f.acquire(), error('already-owned'));
});

for (const acquiring of [false, 'helper', 'flush']) for (const closeFirst of [false, true]) test(`ambiguous ${acquiring ? 'acquisition' : 'release'} close (closed=${closeFirst}) has separate descriptor evidence`, t => {
  const f = fixture(t), lease = acquiring ? undefined : f.acquire();
  let fd, calls = 0; const close = fs.closeSync;
  const restore = patch(t, 'closeSync', original => value => {
    if (fs.fstatSync(value).isFile()) { fd = value; calls++; if (closeFirst) original(value); throw new Error('SECRET'); }
    return original(value);
  });
  if (acquiring === 'helper') guard.failure = Object.assign(new Error('private'), { status: 3 });
  const restoreFlush = acquiring === 'flush' ? patch(t, 'fsyncSync', () => () => { throw new Error('private'); }) : () => {};
  assert.throws(() => acquiring ? f.acquire() : lease.release(), error(acquiring ? 'cleanup-uncertain' : 'io-release'));
  if (lease) { assert.equal(lease.retired, true); assert.equal(lease.released, false); assert.equal(lease.uncertain, true); lease.release(); }
  assert.equal(calls, 1); assert.equal(guard.descriptors.has(fd), !closeFirst);
  restore(); restoreFlush(); guard.failure = undefined;
  assert.throws(() => f.acquire(), error('already-owned'));
  if (!closeFirst) close(fd); // explicit fixture cleanup with proof it remains open
});

test('Resolver and direct dgram public construction routes are forbidden', () => {
  guard.checkPrototypes();
  for (const mod of [dns, dnsPromises]) assert.throws(() => new mod.Resolver(), /tripwire/);
  assert.throws(() => new dgram.Socket('udp4'), /tripwire/);
  assert.throws(() => dgram.createSocket('udp4'), /tripwire/);
});

for (const closeFirst of [false, true]) test(`acquisition directory close uncertainty is sanitized and never retried (closed=${closeFirst})`, t => {
  const f = fixture(t); let directoryFd, closes = 0; const close = fs.closeSync;
  const restore = patch(t, 'closeSync', original => fd => {
    if (fs.fstatSync(fd).isDirectory()) { directoryFd = fd; closes++; if (closeFirst) original(fd); throw new Error('SECRET'); }
    return original(fd);
  });
  assert.throws(() => f.acquire(), error('cleanup-uncertain'));
  assert.equal(closes, 1); assert.equal(guard.descriptors.has(directoryFd), !closeFirst);
  assert.equal(guard.held, 0); restore();
  assert.throws(() => f.acquire(), error('already-owned'));
  if (!closeFirst) close(directoryFd);
});
