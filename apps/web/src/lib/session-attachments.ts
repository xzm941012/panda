import {
  dedupeTimelineAttachments,
  type SessionInputAttachment,
  type TimelineAttachment,
} from '@panda/protocol'

const IMAGE_MIME_PREFIX = 'image/'

const createAttachmentId = () =>
  `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('无法读取文件'))
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result) {
        resolve(reader.result)
        return
      }

      reject(new Error('无法读取文件'))
    }
    reader.readAsDataURL(file)
  })

export const createSessionInputAttachment = async (
  file: File,
): Promise<SessionInputAttachment> => ({
  id: createAttachmentId(),
  kind: file.type.startsWith(IMAGE_MIME_PREFIX) ? 'image' : 'file',
  name: file.name,
  mime_type: file.type || null,
  size_bytes: Number.isFinite(file.size) ? Math.max(0, Math.round(file.size)) : null,
  data_url: await readFileAsDataUrl(file),
})

export const isImageTimelineAttachment = (attachment: TimelineAttachment) =>
  attachment.kind === 'image' ||
  Boolean(attachment.mime_type?.startsWith(IMAGE_MIME_PREFIX))

export const toTimelineAttachments = (
  attachments: SessionInputAttachment[] | undefined,
): TimelineAttachment[] =>
  dedupeTimelineAttachments(
    (attachments ?? []).map((attachment, index) => ({
      id: attachment.id || `attachment-${index}`,
      kind: attachment.kind,
      name: attachment.name,
      mime_type: attachment.mime_type ?? null,
      size_bytes: attachment.size_bytes ?? null,
      content_url: attachment.data_url,
    })),
  )

export const formatAttachmentSize = (sizeBytes: number | null | undefined) => {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return null
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}
