import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { v7 as uuidv7 } from 'uuid'
import { paths } from './paths.js'

function extFromMime(mime: string): string {
  const idx = mime.indexOf('/')
  return idx === -1 ? 'bin' : mime.slice(idx + 1)
}

export async function writeMediaCacheFile(
  chatId: string,
  mimeType: string,
  data: Uint8Array
): Promise<string> {
  const dir = join(paths.mediaCache, chatId)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${uuidv7()}.${extFromMime(mimeType)}`)
  await writeFile(filePath, data)
  return filePath
}
