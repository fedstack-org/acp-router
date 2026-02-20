import { Bot, InlineKeyboard, InputFile } from 'grammy'
import { IMAdapter, logger, type AdapterInteraction, type InlineActions, type InlineMessage, type InlineUpdate } from '@acp-router/core'

const BASE_COMMANDS = [
  { name: 'start', description: 'Start a session' },
  { name: 'cancel', description: 'Cancel current run' },
  { name: 'sessions', description: 'List sessions' },
  { name: 'agents', description: 'List agents' },
  { name: 'mode', description: 'Get/set mode' },
  { name: 'model', description: 'Get/set model' },
  { name: 'config', description: 'Get/set config' }
]

export class TelegramAdapter extends IMAdapter {
  readonly platform = 'telegram'
  private bot: Bot
  private baseCommands = [...BASE_COMMANDS]
  private actionHandlers = new Map<string, (actionId: string) => Promise<void>>()
  private fallbackActions = new Map<string, (actionId: string) => Promise<void>>()

  constructor(private token: string, private allowList: number[]) {
    super()
    this.bot = new Bot(token)
  }

  async init(): Promise<void> {
    this.bot.api
      .setMyCommands(this.baseCommands.map((cmd) => ({ command: cmd.name, description: cmd.description })))
      .catch(() => {})
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id
      if (!chatId || !this.allowList.includes(chatId)) return
      if (ctx.chat?.type !== 'private') return
      await next()
    })
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text
      if (text.startsWith('/')) return
      await this.emit('text', String(ctx.chat.id), text)
    })
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text
      if (!text.startsWith('/')) return
      const parts = text.slice(1).trim().split(' ')
      const command = parts[0]
      const args = parts.slice(1).filter(Boolean)
      await this.emit('command', String(ctx.chat.id), command, args)
    })
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery?.data
      if (!data) return
      const handler = this.actionHandlers.get(data) ?? this.fallbackActions.get(data)
      if (!handler) return
      await handler(data)
      await ctx.answerCallbackQuery().catch(() => {})
    })
    this.bot.catch((err) => logger.error({ err }, 'Telegram adapter error'))
    this.bot.start()
  }

  async sendMarkdownText(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(Number(chatId), text, { parse_mode: 'Markdown' }).catch(() => {})
  }

  async sendMedia(chatId: string, payload: { kind: string; mimeType: string; data: Uint8Array; filename?: string }): Promise<void> {
    const file = new InputFile(Buffer.from(payload.data), payload.filename ?? `file.${extFromMime(payload.mimeType)}`)
    if (payload.kind === 'image') {
      await this.bot.api.sendPhoto(Number(chatId), file).catch(() => {})
      return
    }
    if (payload.kind === 'audio') {
      await this.bot.api.sendAudio(Number(chatId), file).catch(() => {})
      return
    }
    if (payload.kind === 'video') {
      await this.bot.api.sendVideo(Number(chatId), file).catch(() => {})
      return
    }
    await this.bot.api.sendDocument(Number(chatId), file).catch(() => {})
  }

  async setCommands(commands: { name: string; description: string }[]): Promise<void> {
    const merged = [...this.baseCommands, ...commands]
    await this.bot.api.setMyCommands(merged.map((cmd) => ({ command: cmd.name, description: cmd.description }))).catch(() => {})
    logger.debug({ count: merged.length }, 'Telegram commands updated')
  }

  async sendInteractiveMessage(chatId: string, message: InlineMessage): Promise<AdapterInteraction> {
    const kb = message.actions ? toKeyboard(message.actions) : undefined
    const sent = await this.bot.api
      .sendMessage(Number(chatId), message.markdown, { parse_mode: 'Markdown', reply_markup: kb })
      .catch(() => null)
    if (message.actions) {
      for (const action of message.actions.items) {
        this.actionHandlers.set(action.id, async (actionId) => {
          await message.actions?.callback(actionId)
        })
      }
      if (!sent) {
        for (const action of message.actions.items) {
          this.fallbackActions.set(action.id, async (actionId) => {
            await message.actions?.callback(actionId)
          })
        }
      }
    }
    return { id: sent ? String(sent.message_id) : `temp-${Date.now()}`, message }
  }

  async updateInteractiveMessage(chatId: string, messageId: string, update: InlineUpdate): Promise<void> {
    const nextActions = update.actions === undefined ? undefined : update.actions
    const kb = nextActions ? toKeyboard(nextActions as InlineActions) : undefined
    if (update.markdown != null) {
      await this.bot.api
        .editMessageText(Number(chatId), Number(messageId), update.markdown, {
          parse_mode: 'Markdown',
          reply_markup: kb
        })
        .catch(() => {})
      this.refreshActions(nextActions)
      return
    }
    if (nextActions !== undefined) {
      await this.bot.api
        .editMessageReplyMarkup(Number(chatId), Number(messageId), {
          reply_markup: kb
        })
        .catch(() => {})
      this.refreshActions(nextActions)
    }
  }

  async setActive(chatId: string, active: boolean): Promise<void> {
    if (!active) return
    await this.bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {})
  }

  private refreshActions(actions?: Partial<InlineActions> | null) {
    if (!actions) {
      this.actionHandlers.clear()
      this.fallbackActions.clear()
      return
    }
    if (actions.items) {
      this.actionHandlers.clear()
      for (const action of actions.items) {
        this.actionHandlers.set(action.id, async (actionId) => {
          await actions.callback?.(actionId)
        })
      }
    }
    if (actions.callback && !actions.items) {
      for (const [id, handler] of this.actionHandlers) {
        this.actionHandlers.set(id, async (actionId) => {
          await actions.callback?.(actionId)
          await handler(actionId)
        })
      }
    }
  }
}

function extFromMime(mime: string): string {
  const idx = mime.indexOf('/')
  return idx === -1 ? 'bin' : mime.slice(idx + 1)
}

function toKeyboard(actions: { columns?: number; items: { id: string; label: string }[] }) {
  const kb = new InlineKeyboard()
  const columns = actions.columns ?? 2
  let col = 0
  for (const action of actions.items) {
    kb.text(action.label, action.id)
    col += 1
    if (col >= columns) {
      kb.row()
      col = 0
    }
  }
  return kb
}
