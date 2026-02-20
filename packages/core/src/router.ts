import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentLaunchRequest,
  AgentLauncher,
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

export class RouterClient implements acp.Client {
  conn!: acp.ClientSideConnection
  sessionId = ''
  agentInfo: acp.Implementation | null = null
  title = ''
  configOptions: SessionConfigOption[] = []
  availableCommands: AvailableCommand[] = []
  modes: SessionModeState | null = null
  models: SessionModelState | null = null

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
    return this.presentToolApproval(params)
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        await this.handleContent(update.content)
        break
      }
      case 'tool_call':
        if (update.title) {
          await this.adapter.sendMarkdownText(this.chatId, `**Tool call:** ${update.title}`)
        }
        break
      case 'tool_call_update': {
        if (update.title) {
          const statusLabel = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'updated'
          await this.adapter.sendMarkdownText(this.chatId, `**Tool ${statusLabel}:** ${update.title}`)
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
    const commands = this.availableCommands.map((c) => ({ name: c.name, description: c.description }))
    await this.adapter.setCommands(commands)
  }

  async handleContent(block: ContentBlock) {
    const normalized = normalizeContent(block)
    if (normalized.kind === 'text') return this.adapter.sendMarkdownText(this.chatId, normalized.text)
    if (normalized.kind === 'unknown') return this.adapter.sendMarkdownText(this.chatId, `[Content: ${normalized.type}]`)
    return this.adapter.sendMedia(this.chatId, normalized)
  }

  private async presentToolApproval(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const title = params.toolCall.title ?? 'Tool'
    const nonce = Date.now().toString(36)
    const actions = params.options.map((opt) => ({
      id: `acp:tool:${nonce}:select:${opt.optionId}`,
      label: opt.name
    }))
    let resolveApproval: ((value: RequestPermissionResponse) => void) | null = null
    const approvalPromise = new Promise<RequestPermissionResponse>((resolve) => {
      resolveApproval = resolve
      const callback = async (actionId: string) => {
        const optionId = actionId.split(':')[4] ?? ''
        resolve({ outcome: { outcome: 'selected', optionId } })
      }
      this.adapter
        .sendInteractiveMessage(this.chatId, {
          markdown: `**Permission requested:** ${title}`,
          actions: { items: actions, callback }
        })
        .catch(() => resolve(selectRejectOutcome(params)))
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

  constructor(
    private adapter: IMAdapter,
    private launcher: AgentLauncher,
    private registry: AgentRegistrySnapshot,
    private cache: SessionCacheStore,
    private defaults: { agentId: string; cwd: string },
    private permissions: { timeoutMs: number | null }
  ) {}

  async init() {
    await this.adapter.init()
    logger.info({ platform: this.adapter.platform }, 'IM adapter initialized')
    this.adapter.on('text', (chatId, text) => this.onMessage(chatId, text))
    this.adapter.on('command', (chatId, command, args) => this.onCommand(chatId, command, args))
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
    const stream = acp.ndJsonStream(proc.stdin, proc.stdout)
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
    proc.stderr
      ?.getReader()
      .read()
      .catch(() => {})
    return client
  }

  async startSession(chatId: string, agentId: string, launch: AgentLaunchRequest, cwd: string) {
    const client = await this.ensureClient(chatId, agentId, launch)
    if (client.sessionId) return client
    const cached = await this.cache.get(cacheKey(chatId, cwd))
    if (cached) {
      try {
        const res = await client.conn.unstable_resumeSession({ sessionId: cached, cwd })
        client.sessionId = cached
        applySessionState(client, res)
        logger.info({ chatId, sessionId: cached }, 'Resumed session')
        return client
      } catch {
        logger.warn({ chatId, sessionId: cached }, 'Failed to resume session; starting new')
        // fallthrough to new
      }
    }
    const res = await client.conn.newSession({ cwd, mcpServers: [] })
    client.sessionId = res.sessionId
    applySessionState(client, res)
    await this.cache.set(cacheKey(chatId, cwd), res.sessionId)
    logger.info({ chatId, sessionId: res.sessionId }, 'Created new session')
    return client
  }

  async listAgents() {
    return this.registry.agents
  }

  async onMessage(chatId: string, text: string) {
    logger.debug({ chatId }, 'Received user message')
    await this.adapter.setActive(chatId, true)
    let client = this.clients.get(chatId)
    if (!client) {
      client = await this.startSession(chatId, this.defaults.agentId, { agentId: this.defaults.agentId }, this.defaults.cwd)
    }
    await client.conn.prompt({ sessionId: client.sessionId, prompt: [{ type: 'text', text }] })
    await this.adapter.setActive(chatId, false)
  }

  async onCommand(chatId: string, command: string, args: string[]) {
    let client = this.clients.get(chatId)
    if (!client) {
      client = await this.startSession(chatId, this.defaults.agentId, { agentId: this.defaults.agentId }, this.defaults.cwd)
    }
    if (command === 'start') {
      await this.adapter.sendMarkdownText(chatId, `Session ready (${client.sessionId})`)
      return
    }
    const handlers: Record<string, () => Promise<void>> = {
      agents: () => this.handleAgents(chatId),
      sessions: () => this.handleSessions(chatId),
      mode: () => this.handleMode(chatId, client, args[0]),
      model: () => this.handleModel(chatId, client, args[0]),
      config: () => this.handleConfig(chatId, client, args)
    }
    const handler = handlers[command]
    if (handler) {
      await handler()
      return
    }
    if (command === 'cancel' && client.sessionId) {
      await client.conn.cancel({ sessionId: client.sessionId })
      await this.adapter.sendMarkdownText(chatId, 'Cancellation requested.')
      return
    }
    const agentCommand = client.availableCommands.find((c) => c.name === command)
    if (agentCommand && client.sessionId) {
      await this.executeAgentCommand(client, command, args)
      return
    }
  }

  private async handleAgents(chatId: string) {
    const lines = this.registry.agents.map((agent) => `${agent.id}: ${agent.name}`)
    await this.adapter.sendMarkdownText(chatId, lines.join('\n') || 'No agents available')
  }

  private async handleSessions(chatId: string) {
    await this.adapter.sendMarkdownText(chatId, 'Sessions list is not available in this version.')
  }

  private async handleMode(chatId: string, client: RouterClient, target?: string) {
    if (!client.sessionId || !client.modes) return
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
    await this.adapter.sendMarkdownText(chatId, `Mode → ${target}`)
  }

  private async handleModel(chatId: string, client: RouterClient, target?: string) {
    if (!client.sessionId || !client.models) return
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
    await this.adapter.sendMarkdownText(chatId, `Model → ${target}`)
  }

  private async handleConfig(chatId: string, client: RouterClient, args: string[]) {
    if (!client.sessionId || !client.configOptions.length) return
    const [optId, value] = args
    if (!optId) {
      const summary = client.configOptions.map((opt) => `${opt.id}=${opt.currentValue}`).join('\n')
      await this.adapter.sendMarkdownText(chatId, `Config options:\n${summary}`)
      return
    }
    if (!value) {
      const opt = client.configOptions.find((o) => o.id === optId)
      if (!opt) return
      await this.adapter.sendMarkdownText(chatId, `${opt.name}: ${opt.currentValue}`)
      return
    }
    const res = await client.conn.setSessionConfigOption({ sessionId: client.sessionId, configId: optId, value })
    client.configOptions = res.configOptions
    await this.adapter.sendMarkdownText(chatId, `Config ${optId} → ${value}`)
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
    const flow = params.title.replace(/\s+/g, '-').toLowerCase()
    const actions = params.options.map((option) => ({
      id: `acp:${flow}:${nonce}:select:${option.id}`,
      label: option.label
    }))
    actions.push({ id: `acp:${flow}:${nonce}:cancel`, label: 'Cancel' })
    let interactionId = ''
    const message: InlineMessage = {
      markdown: `**${params.title}**\nCurrent: ${params.current}`,
      actions: {
        items: actions,
        callback: async (actionId: string) => {
          if (!interactionId) return
          if (actionId === `acp:${flow}:${nonce}:cancel`) {
            await this.adapter.updateInteractiveMessage(chatId, interactionId, { actions: null })
            return
          }
          const selected = actionId.split(':')[4] ?? ''
          const result = await params.apply(selected)
          await this.adapter.updateInteractiveMessage(chatId, interactionId, { markdown: result, actions: null })
        }
      }
    }
    const interaction = await this.adapter.sendInteractiveMessage(chatId, message)
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

function cacheKey(chatId: string, cwd: string) {
  return `${chatId}:${cwd}`
}

function selectRejectOutcome(params: RequestPermissionRequest): RequestPermissionResponse {
  // NOTE: ACP does not yet support timeout denial messaging.
  const option = params.options.find((opt) => opt.kind === 'reject_once') ?? params.options[0]
  if (!option) {
    return { outcome: { outcome: 'cancelled' } }
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}
