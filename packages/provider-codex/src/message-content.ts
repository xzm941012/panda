import path from 'node:path'
import {
  dedupeTimelineAttachments,
  type SessionInputAttachment,
  type TimelineAttachment,
} from '@panda/protocol'

type ParsedMessageContent = {
  text: string
  attachments: TimelineAttachment[]
}

type ParsedDataUrl = {
  mimeType: string | null
  base64: string
}

const TEXT_ITEM_TYPES = new Set(['input_text', 'output_text', 'text'])
const ATTACHMENT_PLACEHOLDER_PATTERN = /^<\/?(image|file)>$/i

const readNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const parseDataUrl = (value: string): ParsedDataUrl | null => {
  const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(value.trim())
  if (!match) {
    return null
  }

  return {
    mimeType: match[1]?.trim() || null,
    base64: match[2] ?? '',
  }
}

const inferNameFromUrl = (value: string) => {
  try {
    const parsed = new URL(value)
    const basename = path.posix.basename(parsed.pathname)
    return basename && basename !== '/' ? basename : null
  } catch {
    return null
  }
}

const inferNameFromPath = (value: string) => {
  const basename = path.basename(value.trim())
  return basename && basename !== '/' ? basename : null
}

const inferMimeType = (
  contentUrl: string | null,
  explicitMimeType: string | null,
) => explicitMimeType ?? (contentUrl ? parseDataUrl(contentUrl)?.mimeType ?? null : null)

const toTimelineAttachment = (
  item: Record<string, unknown>,
  index: number,
): TimelineAttachment | null => {
  const type = readNonEmptyString(item.type)
  if (!type) {
    return null
  }

  if (type === 'input_image' || type === 'image') {
    const contentUrl =
      readNonEmptyString(item.image_url) ?? readNonEmptyString(item.url)
    if (!contentUrl) {
      return null
    }

    return {
      id: `attachment-${index}`,
      kind: 'image',
      name: readNonEmptyString(item.filename),
      mime_type: inferMimeType(
        contentUrl,
        readNonEmptyString(item.mime_type) ?? readNonEmptyString(item.media_type),
      ),
      size_bytes: null,
      content_url: contentUrl,
    }
  }

  if (type === 'localImage') {
    const localPath = readNonEmptyString(item.path)
    if (!localPath) {
      return null
    }

    return {
      id: `attachment-${index}`,
      kind: 'image',
      name: readNonEmptyString(item.filename) ?? inferNameFromPath(localPath),
      mime_type:
        readNonEmptyString(item.mime_type) ?? readNonEmptyString(item.media_type),
      size_bytes: null,
      content_url: null,
    }
  }

  if (type === 'input_file') {
    const explicitMimeType =
      readNonEmptyString(item.mime_type) ?? readNonEmptyString(item.media_type)
    const directUrl = readNonEmptyString(item.file_url)
    const dataUrl =
      directUrl ??
      (() => {
        const fileData = readNonEmptyString(item.file_data)
        if (!fileData) {
          return null
        }

        return `data:${explicitMimeType ?? 'application/octet-stream'};base64,${fileData}`
      })()

    return {
      id: `attachment-${index}`,
      kind: 'file',
      name:
        readNonEmptyString(item.filename) ??
        (directUrl ? inferNameFromUrl(directUrl) : null),
      mime_type: inferMimeType(dataUrl, explicitMimeType),
      size_bytes: null,
      content_url: dataUrl,
    }
  }

  return null
}

const isAttachmentPlaceholderText = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }

  return trimmed
    .split('\n')
    .every((line) => ATTACHMENT_PLACEHOLDER_PATTERN.test(line.trim()))
}

export const parseMessageContent = (content: unknown): ParsedMessageContent => {
  if (!Array.isArray(content)) {
    return {
      text: '',
      attachments: [],
    }
  }

  const textParts: string[] = []
  const attachments: TimelineAttachment[] = []

  content.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      return
    }

    const candidate = item as Record<string, unknown>
    const type = readNonEmptyString(candidate.type)

    if (type && TEXT_ITEM_TYPES.has(type)) {
      const text = readNonEmptyString(candidate.text)
      if (text && !isAttachmentPlaceholderText(text)) {
        textParts.push(text)
      }
      return
    }

    const attachment = toTimelineAttachment(candidate, index)
    if (attachment) {
      attachments.push(attachment)
    }
  })

  return {
    text: textParts.join('\n\n').trim(),
    attachments: dedupeTimelineAttachments(attachments),
  }
}

export const buildInlineTimelineAttachments = (
  attachments: SessionInputAttachment[] | undefined,
): TimelineAttachment[] =>
  dedupeTimelineAttachments(
    (attachments ?? []).map((attachment, index) => ({
      id: attachment.id || `attachment-${index}`,
      kind: attachment.kind,
      name: attachment.name,
      mime_type:
        attachment.mime_type ?? parseDataUrl(attachment.data_url)?.mimeType ?? null,
      size_bytes: attachment.size_bytes ?? null,
      content_url: attachment.data_url,
    })),
  )

export const buildAppServerMessageInput = (
  prompt: string,
  attachments: SessionInputAttachment[] | undefined,
) => {
  const inputItems: Array<Record<string, string>> = []
  const trimmedPrompt = prompt.trim()

  if (trimmedPrompt) {
    inputItems.push({
      type: 'text',
      text: trimmedPrompt,
    })
  }

  for (const attachment of attachments ?? []) {
    if (attachment.kind === 'image') {
      inputItems.push({
        type: 'image',
        url: attachment.data_url,
      })
    }
  }

  return inputItems
}
