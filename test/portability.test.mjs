import { boundary } from './admission-lease-boundary.mjs';
const guard = boundary();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDependency } from './offline-dependencies.mjs';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
const originalStat = fs.statSync;
let importProbes = 0;
fs.statSync = (...args) => { importProbes++; return originalStat(...args); };
syncBuiltinESMExports();
let resolveAdmissionPython, AdmissionLease;
try { ({ resolveAdmissionPython, AdmissionLease } = await import('../admission-lease.ts')); }
finally { fs.statSync = originalStat; syncBuiltinESMExports(); }
const fails = code => e => e.code === code && e.message === `Admission lease: ${code}`;

test('lazy import never probes or executes an interpreter', () => {
  assert.equal(guard.calls, 0); assert.equal(importProbes, 0);
});
test('resolver selects absolute PATH entries only, in order, without execution', t => {
  const root = fs.mkdtempSync(path.join(process.env.HOME, 'another-tool-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const first = path.join(root, 'one'), second = path.join(root, 'two');
  for (const dir of [first, second]) fs.mkdirSync(dir);
  const bin = path.join(second, 'python3'); fs.writeFileSync(bin, 'fake', { mode: 0o700 });
  fs.writeFileSync(path.join(first, 'python3'), 'not executable', { mode: 0o600 });
  assert.equal(resolveAdmissionPython({ PATH: `:.:relative:${first}:${second}:` }), bin);
  fs.chmodSync(path.join(first, 'python3'), 0o700);
  assert.equal(resolveAdmissionPython({ PATH: `${first}:${second}` }), path.join(first, 'python3'));
  assert.equal(resolveAdmissionPython({ PATH: first, PI_TELEGRAM_PYTHON: bin }), bin);
  assert.equal(guard.calls, 0);
});
test('cwd and relative PATH entries cannot discover an executable even when one exists', t => {
  const root = fs.mkdtempSync(path.join(process.env.HOME, 'unsafe-search-'));
  const cwd = process.cwd();
  t.after(() => { process.chdir(cwd); fs.rmSync(root, { recursive: true }); });
  fs.mkdirSync(path.join(root, 'relative'));
  for (const dir of [root, path.join(root, 'relative')]) fs.writeFileSync(path.join(dir, 'python3'), 'fake', { mode: 0o700 });
  process.chdir(root);
  assert.throws(() => resolveAdmissionPython({ PATH: ':.:relative:' }), fails('python-unavailable'));
  assert.equal(guard.calls, 0);
});
test('absent, unsafe and excessive lookup fail closed; invalid override never falls back', t => {
  const root = fs.mkdtempSync(path.join(process.env.HOME, 'absent-interpreter-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const absent = path.join(root, 'never-created');
  assert.equal(fs.existsSync(absent), false);
  for (const PATH of [undefined, '', ':.:relative', absent, 'x'.repeat(32769), ':'.repeat(128)])
    assert.throws(() => resolveAdmissionPython({ PATH }), fails('python-unavailable'));
  for (const PI_TELEGRAM_PYTHON of ['', 'python3', './python3', absent, guard.python + '\n', 'x'.repeat(4097), process.env.HOME])
    assert.throws(() => resolveAdmissionPython({ PATH: path.dirname(guard.python), PI_TELEGRAM_PYTHON }), fails('python-override-invalid'));
  assert.equal(guard.calls, 0);
});
test('acquisition prerequisite failure closes only its descriptor and never invokes helper', t => {
  const root = fs.mkdtempSync(path.join(process.env.HOME, 'no-python-')); guard.roots.add(root);
  const old = process.env.PI_TELEGRAM_PYTHON;
  t.after(() => { process.env.PI_TELEGRAM_PYTHON = old; guard.roots.delete(root); fs.rmSync(root, { recursive: true }); });
  const count = guard.descriptors.size;
  process.env.PI_TELEGRAM_PYTHON = '';
  assert.throws(() => AdmissionLease.acquire(root, 'a'.repeat(64)), fails('python-override-invalid'));
  assert.equal(guard.descriptors.size, count); assert.equal(guard.calls, 0);
});
test('acquisition uses resolved fake absolute PATH identity, never a real interpreter', t => {
  const root = fs.mkdtempSync(path.join(process.env.HOME, 'path-acquire-')); guard.roots.add(root);
  const old = process.env.PI_TELEGRAM_PYTHON, oldPath = process.env.PATH;
  t.after(() => { process.env.PI_TELEGRAM_PYTHON = old; process.env.PATH = oldPath; guard.roots.delete(root); fs.rmSync(root, { recursive: true }); });
  delete process.env.PI_TELEGRAM_PYTHON; process.env.PATH = `:relative:${path.dirname(guard.python)}`;
  const count = guard.calls;
  const lease = AdmissionLease.acquire(root, 'a'.repeat(64));
  try { assert.equal(guard.calls, count + 1); } finally { lease.release(); }
});
test('dependency overrides use package exports in a differently named private layout, without evaluating entry', t => {
  const root = fs.mkdtempSync(path.join(process.env.HOME, 'unrelated-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const peer = path.join(root, 'standalone-peer'); fs.mkdirSync(peer);
  fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ name: '@sinclair/typebox', exports: './public.cjs' }));
  fs.writeFileSync(path.join(peer, 'public.cjs'), 'throw new Error("must not evaluate during resolution")');
  const parser = path.join(root, 'installed-host/node_modules/@earendil-works/pi-tui'); fs.mkdirSync(parser, { recursive: true });
  fs.writeFileSync(path.join(parser, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-tui', exports: './api.cjs' }));
  fs.writeFileSync(path.join(parser, 'api.cjs'), 'throw new Error("must not evaluate host")');
  const env = { TYPEBOX_PACKAGE_DIR: peer, PI_PACKAGE_DIR: path.join(root, 'installed-host') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    assert.equal(import.meta.resolve('@sinclair/typebox'), pathToFileURL(path.join(peer, 'public.cjs')).href);
    assert.equal(import.meta.resolve('@earendil-works/pi-tui'), pathToFileURL(path.join(parser, 'api.cjs')).href);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('dependency delegation preserves conditions, attributes and other context; default is unchanged', () => {
  const context = { parentURL: import.meta.url, conditions: ['node', 'import', 'custom'], importAttributes: { type: 'json' }, extra: {} };
  const result = {};
  for (const [specifier, env] of [['@sinclair/typebox', {}], ['unrelated', { PI_PACKAGE_DIR: process.env.HOME }]]) {
    assert.equal(resolveDependency(specifier, context, (name, actual) => {
      assert.equal(name, specifier); assert.equal(actual, context); return result;
    }, env), result);
  }
  assert.equal(resolveDependency('@sinclair/typebox', context, (name, actual) => {
    assert.equal(name, '@sinclair/typebox');
    assert.deepEqual(actual, { ...context, parentURL: pathToFileURL(path.join(process.env.HOME, 'package.json')).href });
    for (const key of ['conditions', 'importAttributes', 'extra']) assert.equal(actual[key], context[key]);
    return result;
  }, { TYPEBOX_PACKAGE_DIR: process.env.HOME }), result);
  for (const directory of ['', 'relative']) {
    assert.throws(() => resolveDependency('@sinclair/typebox', context, () => assert.fail('must not delegate invalid root'), { TYPEBOX_PACKAGE_DIR: directory }), /absolute package directories/);
  }
});
for (const importOnly of [true, false]) {
  test(`bootstrap selects ESM exports (${importOnly ? 'import-only self-reference' : 'distinct import/require nested peer'})`, async t => {
    const root = fs.mkdtempSync(path.join(process.env.HOME, 'private-export-layout-'));
    const key = importOnly ? 'TYPEBOX_PACKAGE_DIR' : 'PI_PACKAGE_DIR';
    const name = importOnly ? '@sinclair/typebox' : '@earendil-works/pi-tui';
    const old = process.env[key];
    t.after(() => {
      if (old === undefined) delete process.env[key]; else process.env[key] = old;
      fs.rmSync(root, { recursive: true });
    });
    const directory = importOnly ? path.join(root, 'unrelated-peer-name') : path.join(root, 'arbitrary-container');
    const pkg = importOnly ? directory : path.join(directory, 'node_modules', name);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, type: 'module', exports:
      importOnly ? { import: './sentinel.mjs' } : { import: './sentinel.mjs', require: './wrong.cjs' } }));
    fs.writeFileSync(path.join(pkg, 'sentinel.mjs'), 'export const branch = "private-import-sentinel";');
    fs.writeFileSync(path.join(pkg, 'wrong.cjs'), 'throw new Error("REQUIRE BRANCH MUST NEVER LOAD");');
    process.env[key] = directory;
    assert.equal((await import(name)).branch, 'private-import-sentinel');
  });
}
