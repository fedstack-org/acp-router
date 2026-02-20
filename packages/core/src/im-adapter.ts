import { EventEmitter } from 'node:events'
export type InlineAction = {
  id: string
  label: string
}

export type InlineActions = {
  columns?: number
  items: InlineAction[]
  callback: (actionId: string) => Promise<void>
}

export type InlineMessage = {
  markdown: string
  actions?: InlineActions
}

export type InlineUpdate = {
  markdown?: string
  actions?: Partial<InlineActions> | null
}

export type AdapterInteraction = {
  id: string
  message: InlineMessage
}

export type AdapterEventMap = {
  text: [chatId: string, text: string]
  command: [chatId: string, command: string, args: string[]]
}

export abstract class IMAdapter extends EventEmitter<AdapterEventMap> {
  abstract readonly platform: string
  abstract init(): Promise<void>
  abstract sendMarkdownText(chatId: string, markdown: string): Promise<void>
  abstract sendMedia(
    chatId: string,
    payload: { kind: string; mimeType: string; data: Uint8Array; filename?: string }
  ): Promise<void>
  abstract setCommands(commands: { name: string; description: string }[]): Promise<void>
  abstract sendInteractiveMessage(chatId: string, message: InlineMessage): Promise<AdapterInteraction>
  abstract updateInteractiveMessage(chatId: string, messageId: string, update: InlineUpdate): Promise<void>
  abstract setActive(chatId: string, active: boolean): Promise<void>
}
