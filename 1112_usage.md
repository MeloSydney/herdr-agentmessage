# Herdr agent messaging

Install `agent-message.ts` in Pi extensions and `agent-message-command.js` in OMP extensions (the existing symlinks target these files). Both import `message-core.js` from this repository; keep the three files together. Restart the agent session after installing an extension. Tools and the OMP `/agent-message` command register only when `HERDR_ENV=1`; messaging additionally requires `HERDR_PANE_ID` and a current Herdr session identity.

## Two modes

- `agent_send_message(target, message)` / `/agent-message send <target> <text>`: fire-and-forget. Its envelope explicitly asks the recipient not to send feedback. A successful single `herdr agent prompt` invocation means submission only, not execution or receipt acknowledgement.
- `agent_request(target, message)` (model tool): returns a UUID `request_id` and submission state immediately. The recipient must call `agent_reply(request_id, outcome, result)` with `completed`, `failed`, or `blocked` and a concrete result. The model retrieves the durable outcome with `agent_request_status(request_id)`; it does not wait in the tool call.
- `/agent-message request <target> <text>` and `/agent-message 询问 <target> <text>` (OMP user command): submit once, then wait up to two minutes for that request ID's durable result. The command displays `Request <id> — <outcome>: <result>` when answered, including failed/blocked outcomes. On timeout or watcher/status error it displays the ID and `/agent-message status <id>` instructions; no automatic resubmission occurs. OMP also provides `/agent-message reply <id> <outcome> <result>` for manual use. Status by ID remains authoritative.
The OMP command also accepts a verb before the target: `/agent-message request 询问 dingbot 当前时间` and `/agent-message 询问 dingbot 当前时间` both request feedback from `dingbot` about `当前时间`. `/agent-message request dingbot 当前时间` remains valid; `/agent-message send 通知 dingbot 更新报告` sends without feedback. The target must be a Herdr agent name or pane ID, not free-form prose.
The recipient's best-effort callback is preserved even when the command times out: a late result can still arrive, and `/agent-message status <id>` retrieves it. If the callback also reaches the sender after the awaited command printed the result, it is a duplicate notification for the **same request ID**, not another submission; match the IDs rather than treating it as new work.



Submission states `submitted` and `uncertain` do not imply the recipient completed work. `uncertain` includes CLI failures that may have delivered the prompt: inspect the recipient; **do not blindly retry**. One request ID is never automatically resubmitted. Duplicate replies return the first persisted outcome and never issue another callback. An exclusive per-request claim prevents concurrent reply writers. If a reply was persisted but callback submission failed, the outcome remains retrievable by ID; callback status may be `uncertain`, `sender_unavailable`, or `sender_session_changed`. No retry is automatic.
After a process crash, a claim may remain. A participant can call `agent_recover_claim(request_id)` or `/agent-message recover <id>` **only after confirming its owning process has exited**. Recovery checks the recorded PID and participant session, changes an interrupted `submitting` record to `uncertain`, and releases the claim; it never retries a prompt or callback. A live or unidentifiable owner is rejected. Concurrent manual recovery of the same abandoned claim should be avoided.


Records live in a private per-user `~/.local/state/herdr-agent-message` directory (override with `HERDR_MESSAGE_STORE` for isolated tests); owner and permissions are checked. Sender and recipient pane and session are bound at request creation: only the original recipient session may answer, and only the original sender session may retrieve status. Session turnover requires a new request. The local account can read its records; this is not a cross-OS-user authorization system. Do not put secrets in messages if the target session or local account is untrusted.

`agent_read`, `agent_last_exchange`, `agent_last_prompt`, `agent_last_reply` and `/agent-message read|exchange|prompt|last-reply` are observation-only. They never kick an interrupted model, submit another prompt, or guarantee request completion. Use status by ID for request results; a recent exchange can be unrelated.

Verification: run `node --test message-core.test.js` from this repository. Tests use a fake Herdr executable and isolated record directory; no real agent is contacted.
