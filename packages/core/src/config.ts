export interface RouterConfig {
  allowList: number[]
  defaultAgentId?: string
  agents: Record<
    string,
    {
      name?: string
      description?: string
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
    }
  >
  session: {
    cwd?: string
  }
  telegram?: {
    token?: string
    permissionTimeoutMs?: number
  }
}

export function normalizeConfig(input: Partial<RouterConfig>): RouterConfig {
  if (!input.allowList?.length) throw new Error('Config: allowList must be a non-empty array')
  if (!input.agents || !Object.keys(input.agents).length) throw new Error('Config: agents is required')
  return {
    allowList: input.allowList,
    defaultAgentId: input.defaultAgentId,
    agents: input.agents,
    session: {
      cwd: input.session?.cwd ?? process.cwd()
    },
    telegram: {
      token: input.telegram?.token,
      permissionTimeoutMs: input.telegram?.permissionTimeoutMs
    }
  }
}
