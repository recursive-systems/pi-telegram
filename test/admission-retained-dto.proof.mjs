// Excluded from ordinary suites. Exact source-known preintegration fixture only;
// all factories stay behind the reviewed private fake host/transport boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { harness, deferred, until } from './harness.mjs';
test('corrected GAP proof: specific input DTO absent while cursor committed and preparation blocked', async t => {
  const h = await harness(t, { sourceKnownBaseline: process.env.ADMISSION_BASELINE === '1' });
  const gate = deferred(); let preparing = false;
  h.networkGate = async method => { if (method === 'getFile') { preparing = true; await gate.promise; } };
  await h.receive('retained baseline input', { document: { file_id: 'opaque_file' } }); await until(() => preparing);
  const scope = createHash('sha256').update(JSON.stringify(['pi-telegram/admission-records/v1', 'FAKE-OFFLINE', 7])).digest('hex');
  const file = join(h.home, '.pi/agent/telegram-inbox', scope, 'snapshot.json');
  const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).records.find(r => r.updateId === 1) : undefined;
  const retained = record?.input?.text === 'retained baseline input' && record?.input?.media?.[0]?.fileId === 'opaque_file';
  assert.equal(JSON.parse(fs.readFileSync(join(h.home, '.pi/agent/telegram.json'), 'utf8')).lastUpdateId, 1);
  assert.equal(h.sent.length, 0); gate.resolve();
  assert.equal(retained, false, 'specific retained DTO eliminates baseline gap');
});
