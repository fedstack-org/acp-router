import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy'
import { IMAdapter, logger, writeMediaCacheFile, type AdapterInteraction, type AnnotationKind, type InlineActions, type InlineMessage, type InlineUpdate, type InteractiveMessageKind, type MediaPayload, type ReactionKind, type TextMessageKind } from '@acp-router/core'
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
    this.bot.on('message_reaction', async (ctx) => {
      const reaction = ctx.messageReaction
      const chatId = String(reaction.chat.id)
      const messageId = String(reaction.message_id)
      const emojiMap: Record<string, AnnotationKind> = { '😭': 'skip', '🙏': 'block' }
      let kind: AnnotationKind | undefined
      for (const r of reaction.new_reaction) {
        if (r.type === 'emoji' && r.emoji in emojiMap) {
          kind = emojiMap[r.emoji]
          break
        }
      }
      logger.debug({ chatId, messageId, kind }, 'Annotation update')
      await this.emit('annotation', chatId, messageId, kind)
    })
    this.bot.on(':photo', async (ctx) => {
      await this.handleIncomingMedia(ctx, () => {
        const photo = ctx.message!.photo!
        const largest = photo[photo.length - 1]
        return {
          kind: 'image',
          fileId: largest.file_id,
          mimeType: 'image/jpeg',
          width: largest.width,
          height: largest.height,
          fileSize: largest.file_size,
        }
      })
    })
    this.bot.on(':video', async (ctx) => {
      await this.handleIncomingMedia(ctx, () => {
        const v = ctx.message!.video!
        return {
          kind: 'video',
          fileId: v.file_id,
          mimeType: v.mime_type ?? 'video/mp4',
          filename: v.file_name,
          duration: v.duration,
          width: v.width,
          height: v.height,
          fileSize: v.file_size,
        }
      })
    })
    this.bot.on(':audio', async (ctx) => {
      await this.handleIncomingMedia(ctx, () => {
        const a = ctx.message!.audio!
        return {
          kind: 'audio',
          fileId: a.file_id,
          mimeType: a.mime_type ?? 'audio/mpeg',
          filename: a.file_name,
          duration: a.duration,
          fileSize: a.file_size,
        }
      })
    })
    this.bot.on(':voice', async (ctx) => {
      await this.handleIncomingMedia(ctx, () => {
        const v = ctx.message!.voice!
        return {
          kind: 'voice',
          fileId: v.file_id,
          mimeType: v.mime_type ?? 'audio/ogg',
          duration: v.duration,
          fileSize: v.file_size,
        }
      })
    })
    this.bot.on(':document', async (ctx) => {
      if (ctx.message!.animation) return
      await this.handleIncomingMedia(ctx, () => {
        const d = ctx.message!.document!
        return {
          kind: 'document',
          fileId: d.file_id,
          mimeType: d.mime_type ?? 'application/octet-stream',
          filename: d.file_name,
          fileSize: d.file_size,
        }
      })
    })
    this.bot.on(':animation', async (ctx) => {
      await this.handleIncomingMedia(ctx, () => {
        const a = ctx.message!.animation!
        return {
          kind: 'animation',
          fileId: a.file_id,
          mimeType: a.mime_type ?? 'video/mp4',
          filename: a.file_name,
          duration: a.duration,
          width: a.width,
          height: a.height,
          fileSize: a.file_size,
        }
      })
    })
    this.bot.on(':video_note', async (ctx) => {
      await this.handleIncomingMedia(ctx, () => {
        const vn = ctx.message!.video_note!
        return {
          kind: 'video_note',
          fileId: vn.file_id,
          mimeType: 'video/mp4',
          duration: vn.duration,
          width: vn.length,
          height: vn.length,
          fileSize: vn.file_size,
        }
      })
    })
    this.bot.on(':sticker', async (ctx) => {
      await this.handleIncomingMedia(ctx, () => {
        const s = ctx.message!.sticker!
        return {
          kind: 'sticker',
          fileId: s.file_id,
          mimeType: s.is_video ? 'video/webm' : 'image/webp',
          width: s.width,
          height: s.height,
          fileSize: s.file_size,
        }
      })
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
    this.bot.start({
      allowed_updates: ['message', 'callback_query', 'message_reaction']
    })
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

  async sendMedia(chatId: string, payload: { kind: string; mimeType: string; filePath: string }): Promise<void> {
    return this.enqueue(chatId, async () => {
      logger.debug({ chatId, kind: payload.kind, mimeType: payload.mimeType, filePath: payload.filePath }, 'Sending media')
      const file = new InputFile(createReadStream(payload.filePath), basename(payload.filePath))
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

  async setReaction(chatId: string, messageId: string, kind: ReactionKind | undefined): Promise<void> {
    return this.enqueue(chatId, async () => {
      logger.debug({ chatId, messageId, kind }, 'Setting reaction')
      const emojiMap: Record<string, string> = {
        queued: '✍',
        pending: '👀',
        aborted: '🕊',
        ignored: '🤡'
      }
      const reaction = kind && emojiMap[kind]
        ? [{ type: 'emoji' as const, emoji: emojiMap[kind] as any }]
        : []
      await this.bot.api.setMessageReaction(Number(chatId), Number(messageId), reaction).catch((err) => {
        logger.warn({ chatId, messageId, kind, err }, 'Failed to set reaction')
      })
    })
  }

  private async handleIncomingMedia(
    ctx: Context,
    extract: () => {
      kind: MediaPayload['kind']
      fileId: string
      mimeType: string
      filename?: string
      duration?: number
      width?: number
      height?: number
      fileSize?: number
    }
  ): Promise<void> {
    const chatId = String(ctx.chat!.id)
    const messageId = String(ctx.message!.message_id)
    const caption = ctx.message?.caption
    let info: ReturnType<typeof extract>
    try {
      info = extract()
    } catch (err) {
      logger.warn({ chatId, err }, 'Failed to extract media info')
      return
    }
    logger.debug({ chatId, kind: info.kind, mimeType: info.mimeType }, 'Received media message')
    try {
      const file = await ctx.api.getFile(info.fileId)
      if (!file.file_path) {
        logger.warn({ chatId, fileId: info.fileId }, 'No file_path returned from getFile')
        return
      }
      const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) {
        logger.warn({ chatId, status: res.status }, 'Failed to download file from Telegram')
        return
      }
      const data = new Uint8Array(await res.arrayBuffer())
      const filePath = await writeMediaCacheFile(chatId, info.mimeType, data)
      const payload: MediaPayload = {
        kind: info.kind,
        mimeType: info.mimeType,
        filePath,
        filename: info.filename,
        caption,
        duration: info.duration,
        width: info.width,
        height: info.height,
        fileSize: info.fileSize ?? data.length,
      }
      await this.emit('media', chatId, messageId, payload)
    } catch (err) {
      logger.error({ chatId, kind: info.kind, err }, 'Failed to handle incoming media')
    }
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
