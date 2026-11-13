import { agents, send, request, reply, requestStatus, waitRequest, recoverClaim, readScreen, lastExchange } from './message-core.js';

export default function ompExtension(pi, waitForRequest = waitRequest) {
  if (process.env.HERDR_ENV !== '1') return;
  const register = (name, description, parameters, action) => pi.registerTool({
    name, label: description, description, parameters,
    async execute(_call, params) {
      try {
        const value = action(params);
        return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: value };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], details: { error: String(error) }, isError: true };
      }
    },
  });
  const text = { type: 'object', properties: { target: { type: 'string' }, message: { type: 'string' } }, required: ['target', 'message'] };
  const target = { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] };
  register('agent_send_message', 'Fire-and-forget Herdr message; submission does not mean completion', text, p => send(p.target, p.message));
  register('agent_request', 'Submit a request with durable request_id; recipient must call agent_reply', text, p => request(p.target, p.message));
  register('agent_reply', 'Reply to a received request with completed, failed or blocked outcome and concrete result', { type: 'object', properties: { request_id: { type: 'string' }, outcome: { type: 'string', enum: ['completed', 'failed', 'blocked'] }, result: { type: 'string' } }, required: ['request_id', 'outcome', 'result'] }, p => reply(p.request_id, p.outcome, p.result));
  register('agent_request_status', 'Read durable outcome by request_id without submitting anything', { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'] }, p => requestStatus(p.request_id));
  register('agent_recover_claim', 'Release a claim held by a confirmed dead process; does not resubmit', { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'] }, p => recoverClaim(p.request_id));
  register('agent_read', 'Read screen without sending anything', { type: 'object', properties: { target: { type: 'string' }, lines: { type: 'integer' } }, required: ['target'] }, p => readScreen(p.target, p.lines));
  register('agent_last_exchange', 'Read latest complete exchange without sending anything', target, p => lastExchange(p.target));
  register('agent_last_prompt', 'Read latest complete prompt without sending anything', target, p => lastExchange(p.target, 'prompt'));
  register('agent_last_reply', 'Read latest complete reply without sending anything', target, p => lastExchange(p.target, 'reply'));
  const usage = 'list | send [通知] <target> <text> | request [询问|请|让] <target> <text> | 询问 <target> <text> | status <request_id> | recover <request_id> | reply <request_id> <completed|failed|blocked> <result> | read <target> [lines] | exchange|prompt|last-reply <target>';
  pi.registerCommand('agent-message', {
    description: 'Herdr messaging, requests, explicit outcomes and read-only observations',
    argumentHint: usage,
    async handler(args, ctx) {
      const words = (args || '').trim().split(/\s+/);
      const [command, first, second] = words;
      const requestWords = words.slice(1);
      if (['询问', '请', '让', '通知'].includes(requestWords[0])) requestWords.shift();
      try {
        let value;
        switch (command) {
          case 'list': value = agents().map(a => `${a.name || '?'} ${a.pane_id} ${a.agent_status}`).join('\n'); break;
          case 'send': value = send(requestWords[0], requestWords.slice(1).join(' ')); break;
          case 'request':
          case '询问': {
            const submitted = request(requestWords[0], requestWords.slice(1).join(' '));
            try {
              const status = await waitForRequest(submitted.request_id);
              value = `Request ${submitted.request_id} — ${status.result.outcome}: ${status.result.text}`;
            } catch (error) {
              value = `Request ${submitted.request_id} (${submitted.state}): ${String(error)}. Check later with /agent-message status ${submitted.request_id}; do not resend automatically.`;
            }
            break;
          }
          case 'status': value = requestStatus(first); break;
          case 'recover': value = recoverClaim(first); break;
          case 'reply': value = reply(first, second, (args || '').trim().split(/\s+/).slice(3).join(' ')); break;
          case 'read': value = readScreen(first, second === undefined ? 30 : Number(second)); break;
          case 'exchange': value = lastExchange(first); break;
          case 'prompt': value = lastExchange(first, 'prompt'); break;
          case 'last-reply': value = lastExchange(first, 'reply'); break;
          default: value = usage;
        }
        ctx.ui.notify(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      } catch (error) { ctx.ui.notify(String(error), 'error'); }
    },
  });
}
