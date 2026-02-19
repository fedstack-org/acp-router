import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Config } from "./config.js";
import {
  DroidSession,
  type AvailableCommand,
  type ConfigOption,
  type PermissionRequest,
  type ToolCallInfo,
} from "./droid.js";

const TYPING_INTERVAL_MS = 4000;
const MAX_MESSAGE_LENGTH = 4096;

interface ChatState {
  session: DroidSession;
  typingInterval: ReturnType<typeof setInterval> | null;
  agentTextBuffer: string;
  thoughtBuffer: string;
  toolMessages: Map<string, number>;
  busy: boolean;
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramBotToken);
  const chats = new Map<number, ChatState>();

  // Whitelist middleware
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !config.allowedChatIds.includes(chatId)) return;
    if (ctx.chat?.type !== "private") return;
    await next();
  });

  // /start -- init session, no droid prompt
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat.id;
    const existing = chats.get(chatId);
    if (existing?.session.ready) {
      await ctx.reply("Session already active. Just send a message.");
      return;
    }
    await initChat(chatId, ctx, config, chats);
  });

  // /cancel -- cancel current turn
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

  // Callback queries for permissions and config options
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

  // Text messages -- either ACP slash command or regular prompt
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    let state = chats.get(chatId);

    // Auto-init on first message
    if (!state) {
      const newState = await initChat(chatId, ctx, config, chats);
      if (!newState) return;
      state = newState;
    }

    if (!state.session.ready) {
      await ctx.reply("⏳ Reinitializing session...");
      try { await state.session.close(); } catch { /* ignore */ }
      const newState = await initChat(chatId, ctx, config, chats);
      if (!newState) return;
      state = newState;
    }

    const text = ctx.message.text;

    // Handle /set_xxx commands for config options
    if (text.startsWith("/set_")) {
      await handleSetCommand(ctx, state, text);
      return;
    }

    // Handle Telegram commands that map to ACP slash commands
    // Telegram sends "/command" or "/command args"
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const cmdName = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
      const cmdArgs = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);

      // Skip built-in commands we handle ourselves
      if (["start", "cancel"].includes(cmdName)) return;

      // Check if this is a known ACP command
      const acpCmd = state.session.availableCommands.find(
        (c) => c.name.toLowerCase() === cmdName,
      );
      if (acpCmd) {
        const promptText = cmdArgs ? `/${acpCmd.name} ${cmdArgs}` : `/${acpCmd.name}`;
        await sendPrompt(ctx, state, promptText);
        return;
      }

      // Unknown command
      await ctx.reply(`Unknown command: /${cmdName}`);
      return;
    }

    await sendPrompt(ctx, state, text);
  });

  return bot;
}

async function sendPrompt(ctx: Context, state: ChatState, text: string) {
  if (state.busy) {
    await ctx.reply("⏳ Still processing. Please wait.");
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
      await sendSplitMessages(ctx, `💭 <b>Thinking:</b>\n${escapeHtml(state.thoughtBuffer)}`, "HTML");
    }

    if (state.agentTextBuffer.trim()) {
      await sendSplitMessages(ctx, state.agentTextBuffer, "HTML");
    }

    if (stopReason !== "end_turn") {
      await ctx.reply(`ℹ️ Turn ended: ${stopReason}`);
    }
  } catch (err) {
    stopTyping(state);
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Error: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
  } finally {
    state.busy = false;
  }
}

async function handleSetCommand(ctx: Context, state: ChatState, text: string) {
  // /set_mode, /set_model, etc.
  const match = text.match(/^\/set_(\S+)/);
  if (!match) return;

  const configId = match[1];
  const opt = state.session.configOptions.find((o) => o.id === configId);
  if (!opt) {
    await ctx.reply(`Unknown config option: ${configId}`);
    return;
  }

  // Show InlineKeyboard with available values
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < opt.options.length; i++) {
    const v = opt.options[i];
    const current = v.value === opt.currentValue ? "✓ " : "";
    keyboard.text(`${current}${v.name}`, `cfg:${configId}:${v.value}`);
    if ((i + 1) % 2 === 0) keyboard.row();
  }

  const desc = opt.description ? `\n${escapeHtml(opt.description)}` : "";
  await ctx.reply(
    `⚙️ <b>${escapeHtml(opt.name)}</b>${desc}\nCurrent: <code>${escapeHtml(opt.currentValue)}</code>`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

async function handlePermissionCallback(ctx: Context, state: ChatState, data: string) {
  const parts = data.split(":");
  if (parts.length !== 3) return;
  const [, toolCallId, optionId] = parts;

  if (optionId === "__reject__") {
    state.session.rejectPermission(toolCallId);
  } else {
    state.session.respondPermission(toolCallId, optionId);
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
    const displayName = opt?.name ?? configId;
    const displayValue = opt?.options.find((o) => o.value === value)?.name ?? value;

    await ctx.answerCallbackQuery({ text: `${displayName} → ${displayValue}` });

    // Rebuild keyboard with updated current value
    if (opt) {
      const keyboard = new InlineKeyboard();
      for (let i = 0; i < opt.options.length; i++) {
        const v = opt.options[i];
        const current = v.value === opt.currentValue ? "✓ " : "";
        keyboard.text(`${current}${v.name}`, `cfg:${configId}:${v.value}`);
        if ((i + 1) % 2 === 0) keyboard.row();
      }
      const desc = opt.description ? `\n${escapeHtml(opt.description)}` : "";
      await ctx.editMessageText(
        `⚙️ <b>${escapeHtml(opt.name)}</b>${desc}\nCurrent: <code>${escapeHtml(opt.currentValue)}</code>`,
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
      const icon = info.status === "completed" ? "✅" : info.status === "failed" ? "❌" : "⏳";
      const title = info.title || "Tool operation";
      await ctx.api.editMessageText(chatId, msgId, `${icon} <code>${escapeHtml(title)}</code>`, {
        parse_mode: "HTML",
      });
    } catch {
      // edit may fail if message hasn't changed
    }
  });

  session.on("permission_request", async (req: PermissionRequest) => {
    const keyboard = new InlineKeyboard();
    const toolTitle = req.toolCall.title || "Unknown operation";

    let rowCount = 0;
    for (const opt of req.options) {
      const icon = permissionIcon(opt.kind);
      keyboard.text(`${icon} ${opt.name}`, `perm:${req.toolCall.toolCallId}:${opt.optionId}`);
      rowCount++;
      if (rowCount % 2 === 0) keyboard.row();
    }

    await ctx.api.sendMessage(
      chatId,
      `🔐 <b>Permission requested:</b>\n<code>${escapeHtml(toolTitle)}</code>`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  session.on("available_commands_update", async (commands: AvailableCommand[]) => {
    await registerTelegramCommands(ctx, commands, session.configOptions);
  });

  session.on("config_options_update", async (options: ConfigOption[]) => {
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
    await ctx.reply("🤖 Starting Droid session...");
    await session.initialize();
    chats.set(chatId, state);
    await registerTelegramCommands(ctx, session.availableCommands, session.configOptions);
    await ctx.reply("✅ Droid session ready.");
    return state;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Failed to start Droid: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    return null;
  }
}

async function registerTelegramCommands(
  ctx: Context,
  acpCommands: ReadonlyArray<AvailableCommand>,
  configOptions: ReadonlyArray<ConfigOption>,
) {
  const commands: Array<{ command: string; description: string }> = [
    { command: "start", description: "Start a new Droid session" },
    { command: "cancel", description: "Cancel current operation" },
  ];

  for (const cmd of acpCommands) {
    const name = cmd.name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    commands.push({ command: name, description: cmd.description });
  }

  for (const opt of configOptions) {
    const name = `set_${opt.id.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
    const current = opt.options.find((o) => o.value === opt.currentValue)?.name ?? opt.currentValue;
    commands.push({ command: name, description: `${opt.name} [${current}]` });
  }

  try {
    await ctx.api.setMyCommands(commands);
  } catch {
    // may fail if called too rapidly
  }
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

function toolIcon(kind?: string): string {
  switch (kind) {
    case "read": return "📖";
    case "edit": return "✏️";
    case "delete": return "🗑️";
    case "execute": return "⚡";
    case "search": return "🔍";
    case "fetch": return "🌐";
    case "think": return "💭";
    default: return "🔧";
  }
}

function permissionIcon(kind: string): string {
  switch (kind) {
    case "allow_once": return "✅";
    case "allow_always": return "📋";
    case "reject_once": return "❌";
    case "reject_always": return "🚫";
    default: return "❓";
  }
}
