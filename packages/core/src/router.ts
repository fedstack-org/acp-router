import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentLaunchRequest,
  AgentLauncher,
  AgentProcess,
  AgentRegistryEntry,
  AgentRegistrySnapshot,
  AvailableCommand,
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionCacheStore,
  SessionConfigOption,
  SessionModeState,
  SessionModelState
} from './types.js'
import { normalizeContent } from './content.js'
import { CLIENT_INFO } from './constants.js'
import { IMAdapter, type InlineMessage } from './im-adapter.js'
import { logger } from './logger.js'

export interface RouterSessionState {
  sessionId: string
  title?: string
  modes?: SessionModeState
  models?: SessionModelState
  configOptions: SessionConfigOption[]
  availableCommands: AvailableCommand[]
}

export interface RouterClientState {
  agentInfo: acp.Implementation | null
  session: RouterSessionState | null
}

const TEXT_FLUSH_DELAY = 3000
const TEXT_FLUSH_MAX_LEN = 3500

export const BUILT_IN_COMMANDS = [
  { name: 'start', description: 'Start a session' },
  { name: 'cancel', description: 'Cancel current prompt turn' },
  { name: 'clear', description: 'Create a new session' },
  { name: 'help', description: 'Show available commands' },
  { name: 'agent', description: 'Get/set agent' },
  { name: 'mode', description: 'Get/set mode' },
  { name: 'model', description: 'Get/set model' },
  { name: 'config', description: 'Get/set config' },
]

export class RouterClient implements acp.Client {
  conn!: acp.ClientSideConnection
  sessionId = ''
  agentInfo: acp.Implementation | null = null
  title = ''
  configOptions: SessionConfigOption[] = []
  availableCommands: AvailableCommand[] = []
  modes: SessionModeState | null = null
  models: SessionModelState | null = null

  private textBuffer = ''
  private textBufferKind: 'thought' | 'message' = 'message'
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private toolCalls = new Map<string, { messageId: string; title: string }>()
  private pendingPermissions = new Map<string, (res: RequestPermissionResponse) => void>()
  private updateQueue: Promise<void> = Promise.resolve()
  muteUpdates = false
  statusMessageId: string | null = null

  constructor(
    private adapter: IMAdapter,
    private chatId: string,
    private permissions: { timeoutMs: number | null }
  ) {}

  get state(): RouterClientState {
    return {
      agentInfo: this.agentInfo,
      session: this.sessionId
        ? {
            sessionId: this.sessionId,
            title: this.title,
            modes: this.modes ?? undefined,
            models: this.models ?? undefined,
            configOptions: this.configOptions,
            availableCommands: this.availableCommands
          }
        : null,
    }
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const toolCallId = params.toolCall.toolCallId
    logger.debug({ chatId: this.chatId, toolCallId }, 'Permission requested')
    await this.adapter.setActive(this.chatId, false)
    const result = await this.presentToolApproval(params)
    await this.adapter.setActive(this.chatId, true)
    this.pendingPermissions.delete(toolCallId)
    const tc = this.toolCalls.get(toolCallId)
    logger.debug({ chatId: this.chatId, toolCallId, messageId: tc?.messageId, outcome: result.outcome.outcome }, 'Permission resolved')
    if (tc) {
      const label = result.outcome.outcome === 'cancelled' ? 'cancelled' : result.outcome.outcome === 'selected' ? 'approved' : 'resolved'
      await this.adapter.editInteractiveMessage(this.chatId, tc.messageId, {
        markdown: `**Permission ${label}:** ${tc.title}`,
        actions: null
      })
    } else {
      logger.warn({ chatId: this.chatId, toolCallId }, 'No message found for permission resolution')
    }
    return result
  }

  async cancelPendingOperations(): Promise<void> {
    for (const [id, resolve] of this.pendingPermissions) {
      logger.debug({ chatId: this.chatId, toolCallId: id }, 'Cancelling pending permission')
      resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.pendingPermissions.clear()
    for (const [id, tc] of this.toolCalls) {
      await this.adapter.editInteractiveMessage(this.chatId, tc.messageId, {
        markdown: `**Tool cancelled:** ${tc.title}`,
        actions: null
      }).catch(() => {})
    }
    this.toolCalls.clear()
    await this.flushTextBuffer()
  }

  reset(): void {
    this.toolCalls.clear()
    this.pendingPermissions.clear()
    this.textBuffer = ''
    this.textBufferKind = 'message'
    this.title = ''
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.updateQueue.then(fn, fn)
    this.updateQueue = task.then(() => {}, () => {})
    return task
  }

  async drainQueue(): Promise<void> {
    await this.updateQueue
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const muted = this.muteUpdates
    return this.enqueue(() => this.processUpdate(params, muted))
  }

  private async processUpdate(params: acp.SessionNotification, muted: boolean): Promise<void> {
    const update = params.update
    if (muted) {
      switch (update.sessionUpdate) {
        case 'available_commands_update':
          this.availableCommands = update.availableCommands
          await this.syncCommands()
          break
        case 'config_option_update':
          this.configOptions = update.configOptions
          await this.syncCommands()
          break
        case 'current_mode_update':
          if (this.modes) this.modes.currentModeId = update.currentModeId
          break
        case 'session_info_update':
          if (update.title != null) this.title = update.title
          break
      }
      return
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        logger.debug({ chatId: this.chatId, type: update.sessionUpdate, contentType: update.content.type, text: update.content.type === 'text' ? update.content.text : undefined }, 'Content chunk')
        await this.handleContent(update.content, 'message')
        break
      }
      case 'agent_thought_chunk': {
        logger.debug({ chatId: this.chatId, type: update.sessionUpdate, contentType: update.content.type, text: update.content.type === 'text' ? update.content.text : undefined }, 'Content chunk')
        await this.handleContent(update.content, 'thought')
        break
      }
      case 'tool_call': {
        await this.flushTextBuffer()
        const toolTitle = update.title ?? 'Tool'
        logger.debug({ chatId: this.chatId, toolCallId: update.toolCallId, title: toolTitle }, 'Tool call started')
        const interaction = await this.adapter.sendInteractiveMessage(this.chatId, {
          markdown: `**Tool call:** ${toolTitle}`
        }, 'tool')
        logger.debug({ chatId: this.chatId, toolCallId: update.toolCallId, messageId: interaction.id }, 'Tool call message sent')
        this.toolCalls.set(update.toolCallId, { messageId: interaction.id, title: toolTitle })
        break
      }
      case 'tool_call_update': {
        await this.flushTextBuffer()
        const tc = this.toolCalls.get(update.toolCallId)
        if (update.title && tc) tc.title = update.title
        const toolTitle = tc?.title ?? 'Tool'
        const statusLabel = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'running'
        const text = `**Tool ${statusLabel}:** ${toolTitle}`
        logger.debug({ chatId: this.chatId, toolCallId: update.toolCallId, status: update.status, messageId: tc?.messageId }, 'Tool call update')
        if (tc) {
          const terminal = update.status === 'completed' || update.status === 'failed'
          await this.adapter.editInteractiveMessage(this.chatId, tc.messageId, { markdown: text, actions: null })
          if (terminal) {
            this.toolCalls.delete(update.toolCallId)
          }
        } else {
          logger.warn({ chatId: this.chatId, toolCallId: update.toolCallId }, 'No message found for tool call update, sending as new message')
          await this.adapter.sendTextMessage(this.chatId, text)
        }
        break
      }
      case 'available_commands_update':
        this.availableCommands = update.availableCommands
        await this.syncCommands()
        break
      case 'config_option_update':
        this.configOptions = update.configOptions
        await this.syncCommands()
        break
      case 'current_mode_update':
        if (this.modes) this.modes.currentModeId = update.currentModeId
        break
      case 'session_info_update':
        if (update.title != null) this.title = update.title
        break
    }
  }

  async syncCommands() {
    const agentCmds = this.availableCommands.map((c) => ({ name: c.name, description: c.description }))
    await this.adapter.setCommands([...BUILT_IN_COMMANDS, ...agentCmds])
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushTextBuffer().catch(() => {})
    }, TEXT_FLUSH_DELAY)
  }

  async flushTextBuffer(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.textBuffer) return
    const text = this.textBuffer
    const kind = this.textBufferKind
    this.textBuffer = ''
    this.textBufferKind = 'message'
    await this.adapter.sendTextMessage(this.chatId, text, kind)
  }

  async handleContent(block: ContentBlock, kind: 'thought' | 'message') {
    const normalized = normalizeContent(block)
    if (normalized.kind === 'text') {
      if (this.textBuffer && this.textBufferKind !== kind) {
        await this.flushTextBuffer()
      }
      this.textBufferKind = kind
      this.textBuffer += normalized.text
      if (this.textBuffer.length >= TEXT_FLUSH_MAX_LEN) {
        await this.flushTextBuffer()
      } else {
        this.scheduleFlush()
      }
      return
    }
    await this.flushTextBuffer()
    if (normalized.kind === 'unknown') return this.adapter.sendTextMessage(this.chatId, `[Content: ${normalized.type}]`)
    return this.adapter.sendMedia(this.chatId, normalized)
  }

  private async presentToolApproval(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const title = params.toolCall.title ?? 'Tool'
    const toolCallId = params.toolCall.toolCallId
    const nonce = Date.now().toString(36)
    const actions = params.options.map((opt) => ({
      id: `acp:tool:${nonce}:select:${opt.optionId}`,
      label: opt.name
    }))
    let resolveApproval!: (value: RequestPermissionResponse) => void
    const approvalPromise = new Promise<RequestPermissionResponse>((resolve) => {
      resolveApproval = resolve
    })
    this.pendingPermissions.set(toolCallId, resolveApproval)
    await this.enqueue(async () => {
      const callback = async (actionId: string) => {
        const optionId = actionId.split(':')[4] ?? ''
        resolveApproval({ outcome: { outcome: 'selected', optionId } })
      }
      const inlineActions = { items: actions, callback }
      const tc = this.toolCalls.get(toolCallId)
      if (tc) {
        await this.adapter
          .editInteractiveMessage(this.chatId, tc.messageId, {
            markdown: `**Permission requested:** ${title}`,
            actions: inlineActions
          })
          .catch(() => resolveApproval(selectRejectOutcome(params)))
      } else {
        await this.adapter
          .sendInteractiveMessage(this.chatId, {
            markdown: `**Permission requested:** ${title}`,
            actions: inlineActions
          }, 'permission')
          .then((interaction) => this.toolCalls.set(toolCallId, { messageId: interaction.id, title }))
          .catch(() => resolveApproval(selectRejectOutcome(params)))
      }
    })
    if (!this.permissions.timeoutMs) return approvalPromise
    return Promise.race([
      approvalPromise,
      new Promise<RequestPermissionResponse>((resolve) => {
        setTimeout(() => resolve(selectRejectOutcome(params)), this.permissions.timeoutMs ?? 0)
      })
    ])
  }
}

export class RouterCore {
  private clients = new Map<string, RouterClient>()
  private clientProcs = new Map<string, AgentProcess>()
  private chatAgents = new Map<string, string>()

  constructor(
    private adapter: IMAdapter,
    private launcher: AgentLauncher,
    private registry: AgentRegistrySnapshot,
    private cache: SessionCacheStore,
    private defaults: { agentId: string; cwd: string },
    private permissions: { timeoutMs: number | null }
  ) {}

  private messageQueues = new Map<string, Promise<void>>()
  private pendingMessages = new Map<string, { messageId: string; aborted: boolean }[]>()

  private enqueueMessage(chatId: string, messageId: string, fn: () => Promise<void>): Promise<void> {
    const entry = { messageId, aborted: false }
    const pending = this.pendingMessages.get(chatId) ?? []
    pending.push(entry)
    this.pendingMessages.set(chatId, pending)

    this.adapter.setReaction(chatId, messageId, 'queued').catch((err) => {
      logger.warn({ chatId, messageId, err }, 'Failed to set queued reaction')
    })

    const prev = this.messageQueues.get(chatId) ?? Promise.resolve()
    const wrapped = async () => {
      const entries = this.pendingMessages.get(chatId)
      if (entries) {
        const idx = entries.indexOf(entry)
        if (idx !== -1) entries.splice(idx, 1)
      }
      if (entry.aborted) {
        return
      }
      await this.adapter.setReaction(chatId, messageId, undefined).catch((err) => {
        logger.warn({ chatId, messageId, err }, 'Failed to clear reaction')
      })
      await fn()
    }
    const next = prev.then(wrapped, wrapped)
    this.messageQueues.set(chatId, next.then(() => {}, () => {}))
    return next
  }

  private drainMessageQueue(chatId: string) {
    const pending = this.pendingMessages.get(chatId)
    if (!pending) return
    for (const entry of pending) {
      entry.aborted = true
      this.adapter.setReaction(chatId, entry.messageId, 'aborted').catch((err) => {
        logger.warn({ chatId, messageId: entry.messageId, err }, 'Failed to set aborted reaction on drain')
      })
    }
    logger.debug({ chatId, count: pending.length }, 'Drained message queue')
  }

  async init() {
    await this.adapter.init()
    logger.info({ platform: this.adapter.platform }, 'IM adapter initialized')
    await this.adapter.setCommands(BUILT_IN_COMMANDS)
    this.adapter.on('text', (chatId, messageId, text) => {
      this.enqueueMessage(chatId, messageId, () => this.onMessage(chatId, text))
    })
    this.adapter.on('command', (chatId, messageId, command, args) => {
      if (command === 'cancel' || command === 'clear') {
        this.drainMessageQueue(chatId)
        this.onCommand(chatId, command, args)
        return
      }
      if (['help', 'agent', 'sessions', 'mode', 'model', 'config'].includes(command)) {
        this.onCommand(chatId, command, args)
        return
      }
      if (command === 'start') {
        this.adapter.setReaction(chatId, messageId, 'ignored').catch((err) => {
          logger.warn({ chatId, messageId, err }, 'Failed to set ignored reaction')
        })
        return
      }
      this.enqueueMessage(chatId, messageId, () => this.onCommand(chatId, command, args))
    })
  }

  getAgentEntry(agentId: string): AgentRegistryEntry {
    const entry = this.registry.agents.find((agent) => agent.id === agentId)
    if (!entry) throw new Error(`Unknown agent: ${agentId}`)
    return entry
  }

  async ensureClient(chatId: string, agentId: string, launch: AgentLaunchRequest): Promise<RouterClient> {
    const existing = this.clients.get(chatId)
    if (existing) return existing
    const entry = this.getAgentEntry(agentId)
    logger.info({ chatId, agentId }, 'Launching agent')
    const proc = await this.launcher.launch(launch, entry)
    const rawStream = acp.ndJsonStream(proc.stdin, proc.stdout)
    let msgSeq = 0
    const debugReadable = new ReadableStream<acp.AnyMessage>({
      async start(controller) {
        const reader = rawStream.readable.getReader()
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            const seq = msgSeq++
            const msg = value as { method?: string; id?: unknown; result?: unknown }
            logger.trace({ chatId, seq, method: msg.method, id: msg.id, hasResult: 'result' in msg }, 'Raw JSONRPC message')
            controller.enqueue(value)
          }
        } finally {
          reader.releaseLock()
          controller.close()
        }
      }
    })
    const stream = { readable: debugReadable, writable: rawStream.writable }
    const client = new RouterClient(this.adapter, chatId, this.permissions)
    client.conn = new acp.ClientSideConnection(() => client, stream)
    const init = await client.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    })
    client.agentInfo = init.agentInfo ?? null
    logger.info({ chatId, agentId, sessionId: client.sessionId }, 'Client initialized')
    this.clients.set(chatId, client)
    this.clientProcs.set(chatId, proc)
    proc.stderr
      ?.getReader()
      .read()
      .catch(() => {})
    return client
  }

  async startSession(chatId: string, agentId: string, launch: AgentLaunchRequest, cwd: string) {
    this.chatAgents.set(chatId, agentId)
    await this.cache.set(`agent:${chatId}`, agentId)
    const client = await this.ensureClient(chatId, agentId, launch)
    if (client.sessionId) return client

    const statusMsg = await this.adapter.sendInteractiveMessage(chatId, {
      markdown: '**Starting session...**'
    }, 'status')
    client.statusMessageId = statusMsg.id

    const cached = await this.cache.get(cacheKey(chatId, agentId, cwd))
    if (cached) {
      // Try resume (lightweight, no history replay)
      try {
        await this.adapter.editInteractiveMessage(chatId, statusMsg.id, {
          markdown: '**Resuming session...**'
        })
        const res = await client.conn.unstable_resumeSession({ sessionId: cached, cwd })
        client.sessionId = cached
        applySessionState(client, res)
        logger.info({ chatId, sessionId: cached }, 'Resumed session')
        await this.adapter.editInteractiveMessage(chatId, statusMsg.id, {
          markdown: `**Session resumed** (${cached})${formatSessionInfo(client)}`
        })
        return client
      } catch (err) {
        logger.warn({ chatId, sessionId: cached, err }, 'Failed to resume session; trying load')
      }
      // Try load (replays history, mute updates to avoid flooding)
      try {
        await this.adapter.editInteractiveMessage(chatId, statusMsg.id, {
          markdown: '**Loading session...**'
        })
        client.muteUpdates = true
        const res = await client.conn.loadSession({ sessionId: cached, cwd, mcpServers: [] })
        await new Promise((r) => setTimeout(r, 0))
        await client.drainQueue()
        client.muteUpdates = false
        client.sessionId = cached
        applySessionState(client, res)
        logger.info({ chatId, sessionId: cached }, 'Loaded session')
        await this.adapter.editInteractiveMessage(chatId, statusMsg.id, {
          markdown: `**Session loaded** (${cached})${formatSessionInfo(client)}`
        })
        return client
      } catch (err) {
        await new Promise((r) => setTimeout(r, 0))
        await client.drainQueue()
        client.muteUpdates = false
        logger.warn({ chatId, sessionId: cached, err }, 'Failed to load session; creating new')
      }
    }
    await this.adapter.editInteractiveMessage(chatId, statusMsg.id, {
      markdown: '**Creating new session...**'
    })
    const res = await client.conn.newSession({ cwd, mcpServers: [] })
    client.sessionId = res.sessionId
    applySessionState(client, res)
    await this.cache.set(cacheKey(chatId, agentId, cwd), res.sessionId)
    logger.info({ chatId, sessionId: res.sessionId }, 'Created new session')
    await this.adapter.editInteractiveMessage(chatId, statusMsg.id, {
      markdown: `**New session created** (${res.sessionId})${formatSessionInfo(client)}`
    })
    return client
  }

  private async resolveAgentId(chatId: string): Promise<string> {
    const mem = this.chatAgents.get(chatId)
    if (mem) return mem
    const cached = await this.cache.get(`agent:${chatId}`)
    if (cached && this.registry.agents.some((a) => a.id === cached)) {
      return cached
    }
    return this.defaults.agentId
  }

  private async ensureSession(chatId: string): Promise<RouterClient> {
    const existing = this.clients.get(chatId)
    if (existing?.sessionId) return existing
    const agentId = await this.resolveAgentId(chatId)
    return this.startSession(chatId, agentId, { agentId }, this.defaults.cwd)
  }

  async listAgents() {
    return this.registry.agents
  }

  async onMessage(chatId: string, text: string) {
    logger.debug({ chatId }, 'Received user message')
    await this.adapter.setActive(chatId, true)
    try {
      const client = await this.ensureSession(chatId)
      await client.conn.prompt({ sessionId: client.sessionId, prompt: [{ type: 'text', text }] })
      await client.flushTextBuffer()
    } catch (err) {
      logger.error({ chatId, err }, 'Error handling message')
      await this.adapter.sendTextMessage(chatId, `Error: ${err instanceof Error ? err.message : 'Unknown error'}`).catch(() => {})
    } finally {
      await this.adapter.setActive(chatId, false)
    }
  }

  async onCommand(chatId: string, command: string, args: string[]) {
    await this.adapter.setActive(chatId, true)
    try {
      if (command === 'clear') {
        const agentId = await this.resolveAgentId(chatId)
        const client = await this.ensureClient(chatId, agentId, { agentId })
        if (client.sessionId) {
          await client.cancelPendingOperations()
          await client.conn.cancel({ sessionId: client.sessionId }).catch(() => {})
        }
        const res = await client.conn.newSession({ cwd: this.defaults.cwd, mcpServers: [] })
        client.sessionId = res.sessionId
        client.reset()
        applySessionState(client, res)
        await this.cache.set(cacheKey(chatId, agentId, this.defaults.cwd), res.sessionId)
        await this.adapter.sendTextMessage(chatId, `New session created (${res.sessionId})${formatSessionInfo(client)}`)
        return
      }
      if (command === 'agent') {
        await this.handleAgent(chatId, args[0])
        return
      }
      if (command === 'sessions') {
        await this.handleSessions(chatId)
        return
      }
      const client = await this.ensureSession(chatId)
      if (command === 'start') {
        await this.adapter.sendTextMessage(chatId, `Session ready (${client.sessionId})`)
        return
      }
      if (command === 'cancel') {
        if (client.sessionId) {
          await client.cancelPendingOperations()
          await client.conn.cancel({ sessionId: client.sessionId })
        }
        await this.adapter.sendTextMessage(chatId, 'Cancellation requested.')
        return
      }
      if (command === 'help') {
        const lines = BUILT_IN_COMMANDS.map((c) => `/${c.name} - ${c.description}`)
        if (client.availableCommands.length) {
          lines.push('', 'Agent commands:')
          for (const cmd of client.availableCommands) {
            lines.push(`/${cmd.name} - ${cmd.description}`)
          }
        }
        await this.adapter.sendTextMessage(chatId, lines.join('\n'))
        return
      }
      const handlers: Record<string, () => Promise<void>> = {
        mode: () => this.handleMode(chatId, client, args[0]),
        model: () => this.handleModel(chatId, client, args[0]),
        config: () => this.handleConfig(chatId, client, args)
      }
      const handler = handlers[command]
      if (handler) {
        await handler()
        return
      }
      const agentCommand = client.availableCommands.find((c) => c.name === command)
      if (agentCommand && client.sessionId) {
        await this.executeAgentCommand(client, command, args)
        await client.flushTextBuffer()
        return
      }
      // Unknown command: forward as plain text message
      const fullText = `/${command}${args.length ? ' ' + args.join(' ') : ''}`
      await client.conn.prompt({ sessionId: client.sessionId, prompt: [{ type: 'text', text: fullText }] })
      await client.flushTextBuffer()
    } catch (err) {
      logger.error({ chatId, command, err }, 'Error handling command')
      await this.adapter.sendTextMessage(chatId, `Error: ${err instanceof Error ? err.message : 'Unknown error'}`).catch(() => {})
    } finally {
      await this.adapter.setActive(chatId, false)
    }
  }

  private async handleAgent(chatId: string, target?: string) {
    const currentAgentId = this.chatAgents.get(chatId) ?? this.defaults.agentId
    if (!target) {
      await this.presentOptionPicker(chatId, {
        title: 'Agent',
        current: currentAgentId,
        options: this.registry.agents.map((a) => ({ id: a.id, label: a.name })),
        apply: (selected) => this.switchAgent(chatId, selected)
      })
      return
    }
    const result = await this.switchAgent(chatId, target)
    await this.adapter.sendTextMessage(chatId, result)
  }

  private async switchAgent(chatId: string, agentId: string): Promise<string> {
    this.getAgentEntry(agentId)

    const currentAgentId = this.chatAgents.get(chatId) ?? this.defaults.agentId
    if (agentId === currentAgentId) return `Agent: ${agentId} (no change)`

    const existing = this.clients.get(chatId)
    if (existing) {
      if (existing.sessionId) {
        await existing.cancelPendingOperations()
        await existing.conn.cancel({ sessionId: existing.sessionId }).catch(() => {})
      }
      existing.reset()
      this.clients.delete(chatId)
    }

    const proc = this.clientProcs.get(chatId)
    if (proc) {
      proc.kill()
      this.clientProcs.delete(chatId)
    }

    this.drainMessageQueue(chatId)
    this.chatAgents.set(chatId, agentId)
    await this.cache.set(`agent:${chatId}`, agentId)

    await this.startSession(chatId, agentId, { agentId }, this.defaults.cwd)
    return `Agent → ${agentId}`
  }

  private async handleSessions(chatId: string) {
    await this.adapter.sendTextMessage(chatId, 'Sessions list is not available in this version.')
  }

  private async handleMode(chatId: string, client: RouterClient, target?: string) {
    if (!client.sessionId || !client.modes) {
      await this.adapter.sendTextMessage(chatId, 'Modes are not available for this session.')
      return
    }
    if (!target) {
      await this.presentOptionPicker(chatId, {
        title: 'Session mode',
        current: client.modes.currentModeId,
        options: client.modes.availableModes.map((mode) => ({ id: mode.id, label: mode.name ?? mode.id })),
        apply: async (selected) => {
          await client.conn.setSessionMode({ sessionId: client.sessionId, modeId: selected })
          client.modes!.currentModeId = selected
          return `Mode → ${selected}`
        }
      })
      return
    }
    await client.conn.setSessionMode({ sessionId: client.sessionId, modeId: target })
    client.modes.currentModeId = target
    await this.adapter.sendTextMessage(chatId, `Mode → ${target}`)
  }

  private async handleModel(chatId: string, client: RouterClient, target?: string) {
    if (!client.sessionId || !client.models) {
      await this.adapter.sendTextMessage(chatId, 'Models are not available for this session.')
      return
    }
    if (!target) {
      await this.presentOptionPicker(chatId, {
        title: 'Session model',
        current: client.models.currentModelId,
        options: client.models.availableModels.map((model) => ({ id: model.modelId, label: model.name ?? model.modelId })),
        apply: async (selected) => {
          await client.conn.unstable_setSessionModel({ sessionId: client.sessionId, modelId: selected })
          client.models!.currentModelId = selected
          return `Model → ${selected}`
        }
      })
      return
    }
    await client.conn.unstable_setSessionModel({ sessionId: client.sessionId, modelId: target })
    client.models.currentModelId = target
    await this.adapter.sendTextMessage(chatId, `Model → ${target}`)
  }

  private async handleConfig(chatId: string, client: RouterClient, args: string[]) {
    if (!client.sessionId || !client.configOptions.length) {
      await this.adapter.sendTextMessage(chatId, 'No config options available for this session.')
      return
    }
    const [optId, value] = args
    if (!optId) {
      const summary = client.configOptions.map((opt) => `${opt.id}=${opt.currentValue}`).join('\n')
      await this.adapter.sendTextMessage(chatId, `Config options:\n${summary}`)
      return
    }
    if (!value) {
      const opt = client.configOptions.find((o) => o.id === optId)
      if (!opt) return
      await this.adapter.sendTextMessage(chatId, `${opt.name}: ${opt.currentValue}`)
      return
    }
    const res = await client.conn.setSessionConfigOption({ sessionId: client.sessionId, configId: optId, value })
    client.configOptions = res.configOptions
    await this.adapter.sendTextMessage(chatId, `Config ${optId} → ${value}`)
  }

  private async executeAgentCommand(client: RouterClient, command: string, args: string[]) {
    await client.conn.extMethod('command', { sessionId: client.sessionId, command: { name: command, args } })
  }

  private async presentOptionPicker(
    chatId: string,
    params: {
      title: string
      current: string
      options: { id: string; label: string }[]
      apply: (selected: string) => Promise<string>
    }
  ) {
    const nonce = Date.now().toString(36)
    const optionMap = new Map<string, string>()
    const actions = params.options.map((option, i) => {
      const key = `p:${nonce}:${i}`
      optionMap.set(key, option.id)
      return { id: key, label: option.label }
    })
    const cancelKey = `p:${nonce}:x`
    actions.push({ id: cancelKey, label: 'Cancel' })
    let interactionId = ''
    const message: InlineMessage = {
      markdown: `**${params.title}**\nCurrent: ${params.current}`,
      actions: {
        items: actions,
        callback: async (actionId: string) => {
          if (!interactionId) return
          if (actionId === cancelKey) {
            await this.adapter.editInteractiveMessage(chatId, interactionId, { markdown: `**${params.title}**\nCancelled`, actions: null })
            return
          }
          const selected = optionMap.get(actionId)
          if (!selected) return
          await this.adapter.setActive(chatId, true)
          try {
            const result = await params.apply(selected)
            await this.adapter.editInteractiveMessage(chatId, interactionId, { markdown: result, actions: null })
          } catch (err) {
            logger.error({ chatId, err }, 'Error applying option')
            await this.adapter.editInteractiveMessage(chatId, interactionId, {
              markdown: `**${params.title}**\nError: ${err instanceof Error ? err.message : 'Unknown error'}`,
              actions: null
            })
          }
          await this.adapter.setActive(chatId, false)
        }
      }
    }
    const interaction = await this.adapter.sendInteractiveMessage(chatId, message, 'picker')
    interactionId = interaction.id
  }

  // Sessions list UX deferred to next major version.
}

function applySessionState(
  client: RouterClient,
  res: acp.NewSessionResponse | acp.ResumeSessionResponse | acp.LoadSessionResponse
) {
  if (res.configOptions) client.configOptions = res.configOptions
  if (res.modes) client.modes = res.modes
  if (res.models) client.models = res.models
}

function formatSessionInfo(client: RouterClient): string {
  const lines: string[] = []
  if (client.modes) {
    const current = client.modes.availableModes.find((m) => m.id === client.modes!.currentModeId)
    lines.push(`Mode: ${current?.name ?? client.modes.currentModeId}`)
  }
  if (client.models) {
    const current = client.models.availableModels.find((m) => m.modelId === client.models!.currentModelId)
    lines.push(`Model: ${current?.name ?? client.models.currentModelId}`)
  }
  if (client.configOptions.length) {
    for (const opt of client.configOptions) {
      lines.push(`${opt.name}: ${opt.currentValue}`)
    }
  }
  return lines.length ? '\n' + lines.join('\n') : ''
}

function cacheKey(chatId: string, agentId: string, cwd: string) {
  return `${chatId}:${agentId}:${cwd}`
}

function selectRejectOutcome(params: RequestPermissionRequest): RequestPermissionResponse {
  // NOTE: ACP does not yet support timeout denial messaging.
  const option = params.options.find((opt) => opt.kind === 'reject_once') ?? params.options[0]
  if (!option) {
    return { outcome: { outcome: 'cancelled' } }
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}
