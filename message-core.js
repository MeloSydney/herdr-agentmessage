import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function herdr(args) {
  if (process.env.HERDR_ENV !== '1') throw new Error('HERDR_ENV != 1');
  try {
    return execFileSync('herdr', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`herdr ${args.slice(0, 3).join(' ')} failed: ${error.message}${error.stderr ? `; ${String(error.stderr).trim()}` : ''}`);
  }
}

export function agents() {
  const entries = JSON.parse(herdr(['agent', 'list']))?.result?.agents;
  if (!Array.isArray(entries)) throw new Error('Invalid herdr agent list');
  return entries;
}

export function resolve(target) {
  const found = agents().find(a => a.pane_id === target || a.name === target);
  if (!found?.pane_id) throw new Error(`Unknown Herdr agent: ${target}`);
  return found;
}

function self() {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) throw new Error('HERDR_PANE_ID is required for messaging identity');
  const agent = resolve(pane);
  const session = agent.agent_session?.value;
  if (!session) throw new Error('Current agent has no session identity');
  return { pane, session, name: agent.name || pane };
}

function directory() {
  const base = process.env.HERDR_MESSAGE_STORE || join(homedir(), '.local', 'state', 'herdr-agent-message');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = lstatSync(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error(`Unsafe message store permissions: ${base}`);
  return base;
}

function file(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid request ID');
  return join(directory(), `${id}.json`);
}

function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function load(id) {
  const path = file(id);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Unsafe request record');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.id !== id || !record.sender?.pane || !record.sender?.session || !record.recipient?.pane || !record.recipient?.session) throw new Error('Invalid request record');
  return record;
}

function lock(id) {
  const path = `${file(id)}.lock`;
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); }
    finally { closeSync(fd); }
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Request operation in progress; inspect status, do not retry submission');
    throw error;
  }
  return () => unlinkSync(path);
}

// Explicit repair only: never retry a possibly delivered prompt or callback.
export function recoverClaim(id) {
  const actor = self();
  const record = load(id);
  if (![record.sender, record.recipient].some(owner => owner.pane === actor.pane && owner.session === actor.session))
    throw new Error('Only a participant session can recover a claim');
  const path = `${file(id)}.lock`;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Unsafe claim');
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('Claim owner unknown; inspect manually');
  try { process.kill(owner.pid, 0); throw new Error('Claim owner still alive; cannot recover'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (record.state === 'submitting') {
    record.state = 'uncertain';
    record.error = 'Submission process exited before confirming delivery';
    atomic(file(id), record);
  }
  unlinkSync(path);
  return { request_id: id, state: record.state, result: record.result || null, advice: 'Inspect the target before any new request; no submission was retried' };
}

function submit(target, text) {
  // One CLI invocation submits text and Enter together; a CLI failure can still mean delivery.
  herdr(['agent', 'prompt', target, text]);
}

export function send(target, message) {
  const sender = self();
  const recipient = resolve(target);
  if (sender.pane === recipient.pane_id) throw new Error('Cannot message yourself');
  if (!message?.trim()) throw new Error('Message is empty');
  try { submit(recipient.pane_id, `[Herdr fire-and-forget] ${message}\nNo reply or completion feedback is requested.`); return { state: 'submitted', target: recipient.pane_id }; }
  catch (error) { return { state: 'uncertain', target: recipient.pane_id, error: String(error), advice: 'Inspect recipient; do not blindly resend' }; }
}

export function request(target, message) {
  const sender = self();
  const recipient = resolve(target);
  if (sender.pane === recipient.pane_id) throw new Error('Cannot request yourself');
  if (!recipient.agent_session?.value) throw new Error('Recipient has no session identity');
  if (!message?.trim()) throw new Error('Message is empty');
  const id = randomUUID();
  const path = file(id);
  const record = { id, sender, recipient: { pane: recipient.pane_id, session: recipient.agent_session.value, name: recipient.name || recipient.pane_id }, state: 'submitting', created_at: new Date().toISOString() };
  const release = lock(id);
  try {
    writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    const envelope = `[Herdr request ${id}]\nFrom: ${sender.name} (${sender.pane})\n${message}\n\nWhen finished or blocked, call agent_reply with request_id="${id}", outcome="completed" | "failed" | "blocked", and a concrete result. Do not merely send a chat message. The sender retrieves agent_request_status by this ID.`;
    try { submit(recipient.pane_id, envelope); record.state = 'submitted'; }
    catch (error) { record.state = 'uncertain'; record.error = String(error); }
    atomic(path, record);
  } finally { release(); }
  return { request_id: id, state: record.state, target: recipient.pane_id, ...(record.error ? { error: record.error, advice: 'Delivery ambiguous: inspect recipient; do not resend this request blindly' } : {}) };
}

export function reply(id, outcome, result) {
  if (!['completed', 'failed', 'blocked'].includes(outcome)) throw new Error('Invalid outcome');
  if (!result?.trim()) throw new Error('Result is empty');
  const actor = self();
  const release = lock(id);
  try {
    const record = load(id);
    if (record.recipient.pane !== actor.pane || record.recipient.session !== actor.session) throw new Error('Only the original recipient session can reply');
    if (record.result) return { request_id: id, state: record.state, duplicate: true, result: record.result };
    // Persist outcome BEFORE callback submission; callback failure never loses result.
    record.result = { outcome, text: result, at: new Date().toISOString() };
    record.state = 'answered';
    atomic(file(id), record);
    try {
      const sender = resolve(record.sender.pane);
      if (sender.agent_session?.value !== record.sender.session) {
        record.callback = 'sender_session_changed';
      } else {
        try {
          submit(sender.pane_id, `[Herdr result ${id}] ${outcome}: ${result}\nRetrieve with agent_request_status(request_id="${id}").`);
          record.callback = 'submitted';
        } catch (error) { record.callback = 'uncertain'; record.callback_error = String(error); }
      }
    } catch (error) { record.callback = 'sender_unavailable'; record.callback_error = String(error); }
    atomic(file(id), record);
    return { request_id: id, state: record.state, callback: record.callback, result: record.result, duplicate: false };
  } finally { release(); }
}

export function requestStatus(id) {
  const actor = self();
  const record = load(id);
  if (record.sender.pane !== actor.pane || record.sender.session !== actor.session) throw new Error('Only the original sender session can retrieve result');
  return { request_id: id, state: record.state, target: record.recipient, result: record.result || null, callback: record.callback || null, error: record.error || record.callback_error || null };
}

// Watch the record directory because atomic updates replace the record by rename.
// Subscribe before checking status to avoid missing a reply between those steps.
export function waitRequest(id, { timeoutMs = 120000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const name = `${id}.json`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let watcher;
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve(status);
    };
    const check = () => {
      if (settled) return;
      try {
        const status = requestStatus(id);
        if (status.result) finish(null, status);
      } catch (error) { finish(error); }
    };
    try {
      watcher = watch(directory(), (event, filename) => {
        if (event === 'rename' && (!filename || filename.toString() === name)) check();
      });
      watcher.on('error', error => finish(error));
      timer = setTimer(() => {
        check();
        if (!settled) finish(new Error(`Timed out waiting for request ${id}; retrieve later with /agent-message status ${id}`));
      }, timeoutMs);
      check();
    } catch (error) { finish(error); }
  });
}

export function readScreen(target, lines = 30) {
  const agent = resolve(target);
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error('lines must be an integer from 1 to 1000');
  return herdr(['pane', 'read', agent.pane_id, '--lines', String(lines), '--format', 'text']);
}

export function lastExchange(target, field = 'both') {
  const agent = resolve(target);
  if (!['idle', 'done'].includes(agent.agent_status)) return `${agent.name || target}: ${agent.agent_status} (no completed exchange)`;
  const path = agent.agent_session?.value;
  if (!path) return 'No session file';
  const rows = readFileSync(path, 'utf8').split('\n');
  let answer = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(rows[i]); } catch { continue; }
    if (row.type !== 'message') continue;
    if (row.message?.role === 'user') {
      const content = row.message.content;
      let prompt = typeof content === 'string' ? content : Array.isArray(content) ? content.find(p => p.type === 'text' && typeof p.text === 'string' && p.text.trim())?.text : null;
      if (!prompt) continue;
      prompt = prompt.replace(/^<acp\b[^>]*>m\d+<\/acp>\s*/, '');
      if (!prompt.trim() || /^\[acp_delegate\s/.test(prompt.trim())) continue;
      if (!answer) return 'Latest exchange has no completed reply';
      const id = createHash('sha256').update(`${path}\0${answer.index}\0${answer.timestamp}`).digest('hex');
      return field === 'both' ? `Exchange ${id}\nPrompt: ${prompt}\nReply: ${answer.text}` : `Exchange ${id}\n${field === 'prompt' ? prompt : answer.text}`;
    }
    if (!answer && row.message?.role === 'assistant' && ['stop', 'end_turn'].includes(row.message.stopReason)) {
      const text = Array.isArray(row.message.content) ? row.message.content.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('') : '';
      if (text.trim()) answer = { text, timestamp: row.timestamp || '', index: i };
    }
  }
  return 'No completed exchange';
}
