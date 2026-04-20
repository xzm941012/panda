import qrcode from 'qrcode-terminal'

type LoggerLike = {
  info?: (message: string, ...args: unknown[]) => void
}

const trimToNull = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized ? normalized : null
}

export const printTerminalQr = (
  url: string | null | undefined,
  options?: {
    logger?: LoggerLike
    label?: string
  },
) => {
  const normalizedUrl = trimToNull(url)
  if (!normalizedUrl) {
    return
  }

  const logger = options?.logger ?? console
  if (options?.label) {
    logger.info?.(options.label)
  }

  qrcode.generate(normalizedUrl, { small: true }, (rendered) => {
    const content = trimToNull(rendered)
    if (content) {
      logger.info?.(`\n${content}`)
    }
  })
}
