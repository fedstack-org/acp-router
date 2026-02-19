import { Bot, InlineKeyboard, type Context } from "grammy";
import * as acp from "@agentclientprotocol/sdk";
import type { Config } from "./config.js";

const TYPING_INTERVAL_MS = 4000;
const MAX_MESSAGE_LENGTH = 4096;

const BUILTIN_COMMANDS = [
  { command: "start", description: "Start a new Droid session" },
  { command: "cancel", description: "Cancel current operation" },
  { command: "help", description: "Show available commands" },
];

class RouterClient implements acp.Client {
  conn!: acp.ClientSideConnection;
  proc!: ReturnType<typeof Bun.spawn>;
  sessionId = "";
  configOptions: acp.SessionConfigOption[] = [];
  availableCommands: acp.AvailableCommand[] = [];
  typingInterval: ReturnType<typeof setInterval> | null = null;
  agentText = "";
  thought = "";
  toolMsgs = new Map<string, number>();
  pendingPerms = new Map<string, (r: acp.RequestPermissionResponse) => void>();
  busy = false;

  constructor(private chatId: number, private ctx: Context) {}

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pendingPerms.set(params.toolCall.toolCallId, resolve);
      const kb = new InlineKeyboard();
      let row = 0;
      for (const o of params.options) {
        kb.text(`${permIcon(o.kind)} ${o.name}`, `perm:${params.toolCall.toolCallId}:${o.optionId}`);
        if (++row % 2 === 0) kb.row();
      }
      this.ctx.api.sendMessage(this.chatId,
        `<b>Permission requested:</b>\n<code>${esc(params.toolCall.title ?? "Unknown")}</code>`,
        { parse_mode: "HTML", reply_markup: kb },
      ).catch(() => {});
    });
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.agentText += u.content.text;
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") this.thought += u.content.text;
        break;
      case "tool_call":
        try {
          const msg = await this.ctx.api.sendMessage(this.chatId,
            `${toolIcon(u.kind)} <code>${esc(u.title)}</code>`, { parse_mode: "HTML" });
          this.toolMsgs.set(u.toolCallId, msg.message_id);
        } catch { /* non-critical */ }
        break;
      case "tool_call_update": {
        const msgId = this.toolMsgs.get(u.toolCallId);
        if (!msgId) break;
        const icon = u.status === "completed" ? "\u2705" : u.status === "failed" ? "\u274C" : "\u23F3";
        try {
          await this.ctx.api.editMessageText(this.chatId, msgId,
            `${icon} <code>${esc(u.title ?? "Tool operation")}</code>`, { parse_mode: "HTML" });
        } catch { /* ignore */ }
        break;
      }
      case "available_commands_update":
        this.availableCommands = u.availableCommands;
        console.log("[droid] Commands:", u.availableCommands.map((c) => c.name).join(", "));
        await this.syncCommands();
        break;
      case "config_option_update":
        this.configOptions = u.configOptions;
        logConfigOptions(u.configOptions);
        await this.syncCommands();
        break;
    }
  }

  async syncCommands() {
    const cmds = [...BUILTIN_COMMANDS];
    for (const c of this.availableCommands)
      cmds.push({ command: tgCmd(c.name), description: c.description });
    for (const o of this.configOptions) {
      const cur = flatOpts(o).find((v) => v.value === o.currentValue)?.name ?? o.currentValue;
      cmds.push({ command: `set_${tgCmd(o.id)}`, description: `${o.name} [${cur}]` });
    }
    try { await this.ctx.api.setMyCommands(cmds); } catch { /* ignore */ }
  }

  clearTyping() {
    if (this.typingInterval) { clearInterval(this.typingInterval); this.typingInterval = null; }
  }

  destroy() {
    this.clearTyping();
    this.proc.kill();
  }
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramBotToken);
  const chats = new Map<number, RouterClient>();

  bot.api.setMyCommands(BUILTIN_COMMANDS).catch(() => {});

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !config.allowedChatIds.includes(chatId)) return;
    if (ctx.chat?.type !== "private") return;
    await next();
  });

  bot.command("start", async (ctx) => {
    if (chats.has(ctx.chat.id)) return void await ctx.reply("Session already active. Just send a message.");
    await initChat(ctx.chat.id, ctx, config, chats);
  });

  bot.command("cancel", async (ctx) => {
    const c = chats.get(ctx.chat.id);
    if (!c) return void await ctx.reply("No active session.");
    c.conn.cancel({ sessionId: c.sessionId });
    await ctx.reply("Cancellation requested.");
  });

  bot.command("help", async (ctx) => {
    const c = chats.get(ctx.chat.id);
    let text = "<b>Built-in commands:</b>\n";
    for (const cmd of BUILTIN_COMMANDS) text += `/${cmd.command} — ${esc(cmd.description)}\n`;
    if (c) {
      if (c.availableCommands.length) {
        text += "\n<b>Agent commands:</b>\n";
        for (const cmd of c.availableCommands) {
          const hint = cmd.input ? ` <i>${esc(cmd.input.hint)}</i>` : "";
          text += `/${tgCmd(cmd.name)}${hint} — ${esc(cmd.description)}\n`;
        }
      }
      if (c.configOptions.length) {
        text += "\n<b>Config options:</b>\n";
        for (const o of c.configOptions) {
          const cur = flatOpts(o).find((v) => v.value === o.currentValue)?.name ?? o.currentValue;
          text += `/set_${tgCmd(o.id)} — ${esc(o.name)} [${esc(cur)}]\n`;
        }
      }
    } else {
      text += "\nNo active session. Send /start or any message to begin.";
    }
    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.on("callback_query:data", async (ctx) => {
    const c = chats.get(ctx.chat!.id);
    if (!c) return;
    const [prefix, id, value] = ctx.callbackQuery.data.split(":");
    if (prefix === "perm") {
      const resolve = c.pendingPerms.get(id);
      if (!resolve) return;
      c.pendingPerms.delete(id);
      resolve(value === "__reject__"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: value } });
      await ctx.answerCallbackQuery({ text: `Selected: ${value}` });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } else if (prefix === "cfg") {
      try {
        const result = await c.conn.setSessionConfigOption({ sessionId: c.sessionId, configId: id, value });
        c.configOptions = result.configOptions;
        const opt = result.configOptions.find((o) => o.id === id);
        const flat = opt ? flatOpts(opt) : [];
        await ctx.answerCallbackQuery({ text: `${opt?.name ?? id} \u2192 ${flat.find((o) => o.value === value)?.name ?? value}` });
        if (opt) await ctx.editMessageText(configMsg(opt), { parse_mode: "HTML", reply_markup: configKb(opt) });
        else await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await c.syncCommands();
      } catch (err) {
        await ctx.answerCallbackQuery({ text: `Error: ${err instanceof Error ? err.message : err}` });
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    let c: RouterClient | undefined = chats.get(chatId);

    if (!c) {
      c = await initChat(chatId, ctx, config, chats) ?? undefined;
      if (!c) return;
    }
    if (c.conn.signal.aborted) {
      await ctx.reply("Reinitializing session...");
      c.destroy(); chats.delete(chatId);
      c = await initChat(chatId, ctx, config, chats) ?? undefined;
      if (!c) return;
    }

    const text = ctx.message.text;

    if (text.startsWith("/set_")) {
      const m = text.match(/^\/set_(\S+)/);
      if (!m) return;
      const opt = c.configOptions.find((o) => tgCmd(o.id) === m[1]);
      if (!opt) return void await ctx.reply(`Unknown config option: ${m[1]}`);
      return void await ctx.reply(configMsg(opt), { parse_mode: "HTML", reply_markup: configKb(opt) });
    }

    if (text.startsWith("/")) {
      const si = text.indexOf(" ");
      const name = (si === -1 ? text.slice(1) : text.slice(1, si)).toLowerCase();
      if (["start", "cancel", "help"].includes(name)) return;
      const args = si === -1 ? "" : text.slice(si + 1);
      const cmd = c.availableCommands.find((x) => tgCmd(x.name) === name);
      if (cmd) return void await doPrompt(ctx, c, args ? `/${cmd.name} ${args}` : `/${cmd.name}`);
      return void await ctx.reply(`Unknown command: /${name}`);
    }

    await doPrompt(ctx, c, text);
  });

  return bot;
}

async function doPrompt(ctx: Context, c: RouterClient, text: string) {
  if (c.busy) return void await ctx.reply("Still processing. Please wait.");
  c.busy = true;
  c.agentText = "";
  c.thought = "";
  const chatId = ctx.chat!.id;
  const tick = () => ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  tick();
  c.typingInterval = setInterval(tick, TYPING_INTERVAL_MS);

  try {
    const r = await c.conn.prompt({ sessionId: c.sessionId, prompt: [{ type: "text", text }] });
    c.clearTyping();
    if (c.thought.trim()) await sendSplit(ctx, `<b>Thinking:</b>\n${esc(c.thought)}`);
    if (c.agentText.trim()) await sendSplit(ctx, c.agentText);
    if (r.stopReason !== "end_turn") await ctx.reply(`Turn ended: ${r.stopReason}`);
  } catch (err) {
    c.clearTyping();
    await ctx.reply(`Error: ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: "HTML" });
  } finally {
    c.busy = false;
  }
}

async function initChat(chatId: number, ctx: Context, config: Config, chats: Map<number, RouterClient>): Promise<RouterClient | null> {
  const args = ["exec", "--output-format", "acp"];
  const d = config.droid;
  if (d.model) args.push("-m", d.model);
  if (d.autoLevel) args.push("--auto", d.autoLevel);
  if (d.reasoningEffort) args.push("-r", d.reasoningEffort);

  const proc = Bun.spawn(["droid", ...args], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
  });
  readStderr(proc, chatId);

  const stdin = proc.stdin as unknown as { write(d: string | Uint8Array): number; end(): void };
  const writable = new WritableStream<Uint8Array>({ write(ch) { stdin.write(ch); }, close() { stdin.end(); } });
  const stream = acp.ndJsonStream(writable, proc.stdout as ReadableStream<Uint8Array>);

  const c = new RouterClient(chatId, ctx);
  c.proc = proc;
  c.conn = new acp.ClientSideConnection(() => c, stream);
  c.conn.signal.addEventListener("abort", () => console.log(`[droid:${chatId}] closed`));

  try {
    await ctx.reply("Starting Droid session...");
    const init = await c.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "acp-router", title: "ACP Router (Telegram)", version: "0.1.0" },
    });
    console.log("[droid] === Initialize ===");
    console.log("[droid] Protocol:", init.protocolVersion);
    console.log("[droid] Agent:", JSON.stringify(init.agentInfo, null, 2));
    console.log("[droid] Capabilities:", JSON.stringify(init.agentCapabilities, null, 2));
    if (init.authMethods) console.log("[droid] Auth:", JSON.stringify(init.authMethods, null, 2));

    const s = await c.conn.newSession({ cwd: d.cwd ?? process.cwd(), mcpServers: [] });
    c.sessionId = s.sessionId;
    console.log("[droid] Session:", c.sessionId);
    if (s.configOptions) { c.configOptions = s.configOptions; logConfigOptions(s.configOptions); }
    if (s.modes) console.log("[droid] Modes:", JSON.stringify(s.modes, null, 2));

    chats.set(chatId, c);
    await c.syncCommands();
    await ctx.reply("Droid session ready.");
    return c;
  } catch (err) {
    proc.kill();
    await ctx.reply(`Failed to start Droid: ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: "HTML" });
    return null;
  }
}

// --- helpers ---

async function readStderr(proc: ReturnType<typeof Bun.spawn>, chatId: number) {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; const t = dec.decode(value, { stream: true }); if (t.trim()) console.error(`[droid:${chatId}] stderr: ${t.trim()}`); } } catch { /* closed */ }
}

function logConfigOptions(opts: acp.SessionConfigOption[]) {
  console.log("[droid] Config options:");
  for (const o of opts) {
    const vals = flatOpts(o).map((v) => v.value === o.currentValue ? `[${v.name}]` : v.name);
    console.log(`[droid]   ${o.id} (${o.category ?? "none"}): ${vals.join(", ")}`);
  }
}

function flatOpts(opt: acp.SessionConfigOption): acp.SessionConfigSelectOption[] {
  if (opt.options.length === 0) return [];
  if ("group" in opt.options[0]) return (opt.options as acp.SessionConfigSelectGroup[]).flatMap((g) => g.options);
  return opt.options as acp.SessionConfigSelectOption[];
}

function configKb(opt: acp.SessionConfigOption): InlineKeyboard {
  const kb = new InlineKeyboard();
  const flat = flatOpts(opt);
  for (let i = 0; i < flat.length; i++) {
    kb.text(`${flat[i].value === opt.currentValue ? "\u2713 " : ""}${flat[i].name}`, `cfg:${opt.id}:${flat[i].value}`);
    if ((i + 1) % 2 === 0) kb.row();
  }
  return kb;
}

function configMsg(opt: acp.SessionConfigOption): string {
  const d = opt.description ? `\n${esc(opt.description)}` : "";
  return `<b>${esc(opt.name)}</b>${d}\nCurrent: <code>${esc(opt.currentValue)}</code>`;
}

async function sendSplit(ctx: Context, text: string) {
  let r = text;
  while (r.length > MAX_MESSAGE_LENGTH) {
    let at = r.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (at < MAX_MESSAGE_LENGTH / 2) at = r.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (at < MAX_MESSAGE_LENGTH / 2) at = MAX_MESSAGE_LENGTH;
    await ctx.reply(r.slice(0, at), { parse_mode: "HTML" });
    r = r.slice(at).trimStart();
  }
  if (r) await ctx.reply(r, { parse_mode: "HTML" });
}

function esc(t: string) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function tgCmd(n: string) { return n.toLowerCase().replace(/[^a-z0-9_]/g, "_"); }

function toolIcon(kind?: acp.ToolKind) {
  switch (kind) {
    case "read": return "\uD83D\uDCD6"; case "edit": return "\u270F\uFE0F"; case "delete": return "\uD83D\uDDD1\uFE0F";
    case "execute": return "\u26A1"; case "search": return "\uD83D\uDD0D"; case "fetch": return "\uD83C\uDF10";
    case "think": return "\uD83D\uDCAD"; default: return "\uD83D\uDD27";
  }
}

function permIcon(kind: string) {
  switch (kind) {
    case "allow_once": return "\u2705"; case "allow_always": return "\uD83D\uDCCB";
    case "reject_once": return "\u274C"; case "reject_always": return "\uD83D\uDEAB"; default: return "\u2753";
  }
}
