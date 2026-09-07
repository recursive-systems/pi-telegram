// Test-only boundary: install before importing lease/store; no factories or host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
const ownerArgs = ['--experimental-strip-types', fileURLToPath(new URL('./admission-lease-owner.mjs', import.meta.url))];

// Deliberately duplicated to review/intercept EXACT production argv, not arbitrary Python.
const args = ['-I', '-S', '-c', 'import fcntl,sys\ntry: fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(3)\n'];
export function boundary(realOS = false) {
  assert.ok(process.env.HOME && process.env.TMPDIR, 'private scratch HOME and TMPDIR required');
  assert.equal(fs.realpathSync(process.env.HOME), fs.realpathSync(process.env.TMPDIR));
  const realExec = cp.execFileSync;
  const realClose = fs.closeSync;
  const realOpen = fs.openSync;
  const descriptors = new Set();
  const roots = new Set(), held = new Map();
  let failure, calls = 0;
  const resolverPrototypes = [dns.Resolver.prototype, dnsPromises.Resolver.prototype];
  const socketPrototype = dgram.Socket.prototype;
  const forbidden = function () { throw new Error('Offline admission-lease tripwire'); };
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[name] = forbidden;
  cp.ChildProcess.prototype.spawn = forbidden;
  for (const mod of [net, tls]) for (const name of ['connect', 'createConnection', 'createServer']) if (name in mod) mod[name] = forbidden;
  net.Socket.prototype.connect = forbidden; net.Server.prototype.listen = forbidden; dgram.createSocket = forbidden;
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
  globalThis.fetch = forbidden; globalThis.WebSocket = forbidden;
  cp.execFileSync = (executable, actualArgs, options) => {
    if (realOS && executable === process.execPath) {
      assert.deepEqual(actualArgs, ownerArgs);
      assert.deepEqual(Object.keys(options).sort(), ['cwd', 'env', 'stdio', 'timeout']);
      assert.ok(roots.has(options.env.HOME), 'child HOME must be a registered scratch root');
      assert.deepEqual(options.env, { HOME: options.env.HOME, TMPDIR: options.env.HOME });
      assert.equal(options.cwd, '/'); assert.equal(options.timeout, 3000);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore']);
      return realExec(executable, actualArgs, options);
    }
    assert.equal(executable, '/usr/bin/python3'); assert.deepEqual(actualArgs, args);
    assert.deepEqual(Object.keys(options).sort(), ['cwd', 'env', 'stdio', 'timeout']);
    assert.deepEqual(options.env, { LANG: 'C', LC_ALL: 'C' });
    assert.equal(options.cwd, '/'); assert.equal(options.timeout, 3000);
    assert.deepEqual(options.stdio.slice(0, 3), ['ignore', 'ignore', 'ignore']);
    assert.equal(options.stdio.length, 4);
    const fd = options.stdio[3], stat = fs.fstatSync(fd);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size === 0 && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o600);
    assert.ok([...roots].some(root => fs.readdirSync(root).some(name => {
      if (!/^[a-f0-9]{64}\.lock$/.test(name)) return false;
      const named = fs.lstatSync(path.join(root, name));
      return named.dev === stat.dev && named.ino === stat.ino;
    })), 'helper fd must refer to a registered scratch-root lock');
    calls++;
    if (failure) throw failure;
    if (realOS) return realExec(executable, actualArgs, options);
    const key = `${stat.dev}:${stat.ino}`;
    if (held.has(key) && held.get(key) !== fd) throw Object.assign(new Error('private injected error'), { status: 3 });
    held.set(key, fd); return Buffer.alloc(0);
  };
  if (!realOS) fs.openSync = (...args) => { const fd = realOpen(...args); descriptors.add(fd); return fd; };
  if (!realOS) fs.closeSync = fd => {
    realClose(fd); descriptors.delete(fd);
    for (const [key, owner] of held) if (owner === fd) held.delete(key);
  };
  syncBuiltinESMExports();
  return {
    checkPrototypes() { for (const proto of resolverPrototypes) for (const name of Object.getOwnPropertyNames(proto))
      if (/^(resolve|reverse|setServers|cancel)/.test(name)) assert.throws(() => proto[name].call({}), /tripwire/);
    for (const name of ['bind', 'connect', 'send', 'addMembership', 'addSourceSpecificMembership']) assert.throws(() => socketPrototype[name].call({}), /tripwire/); },
    roots, descriptors, get calls() { return calls; }, get held() { return held.size; },
    set failure(value) { failure = value; },
    exitOwner(root) {
      assert.ok(realOS);
      return cp.execFileSync(process.execPath, [...ownerArgs], { env: { HOME: root, TMPDIR: root }, cwd: '/', timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] });
    },
    acquireFd(fd) { return cp.execFileSync('/usr/bin/python3', [...args], { stdio: ['ignore', 'ignore', 'ignore', fd], env: { LANG: 'C', LC_ALL: 'C' }, cwd: '/', timeout: 3000 }); },
  };
}
