import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { paths, type SessionCacheStore } from '@acp-router/core'

export class FileSessionCache implements SessionCacheStore {
  private path = paths.mappings
  private dir = paths.data

  async get(key: string): Promise<string | null> {
    try {
      const raw = await readFile(this.path, 'utf-8')
      const data = JSON.parse(raw) as Record<string, string>
      return data[key] ?? null
    } catch {
      return null
    }
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.readAll()
    data[key] = value
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.path, JSON.stringify(data, null, 2), 'utf-8')
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.path, 'utf-8')
      return JSON.parse(raw) as Record<string, string>
    } catch {
      return {}
    }
  }
}
