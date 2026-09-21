import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { describeModels, parseModelSelection, resolveModelSelection, thinkingLevels, MODEL_LIST_LIMIT } from '../model-command.ts';

const replies = h => h.network.filter(n => n.method === 'sendMessage').map(n => n.body.text);
const last = h => replies(h).at(-1);
const fleet = [
  { provider: 'cliproxyapi', id: 'claude-fable-5-1' },
  { provider: 'openai-codex', id: 'gpt-6-astra' },
  { provider: 'openai-codex', id: 'gpt-6-nano', auth: false },
  { provider: 'other', id: 'gpt-6-astra' },
  { provider: 'unscoped', id: 'hidden' },
];
const scoped = ['cliproxyapi/claude-fable-5-1', 'openai-codex/gpt-6-astra', 'openai-codex/gpt-6-nano', 'other/gpt-6-astra'];
const session = t => harness(t, { models: fleet, scoped, currentModel: 'cliproxyapi/claude-fable-5-1', thinking: 'high' });

test('parse: empty shows, provider/id with optional case-insensitive thinking, otherwise invalid', () => {
  assert.equal(parseModelSelection('   '), undefined);
  assert.deepEqual(parseModelSelection('gpt-6-astra'), { model: 'gpt-6-astra' });
  assert.deepEqual(parseModelSelection('openai-codex/gpt-6-astra HIGH'), { provider: 'openai-codex', model: 'gpt-6-astra', thinking: 'high' });
  assert.deepEqual(parseModelSelection('openrouter/anthropic/claude-x'), { provider: 'openrouter', model: 'anthropic/claude-x' });
  for (const bad of ['a b c', 'openai-codex/gpt-6-astra hyper', '/x', 'p/', 'bad provider/x', 'x'.repeat(129), 'a$b', '$p/x'])
    assert.equal(parseModelSelection(bad), 'invalid', bad);
  assert.deepEqual([...thinkingLevels], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('resolve: exact id within candidates only; bare id must be unique', () => {
  const candidates = fleet.slice(0, 4).map(m => ({ ...m, auth: m.auth !== false }));
  assert.deepEqual(resolveModelSelection({ model: 'claude-fable-5-1' }, candidates).model, candidates[0]);
  assert.deepEqual(resolveModelSelection({ provider: 'other', model: 'gpt-6-astra' }, candidates).model, candidates[3]);
  assert.match(resolveModelSelection({ model: 'gpt-6-astra' }, candidates).error, /ambiguous.*openai-codex\/gpt-6-astra, other\/gpt-6-astra/);
  assert.match(resolveModelSelection({ model: 'hidden' }, candidates).error, /not available in this session/);
  assert.match(resolveModelSelection({ provider: 'cliproxyapi', model: 'gpt-6-astra' }, candidates).error, /not available/);
  assert.match(resolveModelSelection({ model: 'Claude-Fable-5-1' }, candidates).error, /not available/);
});

test('describe: marks active model and missing credentials, bounds the list', () => {
  const candidates = fleet.slice(0, 4).map(m => ({ ...m, auth: m.auth !== false }));
  const text = describeModels(candidates[1], 'high', candidates, true);
  assert.match(text, /^Model: openai-codex\/gpt-6-astra \(thinking: high\)\n.*\(scoped\)/);
  assert.match(text, /\nopenai-codex\/gpt-6-astra \(active\)\n/);
  assert.match(text, /gpt-6-nano \(no credentials\)/);
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
  assert.match(text, /^Model: cliproxyapi\/claude-fable-5-1 \(thinking: high\)/);
  assert.match(text, /cliproxyapi\/claude-fable-5-1 \(active\)/);
  assert.match(text, /openai-codex\/gpt-6-nano \(no credentials\)/);
  assert.doesNotMatch(text, /unscoped\/hidden/);
});

test('/model switches while idle, applies optional thinking, and refuses while busy', async t => {
  const h = await session(t);
  await h.receive('/model openai-codex/gpt-6-astra');
  assert.deepEqual(h.modelChanges, ['openai-codex/gpt-6-astra']); assert.deepEqual(h.thinkingChanges, []);
  assert.equal(h.currentModel.id, 'gpt-6-astra');
  assert.equal(last(h), 'Model: openai-codex/gpt-6-astra (thinking: high)');
  await h.receive('/model claude-fable-5-1 medium');
  assert.equal(h.currentModel.provider, 'cliproxyapi'); assert.deepEqual(h.thinkingChanges, ['medium']);
  assert.equal(last(h), 'Model: cliproxyapi/claude-fable-5-1 (thinking: medium)');
  await h.start('local');
  await h.receive('/model openai-codex/gpt-6-astra');
  assert.match(last(h), /Cannot switch models while pi is busy/);
  assert.equal(h.modelChanges.length, 2); assert.equal(h.currentModel.provider, 'cliproxyapi');
  assert.equal(h.submissions.length, 0); assert.equal((await h.diagnostic()).held, false);
});

test('/model rejects usage errors, out-of-scope, ambiguous and unauthenticated targets without changing state', async t => {
  const h = await session(t);
  await h.receive('/model openai-codex/gpt-6-astra hyper');
  assert.match(last(h), /^Usage: \/model \[provider\/model \[thinking\]\]\nThinking levels: off, minimal/);
  await h.receive('/model a b c'); assert.match(last(h), /^Usage:/);
  await h.receive('/model unscoped/hidden'); assert.match(last(h), /not available in this session/);
  await h.receive('/model gpt-6-astra'); assert.match(last(h), /ambiguous.*openai-codex\/gpt-6-astra, other\/gpt-6-astra/);
  assert.deepEqual(h.modelChanges, []);
  await h.receive('/model openai-codex/gpt-6-nano high');
  assert.deepEqual(h.modelChanges, ['openai-codex/gpt-6-nano']); assert.deepEqual(h.thinkingChanges, []);
  assert.equal(h.currentModel.id, 'claude-fable-5-1'); assert.equal(h.thinking, 'high');
  assert.equal(last(h), 'Could not switch to openai-codex/gpt-6-nano: no credentials configured. Model unchanged.');
  assert.equal(h.submissions.length, 0);
});

test('/model host failure is sanitized and thinking is left alone', async t => {
  const h = await harness(t, { models: fleet, scoped, currentModel: 'cliproxyapi/claude-fable-5-1', thinking: 'high', setModel: 'throw' });
  await h.receive('/model openai-codex/gpt-6-astra low');
  assert.equal(last(h), 'Switching to openai-codex/gpt-6-astra failed; inspect Pi locally.');
  assert.doesNotMatch(replies(h).join('\n'), /SECRET/);
  assert.deepEqual(h.thinkingChanges, []); assert.equal(h.errors.length, 0);
});

test('/model without scope falls back to the registry; without a model reports unknown', async t => {
  const h = await harness(t, { models: fleet });
  await h.receive('/model');
  const text = last(h);
  assert.match(text, /^Model: unknown \(thinking: medium\)\nAvailable in this session:\n/);
  assert.doesNotMatch(text, /\(scoped\)/);
  assert.match(text, /unscoped\/hidden/); assert.doesNotMatch(text, /gpt-6-nano/);
  await h.receive('/model unscoped/hidden xhigh');
  assert.equal(h.currentModel.id, 'hidden'); assert.equal(h.thinking, 'xhigh');
});

test('/model is a standalone control only; captions and attachments stay ordinary input', async t => {
  const h = await session(t);
  await h.receive(undefined, { caption: '/model openai-codex/gpt-6-astra', document: { file_id: 'file', file_name: 'note.txt' } });
  await h.receive('/model openai-codex/gpt-6-astra', { photo: [{ file_id: 'image' }] });
  assert.deepEqual(h.modelChanges, []);
  await h.receive('/MODEL@Other_Bot openai-codex/gpt-6-astra');
  assert.deepEqual(h.modelChanges, []); assert.match(last(h), /another or unknown bot/);
});
