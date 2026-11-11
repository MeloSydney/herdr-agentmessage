/**
 * Agent Message Extension
 *
 * 在 Herdr 环境下注册五个 tool，让任何 pi agent 向其他 agent 发消息 / 读屏幕 / 取最近输入与回复：
 *   - agent_send_message(target, message)  不检查对端工作状态，默认以 steering 引导对端下一轮
 *   - agent_read(target, lines?)           读取目标 agent 终端屏幕
 *   - agent_last_reply(target)             空闲时读取最近完整问答的回复
 *   - agent_last_prompt(target)            空闲时读取最近完整问答的输入
 *   - agent_last_exchange(target)          空闲时一次读取同一轮的输入与回复
 *
 * 同时注册 agent_settled hook：agent 回复完将完整问答原子写入 /tmp/herdr-replies/<pane_id>.json。
 * 只有 idle/done 且本轮已产生完整回复才返回问答；若最新模型请求报错则自动发送一次「继续工作」并报告 kick 结果。
 * 分开读取可能跨越更新，需核对 exchange_id；需要严格配对时用 agent_last_exchange。
 *
 * 部署：源文件放 ~/src-skills/src-pi-agentmessage/agent-message.ts，
 *       各 agent 目录 extensions/ 下软链接到此文件，pi 自动加载。
 * 依赖：Herdr 环境（HERDR_ENV=1，herdr CLI 可用）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "fs";

/** 同步调用 herdr CLI，失败时抛含 stderr 的友好错误 */
function herdr(args: string[]): string {
	try {
		return execFileSync("herdr", args, {
			encoding: "utf8",
			timeout: 15000,
			maxBuffer: 2 * 1024 * 1024,
		});
	} catch (e: unknown) {
		const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
		const stderr = err.stderr?.toString("utf8").trim();
		throw new Error(
			`herdr ${args.slice(0, 3).join(" ")} 失败: ${err.message}${stderr ? `\nstderr: ${stderr}` : ""}`,
		);
	}
}

interface AgentEntry {
	name?: string;
	pane_id: string;
	agent_status: string;
	agent_session?: { value: string };
}

/** 调 herdr agent list，返回所有 agent */
function listAgents(): AgentEntry[] {
	const out = herdr(["agent", "list"]);
	const data = JSON.parse(out);
	return data?.result?.agents ?? [];
}

/** 将 target（agent 名 或 pane_id）解析为 agent 条目 */
function resolveTarget(target: string): AgentEntry {
	const agents = listAgents();
	// 先按 pane_id 精确匹配
	let found = agents.find((a) => a.pane_id === target);
	// 再按 name 匹配
	if (!found) found = agents.find((a) => a.name === target);
	if (!found) {
		const names = agents.filter((a) => a.name).map((a) => a.name).join(", ");
		throw new Error(`找不到目标 agent: ${target}（可用: ${names || "无"}）`);
	}
	return found;
}

const SEND_PARAMS = Type.Object({
	target: Type.String({
		description: "目标 agent 名称（如 daily2）或 pane_id（如 w6:p4）",
	}),
	message: Type.String({ description: "要发送的消息文本" }),
});

const READ_PARAMS = Type.Object({
	target: Type.String({
		description: "目标 agent 名称或 pane_id",
	}),
	lines: Type.Optional(
		Type.Number({ description: "读取末尾行数，默认 30" }),
	),
});

const LAST_REPLY_PARAMS = Type.Object({
	target: Type.String({
		description: "目标 agent 名称或 pane_id",
	}),
});

interface Exchange {
	session: string;
	exchange_id: string;
	prompt: { text: string; timestamp: string };
	reply: { text: string; timestamp: string };
}

/** 一次快照内，只有最近的有效 user 输入已获得最终回复才返回完整问答。 */
function extractLastExchange(sessionPath: string): Exchange | null {
	const lines = readFileSync(sessionPath, "utf8").split("\n");
	let reply: Exchange["reply"] | null = null;
	let replyIndex = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const o = JSON.parse(lines[i]) as {
				type?: string;
				timestamp?: string;
				message?: { role?: string; stopReason?: string; content?: unknown };
			};
			if (o.type !== "message") continue;
			if (o.message?.role === "user") {
				const content = o.message.content;
				let text = typeof content === "string" ? content :
					Array.isArray(content) ? content.find((p: { type?: string; text?: string }) =>
						p.type === "text" && typeof p.text === "string" && p.text.trim())?.text : undefined;
				if (typeof text !== "string") continue;
				text = text.replace(/^<acp\b[^>]*>m\d+<\/acp>\s*/, "");
				if (!text.trim() || /^\[acp_delegate\s/.test(text.trim())) continue;
				// 最新输入比最后一条完成的回复还新：本轮尚无输出，不能返回旧问答。
				if (!reply) return null;
				return {
					session: sessionPath,
					exchange_id: createHash("sha256").update(`${sessionPath}\0${replyIndex}\0${reply.timestamp}`).digest("hex"),
					prompt: { text, timestamp: o.timestamp ?? "" },
					reply,
				};
			}
			if (!reply && o.message?.role === "assistant" &&
				["stop", "end_turn"].includes(o.message.stopReason ?? "")) {
				const parts = o.message.content;
				if (!Array.isArray(parts)) continue;
				const text = parts.filter((p: { type?: string; text?: string }) =>
					p.type === "text" && typeof p.text === "string").map((p: { text: string }) => p.text).join("");
				if (!text.trim()) continue;
				reply = { text, timestamp: o.timestamp ?? "" };
				replyIndex = i;
			}
		} catch {
			continue;
		}
	}
	return null;
}

/** 仅识别最新有效输入之后、最后一条 assistant 明确报错的中断。 */
type ModelInterruption = { timestamp: string; message: string; index: number };

function extractLastModelError(sessionPath: string): ModelInterruption | null {
	const lines = readFileSync(sessionPath, "utf8").split("\n");
	let error: ModelInterruption | null = null;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const o = JSON.parse(lines[i]) as {
				type?: string;
				timestamp?: string;
				message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown };
			};
			if (o.type !== "message") continue;
			if (o.message?.role === "assistant" && !error) {
				if (o.message.stopReason !== "error") return null;
				error = { timestamp: o.timestamp ?? "", message: (o.message.errorMessage || "未知模型错误").slice(0, 300), index: i };
			}
			if (o.message?.role === "user") {
				const content = o.message.content;
				let text = typeof content === "string" ? content :
					Array.isArray(content) ? content.find((p: { type?: string; text?: string }) =>
						p.type === "text" && typeof p.text === "string" && p.text.trim())?.text : undefined;
				if (typeof text !== "string") continue;
				text = text.replace(/^<acp\b[^>]*>m\d+<\/acp>\s*/, "");
				if (!text.trim() || /^\[acp_delegate\s/.test(text.trim())) continue;
				return error;
			}
		} catch {
			continue;
		}
	}
	return null;
}

/** 回复缓存目录：agent_settled 时自动写入，controller 直接读取 */
const REPLY_CACHE_DIR = "/tmp/herdr-replies";

function replyCachePath(paneId: string): string {
	// pane_id 含 ':' (如 w6:p4)，替换为 '_' 避免路径问题
	return `${REPLY_CACHE_DIR}/${paneId.replace(/:/g, "_")}.json`;
}

/** agent_settled 时将完整问答原子写入缓存；旧格式缓存将由读取端拒绝。 */
function writeReplyCache(paneId: string, sessionPath: string): void {
	let tmp: string | undefined;
	try {
		const exchange = extractLastExchange(sessionPath);
		if (!exchange) return;
		mkdirSync(REPLY_CACHE_DIR, { recursive: true, mode: 0o700 });
		tmp = `${replyCachePath(paneId)}.${randomUUID()}.tmp`;
		writeFileSync(tmp, JSON.stringify({ pane_id: paneId, ...exchange, cached_at: new Date().toISOString() }), { mode: 0o600 });
		renameSync(tmp, replyCachePath(paneId));
	} catch {
		if (tmp) rmSync(tmp, { force: true });
		// best-effort，不阻断 agent
	}
}

function readReplyCache(paneId: string, sessionPath: string): Exchange | null {
	try {
		const record = JSON.parse(readFileSync(replyCachePath(paneId), "utf8")) as Record<string, unknown>;
		if (record.pane_id !== paneId || record.session !== sessionPath ||
			typeof record.exchange_id !== "string" || !record.exchange_id ||
			!record.prompt || !record.reply) return null;
		const prompt = record.prompt as Exchange["prompt"];
		const reply = record.reply as Exchange["reply"];
		if (typeof prompt.text !== "string" || !prompt.text.trim() ||
			typeof reply.text !== "string" || !reply.text.trim() ||
			typeof prompt.timestamp !== "string" || typeof reply.timestamp !== "string") return null;
		return record as unknown as Exchange;
	} catch {
		return null;
	}
}

type KickResult = { state: "sent" | "already_sent" | "pending" | "not_idle" | "self" | "failed"; error?: string };

/** 每条模型错误最多自动提交一次；并发查询用 wx 原子占位，送达不确定时不盲目重发。 */
function kickModelError(agent: AgentEntry, sessionPath: string, interruption: ModelInterruption): KickResult {
	if (agent.pane_id === process.env.HERDR_PANE_ID) return { state: "self" };
	const hash = createHash("sha256").update(`${sessionPath}\0${interruption.index}\0${interruption.timestamp}\0${interruption.message}`).digest("hex");
	const marker = `${REPLY_CACHE_DIR}/${agent.pane_id.replace(/[^a-zA-Z0-9_-]/g, "_")}.kick-${hash}.json`;
	try {
		mkdirSync(REPLY_CACHE_DIR, { recursive: true, mode: 0o700 });
		writeFileSync(marker, JSON.stringify({ state: "pending" }), { flag: "wx", mode: 0o600 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { state: "failed", error: String(e) };
		try {
			return JSON.parse(readFileSync(marker, "utf8")).state === "sent"
				? { state: "already_sent" } : { state: "pending" };
		} catch {
			return { state: "pending" }; // 占位仍在，不能冒险重复发送
		}
	}
	try {
		const fresh = resolveTarget(agent.pane_id);
		const latest = extractLastModelError(sessionPath);
		if (!["idle", "done"].includes(fresh.agent_status) || fresh.agent_session?.value !== sessionPath ||
			latest?.index !== interruption.index || latest?.timestamp !== interruption.timestamp || latest?.message !== interruption.message) {
			rmSync(marker, { force: true });
			return { state: "not_idle" };
		}
	} catch (e) {
		rmSync(marker, { force: true });
		return { state: "failed", error: String(e) };
	}
	try {
		herdr(["pane", "send-text", agent.pane_id, "继续工作"]);
		herdr(["pane", "send-keys", agent.pane_id, "Enter"]);
		writeFileSync(marker, JSON.stringify({ state: "sent" }), { mode: 0o600 });
		return { state: "sent" };
	} catch (e) {
		// CLI 报错不代表文本没写进终端；保留标记，后续需人工核对，避免重复输入。
		try { writeFileSync(marker, JSON.stringify({ state: "uncertain" }), { mode: 0o600 }); } catch { /* 保留原占位 */ }
		return { state: "failed", error: String(e) };
	}
}

function lastExchangeResult(target: string, field: "prompt" | "reply" | "both") {
	try {
		const agent = resolveTarget(target);
		const name = agent.name || target;
		const statusResult = (interruption?: { timestamp: string; message: string }, kick?: KickResult) => {
			const action = kick?.state === "sent" ? "agent 状态异常，已发送「继续工作」，已经 kick" :
				kick?.state === "already_sent" ? "agent 状态异常，该次错误已经 kick，未重复发送" :
				kick?.state === "pending" ? "agent 状态异常，kick 送达尚未确认，未重复发送；请人工核对" :
				kick?.state === "not_idle" ? "agent 状态异常，但会话或状态已变化，未 kick" :
				kick?.state === "self" ? "agent 状态异常，不能给自己发送 kick" :
				`agent 状态异常，kick 失败：${kick?.error ?? "未知错误"}`;
			return {
				content: [{ type: "text" as const, text: interruption
					? `${name} 当前状态：${agent.agent_status}（本轮模型请求报错中断：${interruption.message}；${action}；尚无完整输出）`
					: agent.agent_status === "working" ? `${name} 正在工作`
					: `${name} 当前状态：${agent.agent_status}（暂无本轮完整输入和输出）` }],
				details: { target, resolved: name, pane_id: agent.pane_id, status: agent.agent_status,
					...(interruption ? { interruption: "model_error", error_message: interruption.message,
						error_timestamp: interruption.timestamp, kick_state: kick?.state, kicked: kick?.state === "sent" || kick?.state === "already_sent" } : {}) },
			};
		};
		if (agent.agent_status !== "idle" && agent.agent_status !== "done") return statusResult();
		const sessionPath = agent.agent_session?.value;
		if (!sessionPath) return statusResult();
		let current: Exchange | null;
		try {
			const interruption = extractLastModelError(sessionPath);
			if (interruption) return statusResult(interruption, kickModelError(agent, sessionPath, interruption));
			current = extractLastExchange(sessionPath);
		} catch {
			return statusResult();
		}
		if (!current) return statusResult();
		const cached = readReplyCache(agent.pane_id, sessionPath);
		const exchange = cached?.exchange_id === current.exchange_id ? cached : current;
		const text = field === "both"
			? `Agent：${name}\n\n### 最近一轮输入（${exchange.prompt.timestamp}）\n${exchange.prompt.text}\n\n---\n\n### 最新回复（${exchange.reply.timestamp}）\n${exchange.reply.text}`
			: `Agent：${name}\n\n### ${field === "prompt" ? "最近一轮输入" : "最新回复"}（${exchange[field].timestamp}）\n${exchange[field].text}\n\n问答 ID：${exchange.exchange_id}`;
		return {
			content: [{ type: "text" as const, text }],
			details: { target, resolved: name, pane_id: agent.pane_id, session: sessionPath,
				exchange_id: exchange.exchange_id, timestamp: exchange[field === "both" ? "reply" : field].timestamp,
				source: exchange === cached ? "cache" : "session" },
		};
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `获取问答失败：${error instanceof Error ? error.message : String(error)}` }],
			details: { target, error: String(error) },
		};
	}
}

export default function agentMessageExtension(pi: ExtensionAPI): void {
	// 仅在 Herdr 环境下注册
	if (process.env.HERDR_ENV !== "1") return;

	// agent_settled 时自动将最近回复写入缓存文件，供 controller 直接读取
	pi.on("agent_settled", (_event, ctx) => {
		const paneId = process.env.HERDR_PANE_ID;
		if (!paneId) return;
		try {
			const sessionPath = ctx?.sessionManager?.getSessionFile?.();
			if (typeof sessionPath === "string" && sessionPath) {
				writeReplyCache(paneId, sessionPath);
			}
		} catch {
			// best-effort
		}
	});

	pi.registerTool({
		name: "agent_send_message",
		label: "向其他 Agent 发消息",
		description:
			"向另一个 Herdr 管理的 pi agent 投递消息。不检查对端工作状态；文本提交后使用 Enter 作为 steering，引导对端当前回复结束后的下一轮。输入发送成功不代表已处理。",
		promptSnippet: "向指定 agent 投递消息（steering，不检查对端工作状态）",
		promptGuidelines: [
			"用 agent_send_message 向其他 agent 发消息；target 填 agent 名(如 daily2)或 pane_id(如 w6:p4)。",
			"agent_send_message 始终以 steering 提交，不需要也不应等待或判断对端 idle/working。",
			"投递成功只表示文本和提交键已送达目标输入区，不代表对方已处理；需要结果时稍后用 agent_read 查看。",
		],
		parameters: SEND_PARAMS,
		async execute(_toolCallId, params) {
			const target = params.target;
			const selfPaneId = process.env.HERDR_PANE_ID;
			let textSent = false;
			try {
				const t = resolveTarget(target);
				if (selfPaneId && t.pane_id === selfPaneId) {
					return {
						content: [
							{
								type: "text" as const,
								text: `不能给自己发消息（${target} 即当前 agent ${t.pane_id}）`,
							},
						],
						details: { target, pane_id: t.pane_id, sent: false, reason: "self" },
					};
				}
				herdr(["pane", "send-text", t.pane_id, params.message]);
				textSent = true;
				// Enter 是 Pi 的 steering 提交；不读取/等待 agent_status。
				herdr(["pane", "send-keys", t.pane_id, "Enter"]);
				return {
					content: [
						{
							type: "text" as const,
							text: `已向 ${t.name || target}（${t.pane_id}）发送文本和 steering 提交键；是否已进入当前回复后的下一轮、何时处理尚未确认。`,
						},
					],
					details: {
						target,
						resolved: t.name || target,
						pane_id: t.pane_id,
						mode: "steering",
						sent: true,
					},
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: textSent
								? `投递未确认：文本已写入，但提交键失败；请检查目标编辑区，勿盲目重发。${e instanceof Error ? e.message : String(e)}`
								: `发送失败：${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { target, sent: false, reason: textSent ? "submission_uncertain" : "failed", error: String(e) },
				};
			}
		},
	});

	pi.registerTool({
		name: "agent_read",
		label: "读取其他 Agent 屏幕",
		description:
			"读取另一个 Herdr 管理的 agent 的终端屏幕内容，用于获取对方回复或观察其状态。",
		promptSnippet: "读取指定 agent 的终端屏幕内容",
		promptGuidelines: [
			"用 agent_read 读取目标 agent 屏幕获取回复；target 填 agent 名或 pane_id。",
			"发送消息后等待几秒再 read，给对方处理时间。",
		],
		parameters: READ_PARAMS,
		async execute(_toolCallId, params) {
			const target = params.target;
			try {
				const t = resolveTarget(target);
				const lines = params.lines ?? 30;
				const out = herdr([
					"pane",
					"read",
					t.pane_id,
					"--lines",
					String(lines),
					"--format",
					"text",
				]);
				return {
					content: [
						{
							type: "text" as const,
							text: out,
						},
					],
					details: {
						target,
						resolved: t.name || target,
						pane_id: t.pane_id,
						lines,
					},
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `读取失败：${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { target, error: String(e) },
				};
			}
		},
	});

	pi.registerTool({
		name: "agent_last_reply",
		label: "获取其他 Agent 最近回复",
		description: "仅在目标 idle/done 且本轮有完整输出时返回回复；检测到模型错误中断会自动发送一次「继续工作」kick 并报告结果。与 agent_last_prompt 的 exchange_id 相同才可配对。严格配对请用 agent_last_exchange。",
		promptSnippet: "获取最近完整问答的回复（检查 exchange_id）",
		promptGuidelines: [
			"与 agent_last_prompt 分开调用时，必须核对两者 exchange_id；不同则重读，不可混用。",
			"需要一次获取配对的输入和回复时，直接用 agent_last_exchange。",
			"检测到 model_error 时工具已自动 kick，勿重复发送；按 kick_state 报告是否成功。",
		],
		parameters: LAST_REPLY_PARAMS,
		async execute(_toolCallId, params) {
			return lastExchangeResult(params.target, "reply");
		},
	});

	pi.registerTool({
		name: "agent_last_prompt",
		label: "获取其他 Agent 最近输入",
		description: "仅在目标 idle/done 且本轮有完整输出时返回输入；检测到模型错误中断会自动发送一次「继续工作」kick 并报告结果。与 agent_last_reply 的 exchange_id 相同才可配对。严格配对请用 agent_last_exchange。",
		promptSnippet: "获取最近完整问答的输入（检查 exchange_id）",
		promptGuidelines: [
			"与 agent_last_reply 分开调用时，必须核对两者 exchange_id；不同则重读，不可混用。",
			"需要一次获取配对的输入和回复时，直接用 agent_last_exchange。",
			"检测到 model_error 时工具已自动 kick，勿重复发送；按 kick_state 报告是否成功。",
		],
		parameters: LAST_REPLY_PARAMS,
		async execute(_toolCallId, params) {
			return lastExchangeResult(params.target, "prompt");
		},
	});

	pi.registerTool({
		name: "agent_last_exchange",
		label: "获取其他 Agent 最近完整问答",
		description: "仅在目标 idle/done 且本轮有完整输出时一次返回配对输入和回复；检测到当前模型报错中断会自动发送一次「继续工作」kick，并报告是否成功；其余情况只报告状态。",
		promptSnippet: "一次读取目标 agent 最近一轮输入与回复",
		promptGuidelines: ["需要输入和输出严格配对时优先使用此工具。", "检测到 model_error 时工具会自动 kick，无需再调用 agent_send_message；以返回的 kick_state 为准告知用户是否已 kick。"],
		parameters: LAST_REPLY_PARAMS,
		async execute(_toolCallId, params) {
			return lastExchangeResult(params.target, "both");
		},
	});
}
