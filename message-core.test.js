import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send, request, reply, requestStatus, waitRequest, recoverClaim } from './message-core.js';
import ompExtension from './agent-message-command.js';


const root = mkdtempSync(join(tmpdir(), 'herdr-message-test-'));
const bin = join(root, 'herdr');
writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.join(' ') === 'agent list') {
  console.log(JSON.stringify({result:{agents:[
    {name:'one',pane_id:'p1',agent_status:'idle',agent_session:{value:process.env.HERDR_TEST_SENDER_SESSION || 'session-one'}},
    {name:'two',pane_id:'p2',agent_status:'idle',agent_session:{value:process.env.HERDR_TEST_RECIPIENT_SESSION || 'session-two'}}
  ]}}));
} else {
  fs.appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args)+'\\n');
  if (process.env.HERDR_TEST_FAIL === '1') process.exit(1);
}
`);
chmodSync(bin, 0o700);
process.env.PATH = `${root}:${process.env.PATH}`;
process.env.HERDR_ENV = '1';
process.env.HERDR_PANE_ID = 'p1';
process.env.HERDR_MESSAGE_STORE = join(root, 'records');
process.env.HERDR_TEST_LOG = join(root, 'calls');
const calls = () => readFileSync(process.env.HERDR_TEST_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
test.after(() => { rmSync(root, { recursive: true, force: true }); });
test('slash request waits for its own durable result and prints the outcome', async () => {
  let handler;
  const notices = [];
  ompExtension({ registerTool() {}, registerCommand(_name, command) { handler = command.handler; } });
  for (const input of ['request 询问 two 当前时间', '询问 two 当前时间', 'request two 当前时间']) {
    const pending = handler(input, { ui: { notify(text, level) { notices.push({ text, level }); } } });
    const submitted = calls().at(-1);
    assert.deepEqual(submitted.slice(0, 3), ['agent', 'prompt', 'p2']);
    assert.match(submitted[3], /\n当前时间\n\nWhen finished/);
    const id = submitted[3].match(/\[Herdr request ([\da-f-]+)\]/)[1];
    process.env.HERDR_PANE_ID = 'p2';
    reply(id, 'completed', '现在 12:34');
    process.env.HERDR_PANE_ID = 'p1';
    await pending;
    assert.deepEqual(notices.at(-1), { text: `Request ${id} — completed: 现在 12:34`, level: undefined });
  }
});

test('slash timeout reports request ID and status path without resending', async () => {
  let handler;
  const notices = [];
  ompExtension({ registerTool() {}, registerCommand(_name, command) { handler = command.handler; } }, id =>
    waitRequest(id, { setTimer(callback) { queueMicrotask(callback); return 1; }, clearTimer() {} }));
  const before = calls().length;
  await handler('询问 two 当前时间', { ui: { notify(text) { notices.push(text); } } });
  const submitted = calls().at(-1);
  const id = submitted[3].match(/\[Herdr request ([\da-f-]+)\]/)[1];
  assert.equal(calls().length, before + 1);
  assert.match(notices[0], new RegExp(`Request ${id}.*Timed out.*status ${id}`));
  assert.match(notices[0], /do not resend automatically/);
  assert.equal(requestStatus(id).result, null);
  process.env.HERDR_PANE_ID = 'p2';
  reply(id, 'completed', 'late answer');
  process.env.HERDR_PANE_ID = 'p1';
  assert.equal(requestStatus(id).result.text, 'late answer');
  assert.equal(calls().length, before + 2);
});


test('fire-and-forget submits the task without requesting feedback', () => {
  assert.equal(send('two', 'hello').state, 'submitted');
  assert.deepEqual(calls().at(-1).slice(0, 3), ['agent', 'prompt', 'p2']);
  assert.match(calls().at(-1)[3], /hello\nNo reply or completion feedback is requested\./);
});

test('request persists result before callback; duplicate feedback never sends twice', () => {
  const initial = calls().length;
  const sent = request('two', 'do work');
  assert.equal(sent.state, 'submitted');
  assert.match(calls().at(-1)[3], new RegExp(sent.request_id));
  process.env.HERDR_PANE_ID = 'p2';
  assert.throws(() => requestStatus(sent.request_id), /original sender/);
  const answer = reply(sent.request_id, 'completed', 'done');
  assert.equal(answer.callback, 'submitted');
  assert.deepEqual(answer.result.outcome, 'completed');
  assert.equal(reply(sent.request_id, 'failed', 'conflict').duplicate, true);
  assert.equal(calls().length, initial + 2);
  process.env.HERDR_PANE_ID = 'p1';
  assert.equal(requestStatus(sent.request_id).result.text, 'done');
});

test('ambiguous submissions persist uncertainty, never automatically retry', () => {
  process.env.HERDR_TEST_FAIL = '1';
  const sent = request('two', 'uncertain work');
  assert.equal(sent.state, 'uncertain');
  assert.equal(requestStatus(sent.request_id).state, 'uncertain');
  const count = calls().length;
  requestStatus(sent.request_id);
  assert.equal(calls().length, count);
  process.env.HERDR_TEST_FAIL = '0';
});
test('session turnover rejects stale feedback and status readers', () => {
  const sent = request('two', 'identity');
  process.env.HERDR_PANE_ID = 'p2';
  process.env.HERDR_TEST_RECIPIENT_SESSION = 'new-recipient';
  assert.throws(() => reply(sent.request_id, 'completed', 'wrong session'), /original recipient session/);
  delete process.env.HERDR_TEST_RECIPIENT_SESSION;
  process.env.HERDR_PANE_ID = 'p1';
  process.env.HERDR_TEST_SENDER_SESSION = 'new-sender';
  assert.throws(() => requestStatus(sent.request_id), /original sender session/);
  delete process.env.HERDR_TEST_SENDER_SESSION;
});


test('exclusive reply claim rejects concurrent writer without resubmission', () => {
  const sent = request('two', 'claim me');
  writeFileSync(join(root, 'records', `${sent.request_id}.json.lock`), '', { flag: 'wx' });
  process.env.HERDR_PANE_ID = 'p2';
  const count = calls().length;
  assert.throws(() => reply(sent.request_id, 'blocked', 'waiting'), /in progress/);
  assert.equal(calls().length, count);
  process.env.HERDR_PANE_ID = 'p1';
});
test('abandoned claim releases without resubmitting', () => {
  const sent = request('two', 'recover');
  const claim = join(root, 'records', `${sent.request_id}.json.lock`);
  writeFileSync(claim, JSON.stringify({ pid: 2147483647 }), { flag: 'wx', mode: 0o600 });
  const count = calls().length;
  assert.equal(recoverClaim(sent.request_id).state, 'submitted');
  assert.equal(calls().length, count);
});


