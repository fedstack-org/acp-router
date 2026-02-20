import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { AgentLaunchRequest, AgentLauncher, AgentProcess, AgentRegistryEntry } from './types.js'

export class NodeAgentLauncher implements AgentLauncher {
  async launch(request: AgentLaunchRequest, entry: AgentRegistryEntry): Promise<AgentProcess> {
    const args = [...(entry.args ?? []), ...(request.args ?? [])]
    const env = { ...process.env, ...(entry.env ?? {}), ...(request.env ?? {}) }
    const cwd = request.cwd ?? entry.cwd
    const child = spawn(entry.command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    if (!child.stdin || !child.stdout) throw new Error('Failed to spawn agent process')
    const stdin = streamToWritable(child.stdin)
    const stdout = streamToReadable(child.stdout)
    const stderr = child.stderr ? streamToReadable(child.stderr) : undefined
    return {
      stdin,
      stdout,
      stderr,
      pid: child.pid,
      kill: () => child.kill(),
      wait: () => new Promise((resolve) => child.once('exit', (code) => resolve(code ?? null)))
    }
  }
}

function streamToReadable(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      stream.on('end', () => controller.close())
      stream.on('error', (err: Error) => controller.error(err))
    },
    cancel() {
      stream.destroy()
    }
  })
}

function streamToWritable(stream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      stream.write(chunk)
    },
    close() {
      stream.end()
    },
    abort() {
      stream.destroy()
    }
  })
}
