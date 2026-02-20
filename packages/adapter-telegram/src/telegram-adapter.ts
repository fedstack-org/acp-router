import { Bot, InlineKeyboard, InputFile } from 'grammy'
import { IMAdapter, logger, type AdapterInteraction, type InlineActions, type InlineMessage, type InlineUpdate, type InteractiveMessageKind, type TextMessageKind } from '@acp-router/core'
import { markdownToTelegramHtml } from './markdown.js'

export class TelegramAdapter extends IMAdapter {
  readonly platform = 'telegram'
  private bot: Bot
  private actionHandlers = new Map<string, (actionId: string) => Promise<void>>()
  private fallbackActions = new Map<string, (actionId: string) => Promise<void>>()
  private sendQueues = new Map<string, Promise<void>>()
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(private token: string, private allowList: number[]) {
    super()
    this.bot = new Bot(token)
  }

  private enqueue<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sendQueues.get(chatId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.sendQueues.set(chatId, next.then(() => {}, () => {}))
    return next
  }

  async init(): Promise<void> {
    logger.debug('Initializing Telegram adapter')
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id
      const chatType = ctx.chat?.type
      logger.debug({ chatId, chatType, hasMessage: !!ctx.message, hasCallback: !!ctx.callbackQuery }, 'Incoming update')
      if (!chatId || !this.allowList.includes(chatId)) {
        logger.debug({ chatId }, 'Chat not in allow list, ignoring')
        return
      }
      if (chatType !== 'private') {
        logger.debug({ chatId, chatType }, 'Non-private chat, ignoring')
        return
      }
      await next()
    })
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text
      const chatId = String(ctx.chat.id)
      if (text.startsWith('/')) {
        logger.debug({ chatId, text }, 'Received command message')
        const parts = text.slice(1).trim().split(' ')
        const command = parts[0]
        const args = parts.slice(1).filter(Boolean)
        logger.debug({ chatId, command, args }, 'Dispatching command')
        await this.emit('command', chatId, String(ctx.message.message_id), command, args)
      } else {
        logger.debug({ chatId, textLength: text.length }, 'Received text message')
        await this.emit('text', chatId, String(ctx.message.message_id), text)
      }
    })
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery?.data
      if (!data) return
      logger.debug({ data }, 'Received callback query')
      const handler = this.actionHandlers.get(data) ?? this.fallbackActions.get(data)
      if (!handler) {
        logger.debug({ data }, 'No handler found for callback query')
        return
      }
      await handler(data)
      await ctx.answerCallbackQuery().catch(() => {})
    })
    this.bot.catch((err) => logger.error({ err }, 'Telegram adapter error'))
    this.bot.start()
    logger.debug('Telegram bot polling started')
  }

  async sendTextMessage(chatId: string, text: string, kind: TextMessageKind = 'message'): Promise<void> {
    return this.enqueue(chatId, async () => {
      logger.debug({ chatId, textLength: text.length, kind }, 'Sending message')
      if (kind === 'thought') {
        try {
          const innerHtml = markdownToTelegramHtml(text)
          const html = `<blockquote expandable>\u{1F4AD} <b>Thinking</b>\n\n${innerHtml}</blockquote>`
          await this.bot.api.sendMessage(Number(chatId), html, { parse_mode: 'HTML' })
        } catch (err) {
          logger.warn({ chatId, err }, 'Failed to send thought as expandable blockquote, falling back')
          try {
            const html = markdownToTelegramHtml(`> **Thinking**\n>\n> ${text.replace(/\n/g, '\n> ')}`)
            await this.bot.api.sendMessage(Number(chatId), html, { parse_mode: 'HTML' })
          } catch {
            await this.bot.api.sendMessage(Number(chatId), `\u{1F4AD} Thinking\n\n${text}`).catch((err2) => {
              logger.warn({ chatId, err: err2 }, 'Failed to send thought fallback')
            })
          }
        }
      } else {
        try {
          const html = markdownToTelegramHtml(text)
          await this.bot.api.sendMessage(Number(chatId), html, { parse_mode: 'HTML' })
        } catch (err) {
          logger.warn({ chatId, err }, 'Failed to send as HTML, falling back to plain text')
          await this.bot.api.sendMessage(Number(chatId), text).catch((err2) => {
            logger.warn({ chatId, err: err2 }, 'Failed to send plain text fallback')
          })
        }
      }
    })
  }

  async sendMedia(chatId: string, payload: { kind: string; mimeType: string; data: Uint8Array; filename?: string }): Promise<void> {
    return this.enqueue(chatId, async () => {
      logger.debug({ chatId, kind: payload.kind, mimeType: payload.mimeType, size: payload.data.length }, 'Sending media')
      const file = new InputFile(Buffer.from(payload.data), payload.filename ?? `file.${extFromMime(payload.mimeType)}`)
      if (payload.kind === 'image') {
        await this.bot.api.sendPhoto(Number(chatId), file).catch((err) => logger.warn({ chatId, err }, 'Failed to send photo'))
        return
      }
      if (payload.kind === 'audio') {
        await this.bot.api.sendAudio(Number(chatId), file).catch((err) => logger.warn({ chatId, err }, 'Failed to send audio'))
        return
      }
      if (payload.kind === 'video') {
        await this.bot.api.sendVideo(Number(chatId), file).catch((err) => logger.warn({ chatId, err }, 'Failed to send video'))
        return
      }
      await this.bot.api.sendDocument(Number(chatId), file).catch((err) => logger.warn({ chatId, err }, 'Failed to send document'))
    })
  }

  async setCommands(commands: { name: string; description: string }[]): Promise<void> {
    await this.bot.api.setMyCommands(commands.map((cmd) => ({ command: cmd.name, description: cmd.description }))).catch(() => {})
    logger.debug({ count: commands.length }, 'Telegram commands updated')
  }

  async sendInteractiveMessage(chatId: string, message: InlineMessage, kind: InteractiveMessageKind = 'generic'): Promise<AdapterInteraction> {
    return this.enqueue(chatId, async () => {
      logger.debug({ chatId, actionsCount: message.actions?.items.length ?? 0 }, 'Sending interactive message')
      const kb = message.actions ? toKeyboard(message.actions) : undefined
      let html: string
      try {
        html = markdownToTelegramHtml(message.markdown)
      } catch {
        html = message.markdown
      }
      const sent = await this.bot.api
        .sendMessage(Number(chatId), html, { parse_mode: 'HTML', reply_markup: kb })
        .catch((err) => {
          logger.warn({ chatId, err }, 'Failed to send interactive message')
          return null
        })
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
    })
  }

  async editInteractiveMessage(chatId: string, messageId: string, update: InlineUpdate): Promise<void> {
    return this.enqueue(chatId, async () => {
      logger.debug({ chatId, messageId, hasMarkdown: update.markdown != null, hasActions: 'actions' in update }, 'Updating interactive message')
      const nextActions = 'actions' in update ? update.actions : undefined
      const removeKb = 'actions' in update && !update.actions
      const kb = nextActions ? toKeyboard(nextActions as InlineActions) : removeKb ? new InlineKeyboard() : undefined
      if (update.markdown != null) {
        let html: string
        try {
          html = markdownToTelegramHtml(update.markdown)
        } catch {
          html = update.markdown
        }
        await this.bot.api
          .editMessageText(Number(chatId), Number(messageId), html, {
            parse_mode: 'HTML',
            reply_markup: kb
          })
          .catch((err) => {
            logger.warn({ chatId, messageId, err }, 'Failed to edit message text')
          })
        this.refreshActions(nextActions)
        return
      }
      if ('actions' in update) {
        await this.bot.api
          .editMessageReplyMarkup(Number(chatId), Number(messageId), {
            reply_markup: kb
          })
          .catch((err) => {
            logger.warn({ chatId, messageId, err }, 'Failed to edit message reply markup')
          })
        this.refreshActions(nextActions)
      }
    })
  }

  async setActive(chatId: string, active: boolean): Promise<void> {
    logger.debug({ chatId, active }, 'Setting chat active state')
    const existing = this.typingTimers.get(chatId)
    if (existing) {
      clearInterval(existing)
      this.typingTimers.delete(chatId)
    }
    if (!active) return
    const sendTyping = () => {
      this.bot.api.sendChatAction(Number(chatId), 'typing').catch((err) => {
        logger.warn({ chatId, err }, 'Failed to send typing action')
      })
    }
    sendTyping()
    this.typingTimers.set(chatId, setInterval(sendTyping, 5000))
  }

  async setReaction(chatId: string, messageId: string, kind: 'queued' | 'aborted' | 'ignored' | undefined): Promise<void> {
    return this.enqueue(chatId, async () => {
      logger.debug({ chatId, messageId, kind }, 'Setting reaction')
      const reaction = kind === 'queued'
        ? [{ type: 'emoji' as const, emoji: '✍' as const }]
        : kind === 'aborted'
          ? [{ type: 'emoji' as const, emoji: '🕊' as const }]
          : kind === 'ignored'
            ? [{ type: 'emoji' as const, emoji: '🤡' as const }]
            : []
      await this.bot.api.setMessageReaction(Number(chatId), Number(messageId), reaction).catch((err) => {
        logger.warn({ chatId, messageId, kind, err }, 'Failed to set reaction')
      })
    })
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
