// Separately run, explicitly allowlisted LOCAL POSIX helper proof only.
// No extension factories, host SDK, configs, operational processes or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boundary } from './admission-lease-boundary.mjs';
const guard = boundary(true);
const { AdmissionLease } = await import('../admission-lease.ts');
const scope = 'a'.repeat(64);

test('OS flock survives helper exit, excludes independent open, and releases after owner fd close', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.HOME), 'lease-os-'));
  fs.chmodSync(root, 0o700); guard.roots.add(root);
  let lease, contender;
  try {
    lease = AdmissionLease.acquire(root, scope);
    const file = path.join(root, `${scope}.lock`), inode = fs.statSync(file).ino;
    contender = fs.openSync(file, 'r+');
    assert.throws(() => guard.acquireFd(contender), e => e.status === 3);
    lease.release();
    guard.acquireFd(contender);
    assert.throws(() => AdmissionLease.acquire(root, scope), e => e.code === 'contended');
    fs.closeSync(contender); contender = undefined;
    lease = AdmissionLease.acquire(root, scope);
    assert.equal(fs.statSync(file).ino, inode, 'stable lock file was never replaced');
  } finally {
    if (contender !== undefined) fs.closeSync(contender);
    lease?.release(); guard.roots.delete(root); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OS releases flock after private owner process exits without release()', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.HOME), 'lease-exit-'));
  fs.chmodSync(root, 0o700); guard.roots.add(root);
  let lease;
  try {
    assert.throws(() => guard.exitOwner(root), e => e.status === 17,
      'child must acquire, prove contention, then exit with its dedicated code');
    const file = path.join(root, `${scope}.lock`), inode = fs.statSync(file).ino;
    lease = AdmissionLease.acquire(root, scope);
    assert.equal(fs.statSync(file).ino, inode);
  } finally {
    lease?.release(); guard.roots.delete(root); fs.rmSync(root, { recursive: true, force: true });
  }
});
