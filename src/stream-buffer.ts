import type { Context } from 'grammy'

const MAX_MESSAGE_LENGTH = 4096
const FLUSH_THRESHOLD = 3000
const FLUSH_INTERVAL_MS = 5000

function hasOpenCodeBlock(text: string): boolean {
  let open = false
  let i = 0
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      open = !open
      i += 3
      if (open) {
        const nl = text.indexOf('\n', i)
        if (nl !== -1) i = nl + 1
      }
    } else {
      i++
    }
  }
  return open
}

function findSafeSplit(text: string, max: number): number {
  if (text.length <= max) return text.length
  const fence = text.lastIndexOf('\n```', max)
  if (fence > max / 2 && !hasOpenCodeBlock(text.slice(0, fence))) return fence
  const dblNl = text.lastIndexOf('\n\n', max)
  if (dblNl > max / 2 && !hasOpenCodeBlock(text.slice(0, dblNl))) return dblNl
  const nl = text.lastIndexOf('\n', max)
  if (nl > max / 2 && !hasOpenCodeBlock(text.slice(0, nl))) return nl
  const sp = text.lastIndexOf(' ', max)
  if (sp > max / 2 && !hasOpenCodeBlock(text.slice(0, sp))) return sp
  return max
}

export class StreamBuffer {
  buf = ''
  timer: ReturnType<typeof setTimeout> | null = null

  constructor(private ctx: Context) {}

  append(chunk: string) {
    this.buf += chunk
    if (this.buf.length >= FLUSH_THRESHOLD) {
      this.scheduleFlush(0)
    } else if (!this.timer) {
      this.scheduleFlush(FLUSH_INTERVAL_MS)
    }
  }

  private scheduleFlush(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.doFlush().catch(() => {})
    }, ms)
  }

  private async doFlush() {
    while (this.buf.length >= FLUSH_THRESHOLD) {
      const at = findSafeSplit(this.buf, MAX_MESSAGE_LENGTH)
      const chunk = this.buf.slice(0, at)
      this.buf = this.buf.slice(at).trimStart()
      await this.ctx.reply(chunk, { parse_mode: 'HTML' }).catch(() => {})
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.buf.length > MAX_MESSAGE_LENGTH) {
      const at = findSafeSplit(this.buf, MAX_MESSAGE_LENGTH)
      const chunk = this.buf.slice(0, at)
      this.buf = this.buf.slice(at).trimStart()
      await this.ctx.reply(chunk, { parse_mode: 'HTML' }).catch(() => {})
    }
    if (this.buf.trim()) {
      await this.ctx.reply(this.buf, { parse_mode: 'HTML' }).catch(() => {})
    }
    this.buf = ''
  }
}
