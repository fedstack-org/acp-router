import { Bot, InlineKeyboard, type Context } from "grammy";
import type { SessionConfigOption, AvailableCommand, ToolKind } from "@agentclientprotocol/sdk";
import { DroidSession, flattenConfigOptions, type PermissionRequest, type ToolCallInfo } from "./droid.js";
import type { Config } from "./config.js";

const TYPING_INTERVAL_MS = 4000;
const MAX_MESSAGE_LENGTH = 4096;

interface ChatState {
  session: DroidSession;
  typingInterval: ReturnType<typeof setInterval> | null;
  agentTextBuffer: string;
  thoughtBuffer: string;
  toolMessages: Map<string, number>;
  pendingPermissions: Map<string, PermissionRequest>;
  busy: boolean;
}

const BUILTIN_COMMANDS = [
  { command: "start", description: "Start a new Droid session" },
  { command: "cancel", description: "Cancel current operation" },
  { command: "help", description: "Show available commands" },
];

export function createBot(config: Config) {
  const bot = new Bot(config.telegramBotToken);
  const chats = new Map<number, ChatState>();

  bot.api.setMyCommands(BUILTIN_COMMANDS).catch(() => {});

  // Whitelist middleware
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !config.allowedChatIds.includes(chatId)) return;
    if (ctx.chat?.type !== "private") return;
    await next();
  });

  bot.command("start", async (ctx) => {
    const chatId = ctx.chat.id;
    const existing = chats.get(chatId);
    if (existing?.session.ready) {
      await ctx.reply("Session already active. Just send a message.");
      return;
    }
    await initChat(chatId, ctx, config, chats);
  });

  bot.command("cancel", async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chats.get(chatId);
    if (!state) {
      await ctx.reply("No active session.");
      return;
    }
    state.session.cancel();
    await ctx.reply("Cancellation requested.");
  });

  bot.command("help", async (ctx) => {
    const chatId = ctx.chat.id;
    const state = chats.get(chatId);

    let text = "<b>Built-in commands:</b>\n";
    for (const c of BUILTIN_COMMANDS) {
      text += `/${c.command} — ${escapeHtml(c.description)}\n`;
    }

    if (state) {
      const acpCmds = state.session.availableCommands;
      if (acpCmds.length > 0) {
        text += "\n<b>Agent commands:</b>\n";
        for (const c of acpCmds) {
          const name = toTelegramCmd(c.name);
          const hint = c.input ? ` <i>${escapeHtml(c.input.hint)}</i>` : "";
          text += `/${name}${hint} — ${escapeHtml(c.description)}\n`;
        }
      }

      const opts = state.session.configOptions;
      if (opts.length > 0) {
        text += "\n<b>Config options:</b>\n";
        for (const o of opts) {
          const name = `set_${toTelegramCmd(o.id)}`;
          const flat = flattenConfigOptions(o);
          const current = flat.find((v) => v.value === o.currentValue)?.name ?? o.currentValue;
          text += `/${name} — ${escapeHtml(o.name)} [${escapeHtml(current)}]\n`;
        }
      }
    } else {
      text += "\nNo active session. Send /start or any message to begin.";
    }

    await ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const state = chats.get(chatId);
    if (!state) return;

    if (data.startsWith("perm:")) {
      await handlePermissionCallback(ctx, state, data);
    } else if (data.startsWith("cfg:")) {
      await handleConfigCallback(ctx, state, data);
    }
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    let state = chats.get(chatId);

    if (!state) {
      const newState = await initChat(chatId, ctx, config, chats);
      if (!newState) return;
      state = newState;
    }

    if (!state.session.ready) {
      await ctx.reply("Reinitializing session...");
      try { await state.session.close(); } catch { /* ignore */ }
      const newState = await initChat(chatId, ctx, config, chats);
      if (!newState) return;
      state = newState;
    }

    const text = ctx.message.text;

    if (text.startsWith("/set_")) {
      await handleSetCommand(ctx, state, text);
      return;
    }

    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const cmdName = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
      const cmdArgs = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);

      if (["start", "cancel", "help"].includes(cmdName)) return;

      const acpCmd = state.session.availableCommands.find(
        (c) => toTelegramCmd(c.name) === cmdName,
      );
      if (acpCmd) {
        const promptText = cmdArgs ? `/${acpCmd.name} ${cmdArgs}` : `/${acpCmd.name}`;
        await sendPrompt(ctx, state, promptText);
        return;
      }

      await ctx.reply(`Unknown command: /${cmdName}`);
      return;
    }

    await sendPrompt(ctx, state, text);
  });

  return bot;
}

async function sendPrompt(ctx: Context, state: ChatState, text: string) {
  if (state.busy) {
    await ctx.reply("Still processing. Please wait.");
    return;
  }

  state.busy = true;
  state.agentTextBuffer = "";
  state.thoughtBuffer = "";

  startTyping(ctx, state);

  try {
    const stopReason = await state.session.prompt(text);
    stopTyping(state);

    if (state.thoughtBuffer.trim()) {
      await sendSplitMessages(ctx, `<b>Thinking:</b>\n${escapeHtml(state.thoughtBuffer)}`, "HTML");
    }

    if (state.agentTextBuffer.trim()) {
      await sendSplitMessages(ctx, state.agentTextBuffer, "HTML");
    }

    if (stopReason !== "end_turn") {
      await ctx.reply(`Turn ended: ${stopReason}`);
    }
  } catch (err) {
    stopTyping(state);
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Error: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
  } finally {
    state.busy = false;
  }
}

async function handleSetCommand(ctx: Context, state: ChatState, text: string) {
  const match = text.match(/^\/set_(\S+)/);
  if (!match) return;

  const configId = match[1];
  const opt = state.session.configOptions.find((o) => toTelegramCmd(o.id) === configId);
  if (!opt) {
    await ctx.reply(`Unknown config option: ${configId}`);
    return;
  }

  const flat = flattenConfigOptions(opt);
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i];
    const current = v.value === opt.currentValue ? "\u2713 " : "";
    keyboard.text(`${current}${v.name}`, `cfg:${opt.id}:${v.value}`);
    if ((i + 1) % 2 === 0) keyboard.row();
  }

  const desc = opt.description ? `\n${escapeHtml(opt.description)}` : "";
  await ctx.reply(
    `<b>${escapeHtml(opt.name)}</b>${desc}\nCurrent: <code>${escapeHtml(opt.currentValue)}</code>`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

async function handlePermissionCallback(ctx: Context, state: ChatState, data: string) {
  const parts = data.split(":");
  if (parts.length !== 3) return;
  const [, toolCallId, optionId] = parts;

  const req = state.pendingPermissions.get(toolCallId);
  if (!req) return;
  state.pendingPermissions.delete(toolCallId);

  if (optionId === "__reject__") {
    state.session.rejectPermission(req);
  } else {
    state.session.respondPermission(req, optionId);
  }

  await ctx.answerCallbackQuery({ text: `Selected: ${optionId}` });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
}

async function handleConfigCallback(ctx: Context, state: ChatState, data: string) {
  const parts = data.split(":");
  if (parts.length !== 3) return;
  const [, configId, value] = parts;

  try {
    const updated = await state.session.setConfigOption(configId, value);
    const opt = updated.find((o) => o.id === configId);
    const flat = opt ? flattenConfigOptions(opt) : [];
    const displayName = opt?.name ?? configId;
    const displayValue = flat.find((o) => o.value === value)?.name ?? value;

    await ctx.answerCallbackQuery({ text: `${displayName} \u2192 ${displayValue}` });

    if (opt) {
      const keyboard = new InlineKeyboard();
      for (let i = 0; i < flat.length; i++) {
        const v = flat[i];
        const current = v.value === opt.currentValue ? "\u2713 " : "";
        keyboard.text(`${current}${v.name}`, `cfg:${configId}:${v.value}`);
        if ((i + 1) % 2 === 0) keyboard.row();
      }
      const desc = opt.description ? `\n${escapeHtml(opt.description)}` : "";
      await ctx.editMessageText(
        `<b>${escapeHtml(opt.name)}</b>${desc}\nCurrent: <code>${escapeHtml(opt.currentValue)}</code>`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } else {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.answerCallbackQuery({ text: `Error: ${msg}` });
  }
}

async function initChat(
  chatId: number,
  ctx: Context,
  config: Config,
  chats: Map<number, ChatState>,
): Promise<ChatState | null> {
  const session = new DroidSession(config.droid);

  const state: ChatState = {
    session,
    typingInterval: null,
    agentTextBuffer: "",
    thoughtBuffer: "",
    toolMessages: new Map(),
    pendingPermissions: new Map(),
    busy: false,
  };

  session.on("agent_message_chunk", (text) => {
    state.agentTextBuffer += text;
  });

  session.on("thought_message_chunk", (text) => {
    state.thoughtBuffer += text;
  });

  session.on("tool_call", async (info: ToolCallInfo) => {
    try {
      const icon = toolIcon(info.kind);
      const msg = await ctx.api.sendMessage(chatId, `${icon} <code>${escapeHtml(info.title)}</code>`, {
        parse_mode: "HTML",
      });
      state.toolMessages.set(info.toolCallId, msg.message_id);
    } catch {
      // non-critical
    }
  });

  session.on("tool_call_update", async (info: ToolCallInfo) => {
    const msgId = state.toolMessages.get(info.toolCallId);
    if (!msgId) return;
    try {
      const icon = info.status === "completed" ? "\u2705" : info.status === "failed" ? "\u274C" : "\u23F3";
      const title = info.title || "Tool operation";
      await ctx.api.editMessageText(chatId, msgId, `${icon} <code>${escapeHtml(title)}</code>`, {
        parse_mode: "HTML",
      });
    } catch {
      // edit may fail if message hasn't changed
    }
  });

  session.on("permission_request", async (req: PermissionRequest) => {
    state.pendingPermissions.set(req.toolCall.toolCallId, req);

    const keyboard = new InlineKeyboard();
    const toolTitle = req.toolCall.title ?? "Unknown operation";

    let rowCount = 0;
    for (const opt of req.options) {
      const icon = permissionIcon(opt.kind);
      keyboard.text(`${icon} ${opt.name}`, `perm:${req.toolCall.toolCallId}:${opt.optionId}`);
      rowCount++;
      if (rowCount % 2 === 0) keyboard.row();
    }

    await ctx.api.sendMessage(
      chatId,
      `<b>Permission requested:</b>\n<code>${escapeHtml(toolTitle)}</code>`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  session.on("available_commands_update", async (commands: AvailableCommand[]) => {
    await registerTelegramCommands(ctx, commands, session.configOptions);
  });

  session.on("config_options_update", async (options: SessionConfigOption[]) => {
    await registerTelegramCommands(ctx, session.availableCommands, options);
  });

  session.on("error", (err) => {
    console.error(`[droid:${chatId}] error:`, err.message);
  });

  session.on("stderr", (text) => {
    if (text.trim()) console.error(`[droid:${chatId}] stderr: ${text.trim()}`);
  });

  session.on("close", () => {
    console.log(`[droid:${chatId}] session closed`);
  });

  try {
    await ctx.reply("Starting Droid session...");
    await session.initialize();
    chats.set(chatId, state);
    await registerTelegramCommands(ctx, session.availableCommands, session.configOptions);
    await ctx.reply("Droid session ready.");
    return state;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Failed to start Droid: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    return null;
  }
}

async function registerTelegramCommands(
  ctx: Context,
  acpCommands: ReadonlyArray<AvailableCommand>,
  configOptions: ReadonlyArray<SessionConfigOption>,
) {
  const commands: Array<{ command: string; description: string }> = [
    ...BUILTIN_COMMANDS,
  ];

  for (const cmd of acpCommands) {
    commands.push({ command: toTelegramCmd(cmd.name), description: cmd.description });
  }

  for (const opt of configOptions) {
    const name = `set_${toTelegramCmd(opt.id)}`;
    const flat = flattenConfigOptions(opt);
    const current = flat.find((o) => o.value === opt.currentValue)?.name ?? opt.currentValue;
    commands.push({ command: name, description: `${opt.name} [${current}]` });
  }

  try {
    await ctx.api.setMyCommands(commands);
  } catch {
    // may fail if called too rapidly
  }
}

function toTelegramCmd(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function startTyping(ctx: Context, state: ChatState) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const sendAction = () => ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  sendAction();
  state.typingInterval = setInterval(sendAction, TYPING_INTERVAL_MS);
}

function stopTyping(state: ChatState) {
  if (state.typingInterval) {
    clearInterval(state.typingInterval);
    state.typingInterval = null;
  }
}

async function sendSplitMessages(ctx: Context, text: string, parseMode: "HTML") {
  const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: parseMode });
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toolIcon(kind?: ToolKind): string {
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

function permissionIcon(kind: string): string {
  switch (kind) {
    case "allow_once": return "\u2705";
    case "allow_always": return "\uD83D\uDCCB";
    case "reject_once": return "\u274C";
    case "reject_always": return "\uD83D\uDEAB";
    default: return "\u2753";
  }
}
