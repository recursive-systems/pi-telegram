// Private files only; no factories/helpers/network. Reuses the exact tripwire.
import { boundary } from './admission-lease-boundary.mjs';
boundary();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const { persistTelegramConfig } = await import('../admission-config.ts');
for (const stage of ['write', 'file-sync', 'rename', 'directory-sync', 'rename-then-error']) test(`atomic config ${stage} failure returns no success and preserves complete old/new bytes`, async t => {
  const dir = fs.mkdtempSync(join(fs.realpathSync(process.env.TMPDIR), 'config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'telegram.json'); fs.writeFileSync(file, '{"lastUpdateId":0}', { mode: 0o600 });
  const old = promises.open, rename = promises.rename, write = promises.writeFile;
  const mocks = [];
  if (stage === 'write') mocks.push(t.mock.method(promises, 'open', async (...args) => { const handle = await old(...args); if (args[1] === 'wx') handle.writeFile = async () => { throw new Error('private'); }; return handle; }));
  if (stage.startsWith('rename')) mocks.push(t.mock.method(promises, 'rename', async (...args) => { if (stage === 'rename-then-error') await rename(...args); throw new Error('private'); }));
  if (stage.endsWith('sync')) mocks.push(t.mock.method(promises, 'open', async (...args) => {
    const handle = await old(...args), fail = stage === 'file-sync' ? args[0] !== dir : args[0] === dir;
    if (fail) handle.sync = async () => { throw new Error('private'); };
    return handle;
  }));
  syncBuiltinESMExports(); t.after(() => { mocks.forEach(m => m.mock.restore()); syncBuiltinESMExports(); });
  await assert.rejects(persistTelegramConfig(file, { lastUpdateId: 1 }), /operator repair required/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastUpdateId, ['directory-sync', 'rename-then-error'].includes(stage) ? 1 : 0);
  assert.deepEqual(fs.readdirSync(dir), ['telegram.json']);
  mocks.forEach(m => m.mock.restore()); syncBuiltinESMExports();
  await persistTelegramConfig(file, { lastUpdateId: 2 }); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastUpdateId, 2);
});
