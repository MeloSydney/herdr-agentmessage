import { Type } from 'typebox';
import { send, request, reply, requestStatus, recoverClaim, readScreen, lastExchange } from './message-core.js';

const target = Type.Object({ target: Type.String() });
const text = Type.Object({ target: Type.String(), message: Type.String() });
const id = Type.Object({ request_id: Type.String() });

export default function agentMessageExtension(pi) {
  if (process.env.HERDR_ENV !== '1') return;
  const register = (name, description, parameters, action) => pi.registerTool({
    name, label: description, description,
    parameters,
    async execute(_toolCallId, params) {
      try {
        const value = action(params);
        return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: value };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], details: { error: String(error) }, isError: true };
      }
    },
  });
  register('agent_send_message', 'Fire-and-forget Herdr message; submission is not completion', text, p => send(p.target, p.message));
  register('agent_request', 'Submit a Herdr request with durable request_id; recipient must call agent_reply with outcome and result', text, p => request(p.target, p.message));
  register('agent_reply', 'Reply to a received Herdr request ID. Call once on completion, failure or blockage.', Type.Object({ request_id: Type.String(), outcome: Type.Union([Type.Literal('completed'), Type.Literal('failed'), Type.Literal('blocked')]), result: Type.String() }), p => reply(p.request_id, p.outcome, p.result));
  register('agent_request_status', 'Retrieve durable result of your request by request_id; does not submit anything', id, p => requestStatus(p.request_id));
  register('agent_recover_claim', 'Explicitly release a claim held by a confirmed dead process without resubmitting', id, p => recoverClaim(p.request_id));
  register('agent_read', 'Read Herdr agent screen without sending anything', Type.Object({ target: Type.String(), lines: Type.Optional(Type.Number()) }), p => readScreen(p.target, p.lines));
  register('agent_last_exchange', 'Read latest complete exchange without sending anything', target, p => lastExchange(p.target));
  register('agent_last_prompt', 'Read latest complete prompt without sending anything', target, p => lastExchange(p.target, 'prompt'));
  register('agent_last_reply', 'Read latest complete reply without sending anything', target, p => lastExchange(p.target, 'reply'));
}
