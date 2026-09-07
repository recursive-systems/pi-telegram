// Launch only fixed test groups, each in a fresh private environment. No installs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const groups = {
  original: ['queue', 'reload', 'commands', 'integration', 'job-origin', 'markdown'].map(n => `test/${n}.test.mjs`),
  integration: ['test/admission-integration.test.mjs'],
  config: ['test/admission-config.test.mjs'],
  store: ['test/admission-store.test.mjs'],
  lease: ['test/admission-lease.test.mjs'],
  portability: ['test/portability.test.mjs'],
  'lease-os': ['test/admission-lease-os.test.mjs'],
};
const requested = process.argv.slice(2);
assert.ok(requested.length <= 1 && (!requested.length || Object.hasOwn(groups, requested[0])), 'optional argument: one named group (lease-os is opt-in)');
const selected = requested.length ? requested : Object.keys(groups).filter(n => n !== 'lease-os');
const cwd = fileURLToPath(new URL('..', import.meta.url));
for (const group of selected) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-offline-')));
  fs.chmodSync(home, 0o700);
  const identity = fs.statSync(home);
  try {
    const env = { HOME: home, TMPDIR: home, PATH: '' };
    for (const key of ['PI_PACKAGE_DIR', 'TYPEBOX_PACKAGE_DIR', 'JOBS_SOURCE_ROOT']) {
      if (process.env[key] !== undefined) {
        assert.ok(path.isAbsolute(process.env[key]), `${key} must be absolute`);
        env[key] = process.env[key];
      }
    }
    if (group === 'lease-os') {
      assert.ok(Buffer.byteLength(process.env.PATH ?? '') <= 32768);
      const entries = (process.env.PATH ?? '').split(path.delimiter);
      assert.ok(entries.length <= 128);
      env.PATH = entries.filter(p => path.isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p)).join(path.delimiter);
      if (process.env.PI_TELEGRAM_PYTHON !== undefined) env.PI_TELEGRAM_PYTHON = process.env.PI_TELEGRAM_PYTHON;
    }
    console.log(`\nOffline group: ${group} (jobs integration ${env.JOBS_SOURCE_ROOT ? 'enabled' : 'not requested'})`);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-test-isolation=none',
      '--import', './test/offline-bootstrap.mjs', '--test', '--test-concurrency=1', ...groups[group]], { cwd, env, stdio: 'inherit' });
    if (result.error || result.status !== 0) { process.exitCode = 1; break; }
  } finally {
    const current = fs.lstatSync(home);
    assert.ok(current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino);
    fs.rmSync(home, { recursive: true });
  }
}
