import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Config } from "./config.js";
import { DroidSession, type PermissionRequest, type ToolCallInfo } from "./droid.js";

const TYPING_INTERVAL_MS = 4000;
const MAX_MESSAGE_LENGTH = 4096;

interface ChatState {
  session: DroidSession;
  typingInterval: ReturnType<typeof setInterval> | null;
  agentTextBuffer: string;
  thoughtBuffer: string;
  toolMessages: Map<string, number>; // toolCallId -> telegram message id
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

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("perm:")) return;

    const parts = data.split(":");
    if (parts.length !== 3) return;

    const [, toolCallId, optionId] = parts;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const state = chats.get(chatId);
    if (!state) return;

    if (optionId === "__reject__") {
      state.session.rejectPermission(toolCallId);
    } else {
      state.session.respondPermission(toolCallId, optionId);
    }

    await ctx.answerCallbackQuery({ text: `Selected: ${optionId}` });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
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
      await ctx.reply("⏳ Reinitializing session...");
      try {
        await state.session.close();
      } catch {
        // ignore
      }
      const newState = await initChat(chatId, ctx, config, chats);
      if (!newState) return;
      state = newState;
    }

    if (state.busy) {
      await ctx.reply("⏳ Still processing the previous message. Please wait.");
      return;
    }

    state.busy = true;
    state.agentTextBuffer = "";
    state.thoughtBuffer = "";

    startTyping(ctx, state);

    try {
      const stopReason = await state.session.prompt(ctx.message.text);
      stopTyping(state);

      // Send accumulated thought
      if (state.thoughtBuffer.trim()) {
        await sendSplitMessages(ctx, `💭 <b>Thinking:</b>\n${escapeHtml(state.thoughtBuffer)}`, "HTML");
      }

      // Send accumulated agent response
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
  });

  return bot;
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
      const msg = await ctx.reply(`${icon} <code>${escapeHtml(info.title)}</code>`, { parse_mode: "HTML" });
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
      await ctx.api.editMessageText(
        chatId,
        msgId,
        `${icon} <code>${escapeHtml(title)}</code>`,
        { parse_mode: "HTML" },
      );
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

  session.on("error", async (err) => {
    console.error(`[droid:${chatId}] error:`, err.message);
  });

  session.on("stderr", (text) => {
    if (text.trim()) {
      console.error(`[droid:${chatId}] stderr: ${text.trim()}`);
    }
  });

  session.on("close", () => {
    console.log(`[droid:${chatId}] session closed`);
  });

  try {
    await ctx.reply("🤖 Starting Droid session...");
    await session.initialize();
    chats.set(chatId, state);
    await ctx.reply("✅ Droid session ready. Send me a message!");
    return state;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Failed to start Droid: ${escapeHtml(msg)}`, { parse_mode: "HTML" });
    return null;
  }
}

function startTyping(ctx: Context, state: ChatState) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sendAction = () => {
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  };

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
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
