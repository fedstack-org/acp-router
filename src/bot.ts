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

interface ChatState {
  conn: acp.ClientSideConnection;
  proc: ReturnType<typeof Bun.spawn>;
  sessionId: string;
  configOptions: acp.SessionConfigOption[];
  availableCommands: acp.AvailableCommand[];
  typingInterval: ReturnType<typeof setInterval> | null;
  agentTextBuffer: string;
  thoughtBuffer: string;
  toolMessages: Map<string, number>;
  pendingPermissions: Map<string, (r: acp.RequestPermissionResponse) => void>;
  busy: boolean;
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramBotToken);
  const chats = new Map<number, ChatState>();

  bot.api.setMyCommands(BUILTIN_COMMANDS).catch(() => {});

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !config.allowedChatIds.includes(chatId)) return;
    if (ctx.chat?.type !== "private") return;
    await next();
  });

  bot.command("start", async (ctx) => {
    const chatId = ctx.chat.id;
    if (chats.has(chatId)) {
      await ctx.reply("Session already active. Just send a message.");
      return;
    }
    await initChat(chatId, ctx, config, chats);
  });

  bot.command("cancel", async (ctx) => {
    const state = chats.get(ctx.chat.id);
    if (!state) return void await ctx.reply("No active session.");
    state.conn.cancel({ sessionId: state.sessionId });
    await ctx.reply("Cancellation requested.");
  });

  bot.command("help", async (ctx) => {
    const state = chats.get(ctx.chat.id);
    let text = "<b>Built-in commands:</b>\n";
    for (const c of BUILTIN_COMMANDS) text += `/${c.command} — ${esc(c.description)}\n`;

    if (state) {
      if (state.availableCommands.length) {
        text += "\n<b>Agent commands:</b>\n";
        for (const c of state.availableCommands) {
          const hint = c.input ? ` <i>${esc(c.input.hint)}</i>` : "";
          text += `/${tgCmd(c.name)}${hint} — ${esc(c.description)}\n`;
        }
      }
      if (state.configOptions.length) {
        text += "\n<b>Config options:</b>\n";
        for (const o of state.configOptions) {
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
    const data = ctx.callbackQuery.data;
    const state = chats.get(ctx.chat!.id);
    if (!state) return;

    const [prefix, id, value] = data.split(":");
    if (prefix === "perm") {
      const resolve = state.pendingPermissions.get(id);
      if (!resolve) return;
      state.pendingPermissions.delete(id);
      resolve(value === "__reject__"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: value } });
      await ctx.answerCallbackQuery({ text: `Selected: ${value}` });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } else if (prefix === "cfg") {
      try {
        const result = await state.conn.setSessionConfigOption({ sessionId: state.sessionId, configId: id, value });
        state.configOptions = result.configOptions;
        const opt = result.configOptions.find((o) => o.id === id);
        const flat = opt ? flatOpts(opt) : [];
        await ctx.answerCallbackQuery({ text: `${opt?.name ?? id} \u2192 ${flat.find((o) => o.value === value)?.name ?? value}` });
        if (opt) {
          await ctx.editMessageText(configMsg(opt), { parse_mode: "HTML", reply_markup: configKeyboard(opt) });
        } else {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        }
        await syncCommands(ctx, state);
      } catch (err) {
        await ctx.answerCallbackQuery({ text: `Error: ${err instanceof Error ? err.message : err}` });
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    let state: ChatState | undefined = chats.get(chatId);

    if (!state) {
      state = await initChat(chatId, ctx, config, chats) ?? undefined;
      if (!state) return;
    }

    if (state.conn.signal.aborted) {
      await ctx.reply("Reinitializing session...");
      destroyChat(chats, chatId);
      state = await initChat(chatId, ctx, config, chats) ?? undefined;
      if (!state) return;
    }

    const text = ctx.message.text;

    if (text.startsWith("/set_")) {
      const match = text.match(/^\/set_(\S+)/);
      if (!match) return;
      const opt = state.configOptions.find((o) => tgCmd(o.id) === match[1]);
      if (!opt) return void await ctx.reply(`Unknown config option: ${match[1]}`);
      await ctx.reply(configMsg(opt), { parse_mode: "HTML", reply_markup: configKeyboard(opt) });
      return;
    }

    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const cmdName = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
      if (["start", "cancel", "help"].includes(cmdName)) return;
      const cmdArgs = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);
      const acpCmd = state.availableCommands.find((c) => tgCmd(c.name) === cmdName);
      if (acpCmd) {
        await doPrompt(ctx, state, cmdArgs ? `/${acpCmd.name} ${cmdArgs}` : `/${acpCmd.name}`);
      } else {
        await ctx.reply(`Unknown command: /${cmdName}`);
      }
      return;
    }

    await doPrompt(ctx, state, text);
  });

  return bot;
}

async function doPrompt(ctx: Context, state: ChatState, text: string) {
  if (state.busy) return void await ctx.reply("Still processing. Please wait.");

  state.busy = true;
  state.agentTextBuffer = "";
  state.thoughtBuffer = "";
  const chatId = ctx.chat!.id;
  const sendAction = () => ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  sendAction();
  state.typingInterval = setInterval(sendAction, TYPING_INTERVAL_MS);

  try {
    const result = await state.conn.prompt({
      sessionId: state.sessionId,
      prompt: [{ type: "text", text }],
    });
    clearTyping(state);

    if (state.thoughtBuffer.trim())
      await sendSplit(ctx, `<b>Thinking:</b>\n${esc(state.thoughtBuffer)}`);
    if (state.agentTextBuffer.trim())
      await sendSplit(ctx, state.agentTextBuffer);
    if (result.stopReason !== "end_turn")
      await ctx.reply(`Turn ended: ${result.stopReason}`);
  } catch (err) {
    clearTyping(state);
    await ctx.reply(`Error: ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: "HTML" });
  } finally {
    state.busy = false;
  }
}

async function initChat(
  chatId: number,
  ctx: Context,
  config: Config,
  chats: Map<number, ChatState>,
): Promise<ChatState | null> {
  const args = ["exec", "--output-format", "acp"];
  const d = config.droid;
  if (d.model) args.push("-m", d.model);
  if (d.autoLevel) args.push("--auto", d.autoLevel);
  if (d.reasoningEffort) args.push("-r", d.reasoningEffort);

  const proc = Bun.spawn(["droid", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
  });

  readStderr(proc, chatId);

  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const stdin = proc.stdin as unknown as { write(d: string | Uint8Array): number; end(): void };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) { stdin.write(chunk); },
    close() { stdin.end(); },
  });

  const state: ChatState = {
    conn: null!,
    proc,
    sessionId: "",
    configOptions: [],
    availableCommands: [],
    typingInterval: null,
    agentTextBuffer: "",
    thoughtBuffer: "",
    toolMessages: new Map(),
    pendingPermissions: new Map(),
    busy: false,
  };

  const client: acp.Client = {
    async requestPermission(params) {
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        state.pendingPermissions.set(params.toolCall.toolCallId, resolve);
        const kb = new InlineKeyboard();
        let row = 0;
        for (const opt of params.options) {
          kb.text(`${permIcon(opt.kind)} ${opt.name}`, `perm:${params.toolCall.toolCallId}:${opt.optionId}`);
          if (++row % 2 === 0) kb.row();
        }
        ctx.api.sendMessage(chatId,
          `<b>Permission requested:</b>\n<code>${esc(params.toolCall.title ?? "Unknown")}</code>`,
          { parse_mode: "HTML", reply_markup: kb },
        ).catch(() => {});
      });
    },
    async sessionUpdate(params) {
      const u = params.update;
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content.type === "text") state.agentTextBuffer += u.content.text;
          break;
        case "agent_thought_chunk":
          if (u.content.type === "text") state.thoughtBuffer += u.content.text;
          break;
        case "tool_call": {
          const icon = toolIcon(u.kind);
          try {
            const msg = await ctx.api.sendMessage(chatId, `${icon} <code>${esc(u.title)}</code>`, { parse_mode: "HTML" });
            state.toolMessages.set(u.toolCallId, msg.message_id);
          } catch { /* non-critical */ }
          break;
        }
        case "tool_call_update": {
          const msgId = state.toolMessages.get(u.toolCallId);
          if (!msgId) break;
          const icon = u.status === "completed" ? "\u2705" : u.status === "failed" ? "\u274C" : "\u23F3";
          try {
            await ctx.api.editMessageText(chatId, msgId, `${icon} <code>${esc(u.title ?? "Tool operation")}</code>`, { parse_mode: "HTML" });
          } catch { /* ignore */ }
          break;
        }
        case "available_commands_update":
          state.availableCommands = u.availableCommands;
          console.log("[droid] Commands:", u.availableCommands.map((c) => c.name).join(", "));
          await syncCommands(ctx, state);
          break;
        case "config_option_update":
          state.configOptions = u.configOptions;
          logConfigOptions(u.configOptions);
          await syncCommands(ctx, state);
          break;
      }
    },
  };

  const stream = acp.ndJsonStream(writable, stdout);
  state.conn = new acp.ClientSideConnection(() => client, stream);

  state.conn.signal.addEventListener("abort", () => {
    console.log(`[droid:${chatId}] connection closed`);
  });

  try {
    await ctx.reply("Starting Droid session...");

    const init = await state.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "acp-router", title: "ACP Router (Telegram)", version: "0.1.0" },
    });

    console.log("[droid] === Initialize ===");
    console.log("[droid] Protocol:", init.protocolVersion);
    console.log("[droid] Agent:", JSON.stringify(init.agentInfo, null, 2));
    console.log("[droid] Capabilities:", JSON.stringify(init.agentCapabilities, null, 2));
    if (init.authMethods) console.log("[droid] Auth:", JSON.stringify(init.authMethods, null, 2));

    const session = await state.conn.newSession({
      cwd: d.cwd ?? process.cwd(),
      mcpServers: [],
    });

    state.sessionId = session.sessionId;
    console.log("[droid] Session:", state.sessionId);
    if (session.configOptions) {
      state.configOptions = session.configOptions;
      logConfigOptions(session.configOptions);
    }
    if (session.modes) console.log("[droid] Modes:", JSON.stringify(session.modes, null, 2));

    chats.set(chatId, state);
    await syncCommands(ctx, state);
    await ctx.reply("Droid session ready.");
    return state;
  } catch (err) {
    proc.kill();
    await ctx.reply(`Failed to start Droid: ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: "HTML" });
    return null;
  }
}

function destroyChat(chats: Map<number, ChatState>, chatId: number) {
  const state = chats.get(chatId);
  if (!state) return;
  clearTyping(state);
  state.proc.kill();
  chats.delete(chatId);
}

async function syncCommands(ctx: Context, state: ChatState) {
  const cmds = [...BUILTIN_COMMANDS];
  for (const c of state.availableCommands)
    cmds.push({ command: tgCmd(c.name), description: c.description });
  for (const o of state.configOptions) {
    const cur = flatOpts(o).find((v) => v.value === o.currentValue)?.name ?? o.currentValue;
    cmds.push({ command: `set_${tgCmd(o.id)}`, description: `${o.name} [${cur}]` });
  }
  try { await ctx.api.setMyCommands(cmds); } catch { /* ignore */ }
}

function clearTyping(state: ChatState) {
  if (state.typingInterval) { clearInterval(state.typingInterval); state.typingInterval = null; }
}

async function readStderr(proc: ReturnType<typeof Bun.spawn>, chatId: number) {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const t = dec.decode(value, { stream: true });
      if (t.trim()) console.error(`[droid:${chatId}] stderr: ${t.trim()}`);
    }
  } catch { /* closed */ }
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
  if ("group" in opt.options[0])
    return (opt.options as acp.SessionConfigSelectGroup[]).flatMap((g) => g.options);
  return opt.options as acp.SessionConfigSelectOption[];
}

function configKeyboard(opt: acp.SessionConfigOption): InlineKeyboard {
  const kb = new InlineKeyboard();
  const flat = flatOpts(opt);
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i];
    kb.text(`${v.value === opt.currentValue ? "\u2713 " : ""}${v.name}`, `cfg:${opt.id}:${v.value}`);
    if ((i + 1) % 2 === 0) kb.row();
  }
  return kb;
}

function configMsg(opt: acp.SessionConfigOption): string {
  const desc = opt.description ? `\n${esc(opt.description)}` : "";
  return `<b>${esc(opt.name)}</b>${desc}\nCurrent: <code>${esc(opt.currentValue)}</code>`;
}

async function sendSplit(ctx: Context, text: string) {
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let at = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (at < MAX_MESSAGE_LENGTH / 2) at = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (at < MAX_MESSAGE_LENGTH / 2) at = MAX_MESSAGE_LENGTH;
    await ctx.reply(remaining.slice(0, at), { parse_mode: "HTML" });
    remaining = remaining.slice(at).trimStart();
  }
  if (remaining) await ctx.reply(remaining, { parse_mode: "HTML" });
}

function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tgCmd(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function toolIcon(kind?: acp.ToolKind): string {
  switch (kind) {
    case "read": return "\uD83D\uDCD6";
    case "edit": return "\u270F\uFE0F";
    case "delete": return "\uD83D\uDDD1\uFE0F";
    case "execute": return "\u26A1";
    case "search": return "\uD83D\uDD0D";
    case "fetch": return "\uD83C\uDF10";
    case "think": return "\uD83D\uDCAD";
    default: return "\uD83D\uDD27";
  }
}

function permIcon(kind: string): string {
  switch (kind) {
    case "allow_once": return "\u2705";
    case "allow_always": return "\uD83D\uDCCB";
    case "reject_once": return "\u274C";
    case "reject_always": return "\uD83D\uDEAB";
    default: return "\u2753";
  }
}
