import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, until } from './harness.mjs';

const reaction = (id, messageId, fromId, oldR, newR, chatType = 'private') => ({
  update_id: id,
  message_reaction: { chat: { id: 70, type: chatType }, message_id: messageId, user: { id: fromId, is_bot: false, first_name: 'o' }, date: 1790450000,
    old_reaction: oldR.map(emoji => ({ type: 'emoji', emoji })), new_reaction: newR.map(emoji => ({ type: 'emoji', emoji })) },
});
const polled = h => h.network.filter(n => n.method === 'getUpdates' && n.body.timeout > 0);

test('polling asks Telegram for reactions', async t => {
  const h = await harness(t);
  await until(() => h.polling);
  assert.ok(polled(h).at(-1).body.allowed_updates.includes('message_reaction'));
});

test("the owner's reaction to a reply becomes a stored feedback message, not a turn", async t => {
  const h = await harness(t);
  await h.receive('question'); await h.start(); await h.end('**Here** is the answer'); await h.settle();
  const sentIndex = h.network.findIndex(n => n.method === 'sendMessage');
  assert.ok(sentIndex >= 0, 'reply sent');
  const messageId = sentIndex + 1; // the fake API's message_id is the network log length at send time
  await until(() => h.polling);
  const turns = h.sent.length;
  h.deliver(reaction(100, messageId, 7, [], ['👎']));
  await until(() => h.customMessages.length === 1);
  const { message, opts } = h.customMessages[0];
  assert.equal(message.customType, 'telegram-reaction');
  assert.match(message.content, /reacted 👎 to your reply "Here is the answer"/);
  assert.equal(message.details.matched, true);
  assert.deepEqual(opts, { triggerTurn: false, deliverAs: 'nextTurn' });
  assert.equal(h.sent.length, turns, 'no new user turn');
});

test('only additions by the paired user in a private chat count', async t => {
  const h = await harness(t);
  await until(() => h.polling);
  h.deliver(reaction(101, 5, 8, [], ['👍'])); await until(() => h.polling);
  h.deliver(reaction(102, 5, 7, ['👍'], [])); await until(() => h.polling);
  h.deliver(reaction(103, 5, 7, [], ['👍'], 'group')); await until(() => h.polling);
  assert.equal(h.customMessages.length, 0);
  h.deliver(reaction(104, 5, 7, ['👍'], ['👍', '🔥'])); await until(() => h.customMessages.length === 1);
  assert.match(h.customMessages[0].message.content, /reacted 🔥 to your Telegram message 5/);
  assert.equal(h.customMessages[0].message.details.matched, false);
});
