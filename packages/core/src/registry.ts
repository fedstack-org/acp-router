import type { AgentRegistryEntry, AgentRegistrySnapshot } from './types.js'

export async function fetchRegistry(url: string): Promise<AgentRegistrySnapshot> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`)
  const data = (await res.json()) as unknown
  const agents = normalizeRegistryAgents(data)
  return {
    source: url,
    fetchedAt: new Date().toISOString(),
    agents
  }
}

export function normalizeRegistryAgents(data: unknown): AgentRegistryEntry[] {
  if (!data || typeof data !== 'object') return []
  const entries = (data as { agents?: unknown }).agents
  if (!Array.isArray(entries)) return []
  return entries.flatMap((raw) => toRegistryEntry(raw)).filter(Boolean) as AgentRegistryEntry[]
}

function toRegistryEntry(raw: unknown): AgentRegistryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Partial<AgentRegistryEntry>
  if (!entry.id || !entry.name || !entry.command) return null
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    command: entry.command,
    args: entry.args ?? [],
    env: entry.env ?? {},
    cwd: entry.cwd
  }
}
