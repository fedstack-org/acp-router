import { EventEmitter } from 'node:events'

export type AnnotationKind = 'skip' | 'block'

export type ReactionKind = 'queued' | 'pending' | 'aborted' | 'ignored'

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

export type TextMessageKind = 'message' | 'thought'

export type InteractiveMessageKind = 'generic' | 'tool' | 'permission' | 'status' | 'picker'

export type AdapterInteraction = {
  id: string
  message: InlineMessage
}

export type MediaPayload = {
  kind: 'image' | 'audio' | 'video' | 'document' | 'voice' | 'animation' | 'video_note' | 'sticker'
  mimeType: string
  filePath: string
  filename?: string
  caption?: string
  duration?: number
  width?: number
  height?: number
  fileSize?: number
}

export type AdapterEventMap = {
  text: [chatId: string, messageId: string, text: string]
  command: [chatId: string, messageId: string, command: string, args: string[]]
  annotation: [chatId: string, messageId: string, kind: AnnotationKind | undefined]
  media: [chatId: string, messageId: string, media: MediaPayload]
}

export abstract class IMAdapter extends EventEmitter<AdapterEventMap> {
  abstract readonly platform: string
  abstract init(): Promise<void>
  abstract sendTextMessage(chatId: string, markdown: string, kind?: TextMessageKind): Promise<void>
  abstract sendMedia(
    chatId: string,
    payload: { kind: string; mimeType: string; filePath: string }
  ): Promise<void>
  abstract setCommands(commands: { name: string; description: string }[]): Promise<void>
  abstract sendInteractiveMessage(chatId: string, message: InlineMessage, kind?: InteractiveMessageKind): Promise<AdapterInteraction>
  abstract editInteractiveMessage(chatId: string, messageId: string, update: InlineUpdate): Promise<void>
  abstract setActive(chatId: string, active: boolean): Promise<void>
  abstract setReaction(chatId: string, messageId: string, kind: ReactionKind | undefined): Promise<void>
}
