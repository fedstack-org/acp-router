import { Bot, InlineKeyboard, type Context } from 'grammy'
import * as acp from '@agentclientprotocol/sdk'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { Config } from './config.js'

const CACHE_PATH = join(homedir(), '.config', 'acp-router.cache.json')

interface SessionCache {
  sessionId: string
  cwd: string
}

async function loadCache(): Promise<SessionCache | null> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf-8'))
  } catch {
    return null
  }
}

async function saveCache(cache: SessionCache): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true })
    await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2))
  } catch {
    /* non-critical */
  }
}

const TYPING_INTERVAL_MS = 4000
const MAX_MESSAGE_LENGTH = 4096
const MODEL_PAGE_SIZE = 8
const MODEL_COLS = 2

const BUILTIN_COMMANDS = [
  { command: 'start', description: 'Start a new Droid session' },
  { command: 'cancel', description: 'Cancel current operation' },
  { command: 'help', description: 'Show available commands' },
  { command: 'mode', description: 'View/change session mode' },
  { command: 'model', description: 'View/change session model' }
]

class RouterClient implements acp.Client {
  conn!: acp.ClientSideConnection
  proc!: ReturnType<typeof Bun.spawn>
  sessionId = ''
  agentInfo: acp.Implementation | null = null
  sessionTitle = ''
  configOptions: acp.SessionConfigOption[] = []
  availableCommands: acp.AvailableCommand[] = []
  modes: acp.SessionModeState | null = null
  models: acp.SessionModelState | null = null
  typingInterval: ReturnType<typeof setInterval> | null = null
  agentText = ''
  thought = ''
  toolMsgs = new Map<string, number>()
  pendingPerms = new Map<string, (r: acp.RequestPermissionResponse) => void>()
  busy = false

  constructor(
    private chatId: number,
    private ctx: Context
  ) {}

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pendingPerms.set(params.toolCall.toolCallId, resolve)
      const kb = new InlineKeyboard()
      let row = 0
      for (const o of params.options) {
        kb.text(`${permIcon(o.kind)} ${o.name}`, `perm:${params.toolCall.toolCallId}:${o.optionId}`)
        if (++row % 2 === 0) kb.row()
      }
      this.ctx.api
        .sendMessage(this.chatId, `<b>Permission requested:</b>\n<code>${esc(params.toolCall.title ?? 'Unknown')}</code>`, {
          parse_mode: 'HTML',
          reply_markup: kb
        })
        .catch(() => {})
    })
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') this.agentText += u.content.text
        break
      case 'agent_thought_chunk':
        if (u.content.type === 'text') this.thought += u.content.text
        break
      case 'tool_call':
        try {
          const msg = await this.ctx.api.sendMessage(this.chatId, `${toolIcon(u.kind)} <code>${esc(u.title)}</code>`, {
            parse_mode: 'HTML'
          })
          this.toolMsgs.set(u.toolCallId, msg.message_id)
        } catch {
          /* non-critical */
        }
        break
      case 'tool_call_update': {
        const msgId = this.toolMsgs.get(u.toolCallId)
        if (!msgId) break
        const icon = u.status === 'completed' ? '\u2705' : u.status === 'failed' ? '\u274C' : '\u23F3'
        try {
          await this.ctx.api.editMessageText(this.chatId, msgId, `${icon} <code>${esc(u.title ?? 'Tool operation')}</code>`, {
            parse_mode: 'HTML'
          })
        } catch {
          /* ignore */
        }
        break
      }
      case 'available_commands_update':
        this.availableCommands = u.availableCommands
        console.log('[droid] Commands:', u.availableCommands.map((c) => c.name).join(', '))
        await this.syncCommands()
        break
      case 'config_option_update':
        this.configOptions = u.configOptions
        logConfigOptions(u.configOptions)
        await this.syncCommands()
        break
      case 'current_mode_update':
        if (this.modes) {
          this.modes.currentModeId = u.currentModeId
          console.log('[droid] Mode changed to:', u.currentModeId)
        }
        break
      case 'session_info_update':
        if (u.title != null) this.sessionTitle = u.title
        break
    }
  }

  async syncCommands() {
    const cmds = [...BUILTIN_COMMANDS]
    for (const c of this.availableCommands) cmds.push({ command: tgCmd(c.name), description: c.description })
    for (const o of this.configOptions) {
      const cur = flatOpts(o).find((v) => v.value === o.currentValue)?.name ?? o.currentValue
      cmds.push({ command: `set_${tgCmd(o.id)}`, description: `${o.name} [${cur}]` })
    }
    try {
      await this.ctx.api.setMyCommands(cmds)
    } catch {
      /* ignore */
    }
  }

  clearTyping() {
    if (this.typingInterval) {
      clearInterval(this.typingInterval)
      this.typingInterval = null
    }
  }

  destroy() {
    this.clearTyping()
    this.proc.kill()
  }
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramBotToken)
  const chats = new Map<number, RouterClient>()

  bot.api.setMyCommands(BUILTIN_COMMANDS).catch(() => {})

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id
    if (!chatId || !config.allowedChatIds.includes(chatId)) return
    if (ctx.chat?.type !== 'private') return
    await next()
  })

  bot.command('start', async (ctx) => {
    if (chats.has(ctx.chat.id)) return void (await ctx.reply('Session already active. Just send a message.'))
    await initChat(ctx.chat.id, ctx, config, chats)
  })

  bot.command('cancel', async (ctx) => {
    const c = chats.get(ctx.chat.id)
    if (!c) return void (await ctx.reply('No active session.'))
    c.conn.cancel({ sessionId: c.sessionId })
    await ctx.reply('Cancellation requested.')
  })

  bot.command('help', async (ctx) => {
    const c = chats.get(ctx.chat.id)
    let text = '<b>Built-in commands:</b>\n'
    for (const cmd of BUILTIN_COMMANDS) text += `/${cmd.command} — ${esc(cmd.description)}\n`
    if (c) {
      if (c.availableCommands.length) {
        text += '\n<b>Agent commands:</b>\n'
        for (const cmd of c.availableCommands) {
          const hint = cmd.input ? ` <i>${esc(cmd.input.hint)}</i>` : ''
          text += `/${tgCmd(cmd.name)}${hint} — ${esc(cmd.description)}\n`
        }
      }
      if (c.configOptions.length) {
        text += '\n<b>Config options:</b>\n'
        for (const o of c.configOptions) {
          const cur = flatOpts(o).find((v) => v.value === o.currentValue)?.name ?? o.currentValue
          text += `/set_${tgCmd(o.id)} — ${esc(o.name)} [${esc(cur)}]\n`
        }
      }
    } else {
      text += '\nNo active session. Send /start or any message to begin.'
    }
    await ctx.reply(text, { parse_mode: 'HTML' })
  })

  bot.command('mode', async (ctx) => {
    const c = chats.get(ctx.chat.id)
    if (!c) return void (await ctx.reply('No active session.'))
    if (!c.modes) return void (await ctx.reply('Modes not available.'))
    const cur = c.modes.availableModes.find((m) => m.id === c.modes!.currentModeId)
    const kb = new InlineKeyboard()
    for (const m of c.modes.availableModes) {
      kb.text(`${m.id === c.modes.currentModeId ? '\u2713 ' : ''}${m.name}`, `mode:${m.id}`).row()
    }
    kb.text('\u274C Cancel', 'mode:__cancel__')
    await ctx.reply(`<b>Session Mode</b>\nCurrent: <code>${esc(cur?.name ?? c.modes.currentModeId)}</code>`, {
      parse_mode: 'HTML',
      reply_markup: kb
    })
  })

  bot.command('model', async (ctx) => {
    const c = chats.get(ctx.chat.id)
    if (!c) return void (await ctx.reply('No active session.'))
    if (!c.models) return void (await ctx.reply('Models not available.'))
    const cur = c.models.availableModels.find((m) => m.modelId === c.models!.currentModelId)
    const kb = modelPageKb(c.models, 0)
    await ctx.reply(`<b>Session Model</b>\nCurrent: <code>${esc(cur?.name ?? c.models.currentModelId)}</code>`, {
      parse_mode: 'HTML',
      reply_markup: kb
    })
  })

  bot.on('callback_query:data', async (ctx) => {
    const c = chats.get(ctx.chat!.id)
    if (!c) {
      await ctx.answerCallbackQuery({ text: 'Session expired. Send /start to begin a new session.' })
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
      return
    }
    const [prefix, id, value] = ctx.callbackQuery.data.split(':')
    if (prefix === 'perm') {
      const resolve = c.pendingPerms.get(id)
      if (!resolve) return
      c.pendingPerms.delete(id)
      resolve(
        value === '__reject__' ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: value } }
      )
      await ctx.answerCallbackQuery({ text: `Selected: ${value}` })
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    } else if (prefix === 'mode') {
      const modeId = ctx.callbackQuery.data.slice('mode:'.length)
      if (modeId === '__cancel__') {
        await ctx.answerCallbackQuery({ text: 'Cancelled' })
        await ctx.editMessageReplyMarkup({ reply_markup: undefined })
        return
      }
      if (!c.modes) return
      const oldId = c.modes.currentModeId
      const target = c.modes.availableModes.find((m) => m.id === modeId)
      const targetName = target?.name ?? modeId
      if (modeId === oldId) {
        await ctx.answerCallbackQuery({ text: `Already in ${targetName}` })
        await ctx.editMessageText(`Mode remains to be <b>${esc(targetName)}</b> (<code>${esc(modeId)}</code>)`, { parse_mode: 'HTML' })
        return
      }
      try {
        await c.conn.setSessionMode({ sessionId: c.sessionId, modeId })
        c.modes.currentModeId = modeId
        await ctx.answerCallbackQuery({ text: `Mode \u2192 ${targetName}` })
        await ctx.editMessageText(`Mode changed to <b>${esc(targetName)}</b> (<code>${esc(modeId)}</code>)`, { parse_mode: 'HTML' })
      } catch (err) {
        await ctx.answerCallbackQuery({ text: `Error: ${err instanceof Error ? err.message : err}` })
      }
    } else if (prefix === 'model') {
      const modelId = ctx.callbackQuery.data.slice('model:'.length)
      if (modelId === '__cancel__') {
        await ctx.answerCallbackQuery({ text: 'Cancelled' })
        await ctx.editMessageReplyMarkup({ reply_markup: undefined })
        return
      }
      if (!c.models) return
      const oldId = c.models.currentModelId
      const target = c.models.availableModels.find((m) => m.modelId === modelId)
      const targetName = target?.name ?? modelId
      if (modelId === oldId) {
        await ctx.answerCallbackQuery({ text: `Already using ${targetName}` })
        await ctx.editMessageText(`Model remains to be <b>${esc(targetName)}</b> (<code>${esc(modelId)}</code>)`, { parse_mode: 'HTML' })
        return
      }
      try {
        await c.conn.unstable_setSessionModel({ sessionId: c.sessionId, modelId })
        c.models.currentModelId = modelId
        await ctx.answerCallbackQuery({ text: `Model \u2192 ${targetName}` })
        await ctx.editMessageText(`Model changed to <b>${esc(targetName)}</b> (<code>${esc(modelId)}</code>)`, { parse_mode: 'HTML' })
      } catch (err) {
        await ctx.answerCallbackQuery({ text: `Error: ${err instanceof Error ? err.message : err}` })
      }
    } else if (prefix === 'modelpage') {
      const suffix = ctx.callbackQuery.data.slice('modelpage:'.length)
      if (suffix === '_noop') return void (await ctx.answerCallbackQuery())
      if (!c.models) return
      const page = parseInt(suffix, 10)
      await ctx.answerCallbackQuery()
      await ctx.editMessageReplyMarkup({ reply_markup: modelPageKb(c.models, page) })
    } else if (prefix === 'cfg') {
      try {
        const result = await c.conn.setSessionConfigOption({ sessionId: c.sessionId, configId: id, value })
        c.configOptions = result.configOptions
        const opt = result.configOptions.find((o) => o.id === id)
        const flat = opt ? flatOpts(opt) : []
        await ctx.answerCallbackQuery({
          text: `${opt?.name ?? id} \u2192 ${flat.find((o) => o.value === value)?.name ?? value}`
        })
        if (opt) await ctx.editMessageText(configMsg(opt), { parse_mode: 'HTML', reply_markup: configKb(opt) })
        else await ctx.editMessageReplyMarkup({ reply_markup: undefined })
        await c.syncCommands()
      } catch (err) {
        await ctx.answerCallbackQuery({ text: `Error: ${err instanceof Error ? err.message : err}` })
      }
    }
  })

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id
    let c: RouterClient | undefined = chats.get(chatId)

    if (!c) {
      c = (await initChat(chatId, ctx, config, chats)) ?? undefined
      if (!c) return
    }
    if (c.conn.signal.aborted) {
      await ctx.reply('Reinitializing session...')
      c.destroy()
      chats.delete(chatId)
      c = (await initChat(chatId, ctx, config, chats)) ?? undefined
      if (!c) return
    }

    const text = ctx.message.text

    if (text.startsWith('/set_')) {
      const m = text.match(/^\/set_(\S+)/)
      if (!m) return
      const opt = c.configOptions.find((o) => tgCmd(o.id) === m[1])
      if (!opt) return void (await ctx.reply(`Unknown config option: ${m[1]}`))
      return void (await ctx.reply(configMsg(opt), { parse_mode: 'HTML', reply_markup: configKb(opt) }))
    }

    if (text.startsWith('/')) {
      const si = text.indexOf(' ')
      const name = (si === -1 ? text.slice(1) : text.slice(1, si)).toLowerCase()
      if (['start', 'cancel', 'help', 'mode', 'model'].includes(name)) return
      const args = si === -1 ? '' : text.slice(si + 1)
      const cmd = c.availableCommands.find((x) => tgCmd(x.name) === name)
      if (cmd) return void (await doPrompt(ctx, c, args ? `/${cmd.name} ${args}` : `/${cmd.name}`))
      return void (await ctx.reply(`Unknown command: /${name}`))
    }

    await doPrompt(ctx, c, text)
  })

  return bot
}

async function doPrompt(ctx: Context, c: RouterClient, text: string) {
  if (c.busy) return void (await ctx.reply('Still processing. Please wait.'))
  c.busy = true
  c.agentText = ''
  c.thought = ''
  const chatId = ctx.chat!.id
  const tick = () => ctx.api.sendChatAction(chatId, 'typing').catch(() => {})
  tick()
  c.typingInterval = setInterval(tick, TYPING_INTERVAL_MS)

  try {
    const r = await c.conn.prompt({ sessionId: c.sessionId, prompt: [{ type: 'text', text }] })
    c.clearTyping()
    if (c.thought.trim()) await sendSplit(ctx, `<b>Thinking:</b>\n${esc(c.thought)}`)
    if (c.agentText.trim()) await sendSplit(ctx, c.agentText)
    if (r.stopReason !== 'end_turn') await ctx.reply(`Turn ended: ${r.stopReason}`)
  } catch (err) {
    c.clearTyping()
    await ctx.reply(`Error: ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: 'HTML' })
  } finally {
    c.busy = false
  }
}

async function initChat(
  chatId: number,
  ctx: Context,
  config: Config,
  chats: Map<number, RouterClient>
): Promise<RouterClient | null> {
  const args = ['exec', '--output-format', 'acp']
  const d = config.droid
  if (d.model) args.push('-m', d.model)
  if (d.autoLevel) args.push('--auto', d.autoLevel)
  if (d.reasoningEffort) args.push('-r', d.reasoningEffort)

  const proc = Bun.spawn(['droid', ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' }
  })
  readStderr(proc, chatId)

  const stdin = proc.stdin as unknown as { write(d: string | Uint8Array): number; end(): void }
  const writable = new WritableStream<Uint8Array>({
    write(ch) {
      stdin.write(ch)
    },
    close() {
      stdin.end()
    }
  })
  const stream = acp.ndJsonStream(writable, proc.stdout as ReadableStream<Uint8Array>)

  const c = new RouterClient(chatId, ctx)
  c.proc = proc
  c.conn = new acp.ClientSideConnection(() => c, stream)
  c.conn.signal.addEventListener('abort', () => console.log(`[droid:${chatId}] closed`))

  try {
    await ctx.reply('Starting Droid session...')
    const init = await c.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'acp-router', title: 'ACP Router (Telegram)', version: '0.1.0' }
    })
    console.log('[droid] === Initialize ===')
    console.log('[droid] Protocol:', init.protocolVersion)
    console.log('[droid] Agent:', JSON.stringify(init.agentInfo, null, 2))
    console.log('[droid] Capabilities:', JSON.stringify(init.agentCapabilities, null, 2))
    if (init.authMethods) console.log('[droid] Auth:', JSON.stringify(init.authMethods, null, 2))
    c.agentInfo = init.agentInfo ?? null

    const cwd = d.cwd ?? process.cwd()
    const caps = init.agentCapabilities?.sessionCapabilities
    let resumed = false

    if (caps?.resume) {
      const cached = await loadCache()
      if (cached && cached.cwd === cwd) {
        try {
          console.log('[droid] Resuming cached session:', cached.sessionId)
          const s = await c.conn.unstable_resumeSession({ sessionId: cached.sessionId, cwd })
          c.sessionId = cached.sessionId
          applySessionState(c, s)
          resumed = true
        } catch (err) {
          console.log('[droid] Resume failed, creating new session:', err instanceof Error ? err.message : err)
        }
      }
    }

    if (!resumed) {
      const s = await c.conn.newSession({ cwd, mcpServers: [] })
      c.sessionId = s.sessionId
      applySessionState(c, s)
    }

    await saveCache({ sessionId: c.sessionId, cwd })
    chats.set(chatId, c)
    await c.syncCommands()
    await ctx.reply(sessionInfoMsg(c, resumed), { parse_mode: 'HTML' })
    return c
  } catch (err) {
    proc.kill()
    await ctx.reply(`Failed to start Droid: ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: 'HTML' })
    return null
  }
}

// --- helpers ---

function applySessionState(c: RouterClient, s: { configOptions?: acp.SessionConfigOption[] | null; modes?: acp.SessionModeState | null; models?: acp.SessionModelState | null }) {
  console.log('[droid] Session:', c.sessionId)
  if (s.configOptions) {
    c.configOptions = s.configOptions
    logConfigOptions(s.configOptions)
  }
  if (s.modes) {
    c.modes = s.modes
    console.log('[droid] Modes:', JSON.stringify(s.modes, null, 2))
  }
  if (s.models) {
    c.models = s.models
    console.log('[droid] Models:', JSON.stringify(s.models, null, 2))
  }
}

function sessionInfoMsg(c: RouterClient, resumed: boolean): string {
  const lines: string[] = []
  lines.push(resumed ? '<b>Resumed session</b>' : '<b>New session</b>')
  lines.push(`Session ID: <code>${esc(c.sessionId)}</code>`)
  if (c.sessionTitle) lines.push(`Title: ${esc(c.sessionTitle)}`)
  if (c.modes) lines.push(`Modes:\n${c.modes.availableModes.map((m) => `  \u2022 <code>${esc(m.name)}</code>`).join('\n')}`)
  if (c.models) lines.push(`Models:\n${c.models.availableModels.map((m) => `  \u2022 <code>${esc(m.name)}</code>`).join('\n')}`)
  if (c.configOptions.length) lines.push(`Options: ${c.configOptions.map((o) => esc(o.name)).join(', ')}`)
  return lines.join('\n')
}

async function readStderr(proc: ReturnType<typeof Bun.spawn>, chatId: number) {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const t = dec.decode(value, { stream: true })
      if (t.trim()) console.error(`[droid:${chatId}] stderr: ${t.trim()}`)
    }
  } catch {
    /* closed */
  }
}

function logConfigOptions(opts: acp.SessionConfigOption[]) {
  console.log('[droid] Config options:')
  for (const o of opts) {
    const vals = flatOpts(o).map((v) => (v.value === o.currentValue ? `[${v.name}]` : v.name))
    console.log(`[droid]   ${o.id} (${o.category ?? 'none'}): ${vals.join(', ')}`)
  }
}

function flatOpts(opt: acp.SessionConfigOption): acp.SessionConfigSelectOption[] {
  if (opt.options.length === 0) return []
  if ('group' in opt.options[0]) return (opt.options as acp.SessionConfigSelectGroup[]).flatMap((g) => g.options)
  return opt.options as acp.SessionConfigSelectOption[]
}

function modelPageKb(state: acp.SessionModelState, page: number): InlineKeyboard {
  const all = state.availableModels
  const pages = Math.ceil(all.length / MODEL_PAGE_SIZE)
  const start = page * MODEL_PAGE_SIZE
  const slice = all.slice(start, start + MODEL_PAGE_SIZE)
  const kb = new InlineKeyboard()
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i]
    kb.text(`${m.modelId === state.currentModelId ? '\u2713 ' : ''}${m.name}`, `model:${m.modelId}`)
    if ((i + 1) % MODEL_COLS === 0 || i === slice.length - 1) kb.row()
  }
  if (pages > 1) {
    if (page > 0) kb.text('\u25C0 Prev', `modelpage:${page - 1}`)
    kb.text(`${page + 1}/${pages}`, 'modelpage:_noop')
    if (page < pages - 1) kb.text('Next \u25B6', `modelpage:${page + 1}`)
    kb.row()
  }
  kb.text('\u274C Cancel', 'model:__cancel__')
  return kb
}

function configKb(opt: acp.SessionConfigOption): InlineKeyboard {
  const kb = new InlineKeyboard()
  const flat = flatOpts(opt)
  for (let i = 0; i < flat.length; i++) {
    kb.text(`${flat[i].value === opt.currentValue ? '\u2713 ' : ''}${flat[i].name}`, `cfg:${opt.id}:${flat[i].value}`)
    if ((i + 1) % 2 === 0) kb.row()
  }
  return kb
}

function configMsg(opt: acp.SessionConfigOption): string {
  const d = opt.description ? `\n${esc(opt.description)}` : ''
  return `<b>${esc(opt.name)}</b>${d}\nCurrent: <code>${esc(opt.currentValue)}</code>`
}

async function sendSplit(ctx: Context, text: string) {
  let r = text
  while (r.length > MAX_MESSAGE_LENGTH) {
    let at = r.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH)
    if (at < MAX_MESSAGE_LENGTH / 2) at = r.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
    if (at < MAX_MESSAGE_LENGTH / 2) at = MAX_MESSAGE_LENGTH
    await ctx.reply(r.slice(0, at), { parse_mode: 'HTML' })
    r = r.slice(at).trimStart()
  }
  if (r) await ctx.reply(r, { parse_mode: 'HTML' })
}

function esc(t: string) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function tgCmd(n: string) {
  return n.toLowerCase().replace(/[^a-z0-9_]/g, '_')
}

function toolIcon(kind?: acp.ToolKind) {
  switch (kind) {
    case 'read':
      return '\uD83D\uDCD6'
    case 'edit':
      return '\u270F\uFE0F'
    case 'delete':
      return '\uD83D\uDDD1\uFE0F'
    case 'execute':
      return '\u26A1'
    case 'search':
      return '\uD83D\uDD0D'
    case 'fetch':
      return '\uD83C\uDF10'
    case 'think':
      return '\uD83D\uDCAD'
    default:
      return '\uD83D\uDD27'
  }
}

function permIcon(kind: string) {
  switch (kind) {
    case 'allow_once':
      return '\u2705'
    case 'allow_always':
      return '\uD83D\uDCCB'
    case 'reject_once':
      return '\u274C'
    case 'reject_always':
      return '\uD83D\uDEAB'
    default:
      return '\u2753'
  }
}
