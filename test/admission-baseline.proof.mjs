// Retained failing-before proof: run before wiring, then expect this gap assertion
// to FAIL against integrated index.ts. No production baseline fixture is loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, deferred, until } from './harness.mjs';
test('PRE-INTEGRATION GAP: cursor committed with no durable admission during media preparation', async t => {
  const h = await harness(t);
  const gate = deferred(); let preparing = false;
  h.networkGate = async method => { if (method === 'getFile') { preparing = true; await gate.promise; } };
  await h.receive('retained baseline input', { document: { file_id: 'opaque_file' } });
  await until(() => preparing);
  const config = JSON.parse(await readFile(join(h.home, '.pi/agent/telegram.json'), 'utf8'));
  const files = await readdir(join(h.home, '.pi/agent'), { recursive: true });
  gate.resolve();
  assert.equal(config.lastUpdateId, 1);
  assert.equal(files.some(name => name.endsWith('snapshot.json')), false, 'baseline gap must disappear after integration');
  assert.equal(h.sent.length, 0);
});
