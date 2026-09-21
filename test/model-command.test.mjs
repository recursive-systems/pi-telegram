import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { describeModels, parseModelSelection, resolveModelSelection, thinkingLevels, MODEL_LIST_LIMIT } from '../model-command.ts';

const replies = h => h.network.filter(n => n.method === 'sendMessage').map(n => n.body.text);
const last = h => replies(h).at(-1);
const catalogue = [
  { provider: 'alpha', id: 'primary-1' },
  { provider: 'beta', id: 'backup-2' },
  { provider: 'beta', id: 'keyless-3', auth: false },
  { provider: 'gamma', id: 'backup-2' },
  { provider: 'unscoped', id: 'hidden' },
  { provider: 'gamma', id: 'shallow-4', levels: ['off', 'low', 'medium'] },
];
const scoped = ['alpha/primary-1', 'beta/backup-2', 'beta/keyless-3', 'gamma/backup-2', 'gamma/shallow-4'];
const session = t => harness(t, { models: catalogue, scoped, currentModel: 'alpha/primary-1', thinking: 'high' });

test('parse: empty shows, provider/id with optional case-insensitive thinking, otherwise invalid', () => {
  assert.equal(parseModelSelection('   '), undefined);
  assert.deepEqual(parseModelSelection('backup-2'), { model: 'backup-2' });
  assert.deepEqual(parseModelSelection('beta/backup-2 HIGH'), { provider: 'beta', model: 'backup-2', thinking: 'high' });
  assert.deepEqual(parseModelSelection('openrouter/anthropic/claude-x'), { provider: 'openrouter', model: 'anthropic/claude-x' });
  for (const bad of ['a b c', 'beta/backup-2 hyper', '/x', 'p/', 'bad provider/x', 'x'.repeat(129), 'a$b', '$p/x'])
    assert.equal(parseModelSelection(bad), 'invalid', bad);
  assert.deepEqual([...thinkingLevels], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('resolve: exact id within candidates only; bare id must be unique', () => {
  const candidates = catalogue.slice(0, 4).map(m => ({ ...m, auth: m.auth !== false }));
  assert.deepEqual(resolveModelSelection({ model: 'primary-1' }, candidates).model, candidates[0]);
  assert.deepEqual(resolveModelSelection({ provider: 'gamma', model: 'backup-2' }, candidates).model, candidates[3]);
  assert.match(resolveModelSelection({ model: 'backup-2' }, candidates).error, /ambiguous.*beta\/backup-2, gamma\/backup-2/);
  assert.match(resolveModelSelection({ model: 'hidden' }, candidates).error, /not available in this session/);
  assert.match(resolveModelSelection({ provider: 'alpha', model: 'backup-2' }, candidates).error, /not available/);
  assert.match(resolveModelSelection({ model: 'Primary-1' }, candidates).error, /not available/);
});

test('describe: marks active model and missing credentials, bounds the list', () => {
  const candidates = catalogue.slice(0, 4).map(m => ({ ...m, auth: m.auth !== false }));
  const text = describeModels(candidates[1], 'high', candidates, true);
  assert.match(text, /^Model: beta\/backup-2 \(thinking: high\)\n.*\(scoped\)/);
  assert.match(text, /\nbeta\/backup-2 \(active\)\n/);
  assert.match(text, /keyless-3 \(no credentials\)/);
  assert.match(text, /Switch: \/model provider\/id \[thinking\]/);
  assert.match(describeModels(undefined, undefined, [], false), /^Model: unknown\nAvailable in this session:\nNo models\./);
  const many = Array.from({ length: MODEL_LIST_LIMIT + 3 }, (_, i) => ({ provider: 'p', id: `m${i}`, auth: true }));
  const bounded = describeModels(undefined, undefined, many, false);
  assert.match(bounded, /\[3 more; inspect locally\]/);
  assert.equal(bounded.split('\n').length, MODEL_LIST_LIMIT + 4);
});

test('/model lists directly without a model turn, even while busy', async t => {
  const h = await session(t);
  await h.start('local');
  await h.receive('/model');
  assert.equal(h.submissions.length, 0); assert.equal(h.modelChanges.length, 0);
  const text = last(h);
  assert.match(text, /^Model: alpha\/primary-1 \(thinking: high\)/);
  assert.match(text, /alpha\/primary-1 \(active\)/);
  assert.match(text, /beta\/keyless-3 \(no credentials\)/);
  assert.doesNotMatch(text, /unscoped\/hidden/);
});

test('/model switches while idle, applies optional thinking, and refuses while busy', async t => {
  const h = await session(t);
  await h.receive('/model beta/backup-2');
  assert.deepEqual(h.modelChanges, ['beta/backup-2']); assert.deepEqual(h.thinkingChanges, []);
  assert.equal(h.currentModel.id, 'backup-2');
  assert.equal(last(h), 'Model: beta/backup-2 (thinking: high)');
  await h.receive('/model primary-1 medium');
  assert.equal(h.currentModel.provider, 'alpha'); assert.deepEqual(h.thinkingChanges, ['medium']);
  assert.equal(last(h), 'Model: alpha/primary-1 (thinking: medium)');
  await h.start('local');
  await h.receive('/model beta/backup-2');
  assert.match(last(h), /Cannot switch models while pi is busy/);
  assert.equal(h.modelChanges.length, 2); assert.equal(h.currentModel.provider, 'alpha');
  assert.equal(h.submissions.length, 0); assert.equal((await h.diagnostic()).held, false);
});

test('/model reports a thinking level the model clamps, in Pi vocabulary', async t => {
  const h = await session(t);
  await h.receive('/model gamma/shallow-4 xhigh');
  assert.deepEqual(h.thinkingChanges, ['xhigh']); assert.equal(h.thinking, 'medium');
  assert.equal(last(h), 'Model: gamma/shallow-4 (thinking: medium; xhigh is not supported by this model)');
  await h.receive('/model shallow-4 low');
  assert.equal(last(h), 'Model: gamma/shallow-4 (thinking: low)');
});

test('/model rejects usage errors, out-of-scope, ambiguous and unauthenticated targets without changing state', async t => {
  const h = await session(t);
  await h.receive('/model beta/backup-2 hyper');
  assert.match(last(h), /^Usage: \/model \[provider\/model \[thinking\]\]\nThinking levels: off, minimal/);
  await h.receive('/model a b c'); assert.match(last(h), /^Usage:/);
  await h.receive('/model unscoped/hidden'); assert.match(last(h), /not available in this session/);
  await h.receive('/model backup-2'); assert.match(last(h), /ambiguous.*beta\/backup-2, gamma\/backup-2/);
  assert.deepEqual(h.modelChanges, []);
  await h.receive('/model beta/keyless-3 high');
  assert.deepEqual(h.modelChanges, ['beta/keyless-3']); assert.deepEqual(h.thinkingChanges, []);
  assert.equal(h.currentModel.id, 'primary-1'); assert.equal(h.thinking, 'high');
  assert.equal(last(h), 'Could not switch to beta/keyless-3: no credentials configured. Model unchanged.');
  assert.equal(h.submissions.length, 0);
});

test('/model host failure is sanitized and thinking is left alone', async t => {
  const h = await harness(t, { models: catalogue, scoped, currentModel: 'alpha/primary-1', thinking: 'high', setModel: 'throw' });
  await h.receive('/model beta/backup-2 low');
  assert.equal(last(h), 'Switching to beta/backup-2 failed; inspect Pi locally.');
  assert.doesNotMatch(replies(h).join('\n'), /SECRET/);
  assert.deepEqual(h.thinkingChanges, []); assert.equal(h.errors.length, 0);
});

test('/model without scope falls back to the registry; without a model reports unknown', async t => {
  const h = await harness(t, { models: catalogue });
  await h.receive('/model');
  const text = last(h);
  assert.match(text, /^Model: unknown \(thinking: medium\)\nAvailable in this session:\n/);
  assert.doesNotMatch(text, /\(scoped\)/);
  assert.match(text, /unscoped\/hidden/); assert.doesNotMatch(text, /keyless-3/);
  await h.receive('/model unscoped/hidden xhigh');
  assert.equal(h.currentModel.id, 'hidden'); assert.equal(h.thinking, 'xhigh');
});

test('/model is a standalone control only; captions and attachments stay ordinary input', async t => {
  const h = await session(t);
  await h.receive(undefined, { caption: '/model beta/backup-2', document: { file_id: 'file', file_name: 'note.txt' } });
  await h.receive('/model beta/backup-2', { photo: [{ file_id: 'image' }] });
  assert.deepEqual(h.modelChanges, []);
  await h.receive('/MODEL@Other_Bot beta/backup-2');
  assert.deepEqual(h.modelChanges, []); assert.match(last(h), /another or unknown bot/);
});
