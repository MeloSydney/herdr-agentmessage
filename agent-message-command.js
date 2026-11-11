// agent-message — native omp slash command for Herdr inter-agent communication.
// User-facing wrapper around the same herdr CLI calls as agent-message.ts tools:
//   /agent-message list                       list all herdr agents
//   /agent-message send <target> <text...>    send text + Enter (steering)
//   /agent-message read <target> [lines]      read target's terminal screen
//   /agent-message reply <target>             last complete reply
//   /agent-message prompt <target>            last complete user prompt
//   /agent-message exchange <target>          last prompt+reply pair
// <target> = agent name or pane_id (e.g. daily2 / w6:p4).
// Source lives in ~/src-skills/src-pi-agentmessage/herdr-agentmessage/;
// deploy by symlinking into ~/.omp/agent/extensions/.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const REPLY_CACHE_DIR = "/tmp/herdr-replies";

function herdr(args) {
  try {
    return execFileSync("herdr", args, {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (e) {
    const stderr = e.stderr?.toString("utf8").trim();
    throw new Error(`herdr ${args.slice(0, 3).join(" ")} 失败: ${e.message}${stderr ? `\nstderr: ${stderr}` : ""}`);
  }
}

function listAgents() {
  const data = JSON.parse(herdr(["agent", "list"]));
  return data?.result?.agents ?? [];
}

function resolveTarget(target) {
  const agents = listAgents();
  let found = agents.find((a) => a.pane_id === target);
  if (!found) found = agents.find((a) => a.name === target);
  if (!found) {
    const names = agents.map((a) => `${a.name || "?"}(${a.pane_id},${a.agent_status})`).join(", ");
    throw new Error(`找不到目标 agent: ${target}（可用: ${names || "无"}）`);
  }
  return found;
}

// Same semantics as agent-message.ts extractLastExchange: only a complete
// prompt+reply pair where the latest valid user input has a final reply.
function extractLastExchange(sessionPath) {
  const lines = readFileSync(sessionPath, "utf8").split("\n");
  let reply = null;
  let replyIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o.type !== "message") continue;
      if (o.message?.role === "user") {
        const content = o.message.content;
        let text = typeof content === "string" ? content
          : Array.isArray(content) ? content.find((p) => p.type === "text" && typeof p.text === "string" && p.text.trim())?.text
          : undefined;
        if (typeof text !== "string") continue;
        text = text.replace(/^<acp\b[^>]*>m\d+<\/acp>\s*/, "");
        if (!text.trim() || /^\[acp_delegate\s/.test(text.trim())) continue;
        if (!reply) return null; // newest input has no reply yet
        return {
          session: sessionPath,
          exchange_id: createHash("sha256").update(`${sessionPath}\0${replyIndex}\0${reply.timestamp}`).digest("hex"),
          prompt: { text, timestamp: o.timestamp ?? "" },
          reply,
        };
      }
      if (!reply && o.message?.role === "assistant" && ["stop", "end_turn"].includes(o.message.stopReason ?? "")) {
        const parts = o.message.content;
        if (!Array.isArray(parts)) continue;
        const text = parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
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

// Detect a model-error interruption after the latest valid user input.
// No auto-kick here: this is a user command, kick stays with the model tools.
function extractLastModelError(sessionPath) {
  const lines = readFileSync(sessionPath, "utf8").split("\n");
  let error = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o.type !== "message") continue;
      if (o.message?.role === "assistant" && !error) {
        if (o.message.stopReason !== "error") return null;
        error = { timestamp: o.timestamp ?? "", message: (o.message.errorMessage || "未知模型错误").slice(0, 300), index: i };
      }
      if (o.message?.role === "user") {
        const content = o.message.content;
        let text = typeof content === "string" ? content
          : Array.isArray(content) ? content.find((p) => p.type === "text" && typeof p.text === "string" && p.text.trim())?.text
          : undefined;
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

function readReplyCache(paneId, sessionPath) {
  try {
    const record = JSON.parse(readFileSync(`${REPLY_CACHE_DIR}/${paneId.replace(/:/g, "_")}.json`, "utf8"));
    if (record.pane_id !== paneId || record.session !== sessionPath ||
      typeof record.exchange_id !== "string" || !record.exchange_id ||
      !record.prompt || !record.reply) return null;
    if (typeof record.prompt.text !== "string" || !record.prompt.text.trim() ||
      typeof record.reply.text !== "string" || !record.reply.text.trim()) return null;
    return record;
  } catch {
    return null;
  }
}

function exchangeText(agent, field) {
  const name = agent.name || agent.pane_id;
  if (!["idle", "done"].includes(agent.agent_status)) {
    return `${name} 当前状态：${agent.agent_status}（非 idle/done，无完整问答可取）`;
  }
  const sessionPath = agent.agent_session?.value;
  if (!sessionPath) return `${name} 当前状态：${agent.agent_status}（无会话文件信息）`;
  const interruption = extractLastModelError(sessionPath);
  if (interruption) {
    return `${name} 本轮模型请求报错中断：${interruption.message}\n（${interruption.timestamp}；如需自动 kick「继续工作」请用 agent_last_exchange 工具，或手动 /agent-message send ${name} 继续工作）`;
  }
  const current = extractLastExchange(sessionPath);
  if (!current) return `${name} 当前状态：${agent.agent_status}（暂无本轮完整输入和输出）`;
  const cached = readReplyCache(agent.pane_id, sessionPath);
  const exchange = cached?.exchange_id === current.exchange_id ? cached : current;
  const source = exchange === cached ? "cache" : "session";
  if (field === "both") {
    return `${name}（${agent.pane_id}，来源 ${source}）\n\n### 最近一轮输入（${exchange.prompt.timestamp}）\n${exchange.prompt.text}\n\n---\n\n### 最新回复（${exchange.reply.timestamp}）\n${exchange.reply.text}`;
  }
  return `${name}（${agent.pane_id}，来源 ${source}）\n\n### ${field === "prompt" ? "最近一轮输入" : "最新回复"}（${exchange[field].timestamp}）\n${exchange[field].text}\n\n问答 ID：${exchange.exchange_id}`;
}

const USAGE = [
  "Herdr agent 间通信（用户命令版）",
  "",
  "/agent-message list                     列出所有 herdr agent（名称/pane/状态）",
  "/agent-message send <target> <文本…>     发送文本 + Enter（steering 提交）",
  "/agent-message read <target> [行数]      读取目标终端屏幕（默认 30 行）",
  "/agent-message reply <target>           最近一轮完整回复",
  "/agent-message prompt <target>          最近一轮完整输入",
  "/agent-message exchange <target>        最近一轮输入+回复（配对）",
  "",
  "<target> = agent 名（如 daily2）或 pane_id（如 w6:p4）",
].join("\n");

export default function ompExtension(pi) {
  pi.registerCommand("agent-message", {
    description: "Herdr agent 间通信：list / send / read / reply / prompt / exchange",
    argumentHint: "<list|send|read|reply|prompt|exchange> [target] [args…]",
    async handler(args, ctx) {
      const argv = (args || "").trim().split(/\s+/);
      const sub = (argv[0] || "").toLowerCase();
      const notify = (text, level = "info") => ctx.ui.notify(text, level);
      try {
        if (!sub || sub === "help") return notify(USAGE);
        if (process.env.HERDR_ENV !== "1") {
          return notify("当前不在 Herdr 环境（HERDR_ENV != 1），/agent-message 不可用", "warning");
        }
        if (sub === "list") {
          const agents = listAgents();
          if (!agents.length) return notify("herdr 里没有可见 agent");
          const rows = agents.map((a) => `• ${a.name || "(无名)"}  ${a.pane_id}  ${a.agent_status}${a.agent_session?.value ? `  ${a.agent_session.value}` : ""}`);
          return notify(`Herdr agents — ${agents.length}\n\n${rows.join("\n")}`);
        }
        const target = argv[1];
        if (!target) return notify(`缺少 <target>。用法：\n${USAGE}`, "warning");
        if (sub === "send") {
          const message = argv.slice(2).join(" ");
          if (!message) return notify("缺少消息文本：/agent-message send <target> <文本…>", "warning");
          const t = resolveTarget(target);
          if (process.env.HERDR_PANE_ID && t.pane_id === process.env.HERDR_PANE_ID) {
            return notify(`不能给自己发消息（${target} 即当前 pane ${t.pane_id}）`, "warning");
          }
          herdr(["pane", "send-text", t.pane_id, message]);
          herdr(["pane", "send-keys", t.pane_id, "Enter"]);
          return notify(`已向 ${t.name || target}（${t.pane_id}）发送并 steering 提交；对端何时处理未确认，可用 /agent-message read ${target} 跟进`);
        }
        if (sub === "read") {
          const t = resolveTarget(target);
          const lines = Number(argv[2]) > 0 ? Number(argv[2]) : 30;
          const out = herdr(["pane", "read", t.pane_id, "--lines", String(lines), "--format", "text"]);
          return notify(`${t.name || target}（${t.pane_id}）屏幕末尾 ${lines} 行：\n\n${out}`);
        }
        if (sub === "reply" || sub === "prompt" || sub === "exchange") {
          const t = resolveTarget(target);
          const field = sub === "exchange" ? "both" : sub;
          return notify(exchangeText(t, field));
        }
        return notify(`未知子命令：${sub}\n\n${USAGE}`, "warning");
      } catch (e) {
        notify(`${sub} 失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
