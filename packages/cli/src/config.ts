import { readFile } from 'node:fs/promises'
import { normalizeConfig, paths, type RouterConfig } from '@acp-router/core'

export async function loadConfig(): Promise<RouterConfig> {
  const raw = await readFile(paths.settings, 'utf-8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return normalizeConfig({
    allowList: Array.isArray(parsed.allowList) ? (parsed.allowList as number[]) : [],
    defaultAgentId: typeof parsed.defaultAgentId === 'string' ? parsed.defaultAgentId : undefined,
    agents: typeof parsed.agents === 'object' && parsed.agents ? (parsed.agents as RouterConfig['agents']) : {},
    session: { cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined },
    telegram: {
      token: typeof parsed.telegramToken === 'string' ? parsed.telegramToken : undefined,
      permissionTimeoutMs:
        typeof parsed.telegramPermissionTimeoutMs === 'number' ? parsed.telegramPermissionTimeoutMs : undefined
    }
  })
}
