// Exact child entry point allowed ONLY by admission-lease-os.test.mjs.
// No factory/host/session/config access. Deliberately exits without lease cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boundary } from './admission-lease-boundary.mjs';
const guard = boundary(true);
const { AdmissionLease } = await import('../admission-lease.ts');
const root = fs.realpathSync(process.env.HOME), scope = 'a'.repeat(64);
guard.roots.add(root);
AdmissionLease.acquire(root, scope);
const contender = fs.openSync(path.join(root, `${scope}.lock`), 'r+');
assert.throws(() => guard.acquireFd(contender), e => e.status === 3);
// Simulated abnormal owner termination, not a signal or a running-process kill.
process.exit(17);
