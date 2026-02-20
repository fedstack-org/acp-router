import type * as acp from '@agentclientprotocol/sdk'

export type RegistryAgentId = string

export interface AgentRegistryEntry {
  id: RegistryAgentId
  name: string
  description?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface AgentRegistrySnapshot {
  source: string
  fetchedAt: string
  agents: AgentRegistryEntry[]
}

export interface AgentLaunchRequest {
  agentId: RegistryAgentId
  cwd?: string
  args?: string[]
  env?: Record<string, string>
}

export interface AgentProcess {
  stdin: WritableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  pid?: number
  kill: () => void
  wait: () => Promise<number | null>
}

export interface AgentLauncher {
  launch(request: AgentLaunchRequest, entry: AgentRegistryEntry): Promise<AgentProcess>
}

export interface SessionCacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export type ContentBlock = acp.ContentBlock
export type SessionConfigOption = acp.SessionConfigOption
export type SessionInfo = acp.SessionInfo
export type SessionModeState = acp.SessionModeState
export type SessionModelState = acp.SessionModelState
export type AvailableCommand = acp.AvailableCommand
export type RequestPermissionRequest = acp.RequestPermissionRequest
export type RequestPermissionResponse = acp.RequestPermissionResponse
