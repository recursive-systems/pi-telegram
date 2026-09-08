import './admission-harness-boundary.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { harness, until } from './harness.mjs';
import { ContinuationStore } from '../continuation-store.ts';

const CAPTURE = 'pi-telegram:continuation:v1:capture';
const OFFER = 'pi-telegram:continuation:v1:offer';
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function capture(h) { let context; h.bus.emit(CAPTURE, { version: 1, capture: value => { context = value; } }); return context; }
function offer(h, values) { let response; h.bus.emit(OFFER, { version: 1, producer: 'fixture.synthetic', completionId: values.completionId, context: values.context, content: values.content ?? 'synthetic completion', semanticFingerprint: values.semanticFingerprint ?? fingerprint(values.semantic ?? { completionId: values.completionId }), mode: values.mode ?? 'dispatch', reply: value => { response = value; } }); return response; }
function continuationRecords(h) {
  const root = path.join(h.home, '.pi/agent/telegram-inbox');
  const files = fs.readdirSync(root, { recursive: true }).filter(value => String(value).endsWith('continuations.json'));
  assert.equal(files.length, 1, 'fixture has exactly one continuation journal');
  return JSON.parse(fs.readFileSync(path.join(root, String(files[0])), 'utf8')).records;
}
async function origin(h) { await h.receive('launch producer work'); await h.start(); const context = capture(h); assert.equal(typeof context, 'string'); await h.end('producer launched'); await h.settle(); return context; }

test('core alone creates no optional continuation journal', async t => { const h = await harness(t); await h.receive('ordinary core request'); await h.start(); await h.end('done'); await h.settle(); const files = fs.readdirSync(path.join(h.home, '.pi/agent/telegram-inbox'), { recursive: true }); assert.ok(!files.some(value => String(value).endsWith('continuations.json'))); });
test('synthetic producer gets synchronous durable acceptance before queued submission', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(); const response = offer(h, { context, completionId }); assert.deepEqual(response, { version: 1, disposition: 'accepted' }); await until(() => h.sent.length === 2); assert.match(h.sent[1][0].text, /fixture\.synthetic completion result/); assert.match(h.sent[1][0].text, /synthetic completion/); });
test('synchronous host rejection after durable continuation acceptance stays uncertain without resubmission', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(); h.userSubmission = 'throw'; assert.equal(offer(h, { context, completionId }).disposition, 'accepted'); await until(() => h.submissions.length === 2); assert.equal(h.sent.length, 1); assert.equal(h.submissions.length, 2); const retained = continuationRecords(h).find(record => record.completionId === completionId); assert.equal(retained.phase, 'uncertain'); assert.equal(retained.note, 'synchronous submission rejection'); assert.match(h.statuses.at(-1), /submission failed; outcome uncertain/); });
test('asynchronously swallowed continuation remains retained uncertain after the admission timer', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(); h.asyncAdmission(async () => 'handled'); assert.equal(offer(h, { context, completionId }).disposition, 'accepted'); await until(() => h.sent.length === 2); t.mock.timers.tick(5000); const retained = continuationRecords(h).find(record => record.completionId === completionId); assert.equal(retained.phase, 'uncertain'); assert.equal(retained.note, 'host admission not observed'); assert.match(h.statuses.at(-1), /continuation admission uncertain; operator inspection required/); });
test('busy accepted continuation is durably held and drains after the newer Telegram turn', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(); await h.receive('newer request owns the bridge'); assert.equal(offer(h, { context, completionId }).disposition, 'accepted'); assert.equal((await h.diagnostic()).admission.continuationHeld, 1); assert.equal(h.sent.length, 2); await h.start(); await h.end('newer response'); await h.settle(); assert.equal(h.sent.length, 3); assert.match(h.sent[2][0].text, /fixture\.synthetic completion result/); });
test('exact retained duplicate and existing-only receipt authorize no second submission', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(), semanticFingerprint = fingerprint({ completionId }); assert.equal(offer(h, { context, completionId, semanticFingerprint }).disposition, 'accepted'); assert.equal(offer(h, { context, completionId, semanticFingerprint }).disposition, 'duplicate'); assert.equal(offer(h, { completionId, semanticFingerprint, mode: 'existing-only' }).disposition, 'duplicate'); await until(() => h.sent.length === 2); assert.equal(h.sent.length, 2); });
test('changed content cannot hide behind a producer fingerprint', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(), semanticFingerprint = fingerprint({ completionId }); assert.equal(offer(h, { context, completionId, semanticFingerprint, content: 'first' }).disposition, 'accepted'); assert.equal(offer(h, { completionId, semanticFingerprint, content: 'changed', mode: 'existing-only' }).disposition, 'declined'); assert.equal((await h.diagnostic()).admission.fault, true); });
test('inspection-only retains uncertainty and never grants admission', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(); const response = offer(h, { context, completionId, mode: 'inspection-only' }); assert.equal(response.disposition, 'retained-for-inspection'); assert.equal(h.sent.length, 1); const diagnostic = await h.diagnostic(); assert.equal(diagnostic.admission.continuationHeld, 1); assert.equal(diagnostic.blocker, 'continuation-inspection'); });
test('unknown existing-only receipt declines without creating a journal', async t => { const h = await harness(t); const response = offer(h, { completionId: randomUUID(), mode: 'existing-only' }); assert.equal(response.disposition, 'declined'); const files = fs.readdirSync(path.join(h.home, '.pi/agent/telegram-inbox'), { recursive: true }); assert.ok(!files.some(value => String(value).endsWith('continuations.json'))); });
test('stale stop fence declines a retained receipt without fault, replay, or blocking later completion', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(), semanticFingerprint = fingerprint({ completionId }); assert.equal(offer(h, { context, completionId, semanticFingerprint }).disposition, 'accepted'); await until(() => h.sent.length === 2); await h.start(); await h.end('assessed'); await h.settle(); await h.receive('/stop'); const beforeRetry = h.sent.length; assert.equal(offer(h, { completionId, semanticFingerprint, mode: 'existing-only' }).disposition, 'declined'); assert.equal(h.sent.length, beforeRetry); const diagnostic = await h.diagnostic(); assert.equal(diagnostic.admission.fault, false); assert.equal(diagnostic.admission.continuationHeld, 0); await h.receive('new request after stop'); assert.match(h.sent.at(-1)[0].text, /new request after stop/); await h.start(); await h.end('fresh response'); await h.settle(); assert.ok(h.network.some(call => call.method === 'sendMessage' && call.body.text === 'fresh response')); });
test('stale optional receipt context cannot fault a current retained record or unrelated admission', async t => {
  const h = await harness(t), stale = await origin(h);
  await h.receive('/stop');
  const current = await origin(h), completionId = randomUUID(), semanticFingerprint = fingerprint({ completionId });
  assert.equal(offer(h, { context: current, completionId, semanticFingerprint }).disposition, 'accepted');
  await until(() => h.sent.length === 3);
  await h.start(); await h.end('current completion assessed'); await h.settle();
  const before = continuationRecords(h), submissions = h.submissions.length;
  assert.equal(before[0].phase, 'handled');
  assert.equal(offer(h, { context: stale, completionId, semanticFingerprint, mode: 'existing-only' }).disposition, 'declined');
  assert.equal((await h.diagnostic()).admission.fault, false, 'stale optional authority is not identity corruption');
  assert.deepEqual(continuationRecords(h), before, 'stale fence cannot mutate retained responsibility');
  assert.equal(offer(h, { completionId, semanticFingerprint, mode: 'existing-only' }).disposition, 'duplicate');
  assert.equal(h.submissions.length, submissions, 'receipt checks cannot replay the completion');
  await h.receive('ordinary request after stale optional context');
  await h.start(); await h.end('ordinary admission still works'); await h.settle();
  assert.ok(h.network.some(call => call.method === 'sendMessage' && call.body.chat_id === 70 && call.body.text === 'ordinary admission still works'));
});

test('conflicting current authentic optional receipt context still faults conservatively', async t => {
  const h = await harness(t), otherCurrent = await origin(h), current = await origin(h);
  const completionId = randomUUID(), semanticFingerprint = fingerprint({ completionId });
  assert.notEqual(otherCurrent, current);
  assert.equal(offer(h, { context: current, completionId, semanticFingerprint }).disposition, 'accepted');
  await until(() => h.sent.length === 3);
  await h.start(); await h.end('completion assessed'); await h.settle();
  const before = continuationRecords(h), submissions = h.submissions.length;
  assert.equal(offer(h, { context: otherCurrent, completionId, semanticFingerprint, mode: 'existing-only' }).disposition, 'declined');
  assert.equal((await h.diagnostic()).admission.fault, true, 'current authentic identity disagreement must not be weakened');
  assert.deepEqual(continuationRecords(h), before);
  assert.equal(h.submissions.length, submissions);
});

test('journal acceptance failure declines and never submits', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(); t.mock.method(ContinuationStore.prototype, 'accept', () => { throw new Error('fixture write ambiguity'); }); assert.equal(offer(h, { context, completionId }).disposition, 'declined'); assert.equal(h.sent.length, 1); });
test('cold factory inspects unresolved records but never reconstructs or replays a turn', async t => { const h = await harness(t), context = await origin(h), completionId = randomUUID(); await h.receive('occupy bridge'); assert.equal(offer(h, { context, completionId }).disposition, 'accepted'); await h.replace('new'); assert.equal(h.sent.length, 2); const diagnostic = await h.diagnostic(); assert.equal(diagnostic.admission.continuationHeld, 1); assert.equal(diagnostic.blocker, 'continuation-inspection'); });
test('factory replacement removes the old protocol listeners', async t => { const h = await harness(t), context = await origin(h); assert.equal(h.bus.listenerCount(CAPTURE), 1); assert.equal(h.bus.listenerCount(OFFER), 1); await h.replace('new'); assert.equal(h.bus.listenerCount(CAPTURE), 1); assert.equal(h.bus.listenerCount(OFFER), 1); assert.equal(offer(h, { context, completionId: randomUUID() }).disposition, 'declined'); });
