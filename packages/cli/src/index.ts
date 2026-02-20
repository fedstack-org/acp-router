import { NodeAgentLauncher, RouterCore, logger } from '@acp-router/core'
import { TelegramAdapter } from '@acp-router/adapter-telegram'
import { FileSessionCache } from './cache.js'
import { loadConfig } from './config.js'

async function main() {
  const config = await loadConfig()
  if (!config.telegram?.token) throw new Error('Config: telegramToken is required')
  const agents = Object.entries(config.agents).map(([id, agent]) => ({
    id,
    name: agent.name ?? id,
    description: agent.description,
    command: agent.command,
    args: agent.args,
    env: agent.env,
    cwd: agent.cwd
  }))
  if (!agents.length) throw new Error('Config: agents is required')
  const defaultAgentId = config.defaultAgentId && config.agents[config.defaultAgentId]
    ? config.defaultAgentId
    : agents[0]?.id
  if (!defaultAgentId) throw new Error('Config: no agents available')
  const adapter = new TelegramAdapter(config.telegram.token, config.allowList)
  const launcher = new NodeAgentLauncher()
  const cache = new FileSessionCache()
  logger.info({ defaultAgentId }, 'Starting ACP router')
  const router = new RouterCore(
    adapter,
    launcher,
    { source: 'config', fetchedAt: new Date().toISOString(), agents },
    cache,
    {
      agentId: defaultAgentId,
      cwd: config.session.cwd ?? process.cwd()
    },
    { timeoutMs: config.telegram?.permissionTimeoutMs ?? null }
  )
  await router.init()
}

main().catch((err) => {
  logger.error({ err }, 'ACP router failed')
  process.exit(1)
})
