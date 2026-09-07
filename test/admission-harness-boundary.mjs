// Must precede any factory. Fake only the exact reviewed lease helper; all other
// subprocess/network seams remain forbidden unless an existing test replaces one.
import { boundary } from './admission-lease-boundary.mjs';
export const leaseBoundary = boundary();

// Existing job-origin regressions use the real producer factory but never its
// detached shell wrapper. Validate the exact argv/options and two fixture scripts;
// synthesize their private output/exit files without executing any input.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
const fakePids = new Set(); let nextPid = 1900000000;
cp.spawn = (bin, args, options) => {
  assert.equal(bin, 'bash'); assert.equal(args.length, 4);
  const [wrapper, directory, id, keep] = args;
  assert.equal(wrapper, path.join(process.env.JOBS_SOURCE_ROOT, '.pi/extensions/jobs/run-job.sh'));
  assert.equal(directory, path.join(options.cwd, '.pi/jobs'));
  assert.ok(leaseBoundary.roots.has(path.join(options.cwd, '.pi/agent/telegram-inbox')));
  assert.match(id, /^j[a-z0-9]+$/); assert.equal(keep, 'no-keep');
  assert.deepEqual(Object.keys(options).sort(), ['cwd', 'detached', 'env', 'stdio']);
  assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore');
  assert.deepEqual(options.env, { ...process.env, PI_JOB_ID: id });
  const record = JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8'));
  const plain = "printf 'done\\n'";
  const artifact = "sleep 0.1; printf 'artifact\\n' > answer.txt; printf 'done\\n'";
  assert.ok(record.command === plain || record.command === artifact);
  assert.equal(record.cwd, options.cwd);
  const quote = text => "'" + text.replace(/'/g, "'\\''") + "'";
  assert.equal(fs.readFileSync(path.join(directory, `${id}.cmd`), 'utf8'),
    ['#!/usr/bin/env bash', `export PI_JOB_ID=${quote(id)}`, `cd ${quote(options.cwd)} || exit 1`, record.command, ''].join('\n'));
  const child = new EventEmitter(); child.pid = ++nextPid; fakePids.add(child.pid); child.unref = () => {};
  setImmediate(() => {
    child.emit('spawn');
    setImmediate(() => {
      if (record.command === artifact) fs.writeFileSync(path.join(options.cwd, 'answer.txt'), 'artifact\n');
      fs.writeFileSync(path.join(directory, `${id}.log`), 'done\n');
      fs.writeFileSync(path.join(directory, `${id}.exit`), '0\n');
      fakePids.delete(child.pid);
    });
  });
  return child;
};
process.kill = (pid, signal) => {
  assert.equal(signal, 0, 'no signals allowed');
  assert.ok(pid > 1900000000 && pid <= nextPid, 'only fake PID probes');
  if (!fakePids.has(pid)) throw Object.assign(new Error('fake exited'), { code: 'ESRCH' });
  return true;
};
syncBuiltinESMExports();
