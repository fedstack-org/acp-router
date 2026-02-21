import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = join(homedir(), '.acp-router')

export const paths = {
  base: BASE,
  settings: join(BASE, 'settings.json'),
  data: join(BASE, 'data'),
  mappings: join(BASE, 'data', 'mappings.json'),
  mediaCache: join(BASE, 'cache', 'media'),
}
