import type { ContentBlock } from './types.js'

export type NormalizedContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; data: Uint8Array }
  | { kind: 'audio'; mimeType: string; data: Uint8Array }
  | { kind: 'video'; mimeType: string; data: Uint8Array }
  | { kind: 'document'; mimeType: string; data: Uint8Array }
  | { kind: 'unknown'; type: string }

export function normalizeContent(block: ContentBlock): NormalizedContent {
  switch (block.type) {
    case 'text':
      return { kind: 'text', text: block.text }
    case 'image':
      return { kind: 'image', mimeType: block.mimeType, data: decodeBase64(block.data) }
    case 'audio':
      return { kind: 'audio', mimeType: block.mimeType, data: decodeBase64(block.data) }
    case 'resource_link':
      return { kind: 'unknown', type: 'resource_link' }
    case 'resource': {
      const res = block.resource
      if ('blob' in res && res.blob) {
        const mime = res.mimeType ?? 'application/octet-stream'
        const data = decodeBase64(res.blob)
        if (mime.startsWith('image/')) return { kind: 'image', mimeType: mime, data }
        if (mime.startsWith('audio/')) return { kind: 'audio', mimeType: mime, data }
        if (mime.startsWith('video/')) return { kind: 'video', mimeType: mime, data }
        return { kind: 'document', mimeType: mime, data }
      }
      return { kind: 'unknown', type: 'resource' }
    }
    default:
      return { kind: 'unknown', type: (block as { type: string }).type }
  }
}

function decodeBase64(data: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return Buffer.from(data, 'base64')
  const bin = globalThis.atob(data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
