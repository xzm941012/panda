export type ConnectionProbeResult = {
  url: string
  healthOk: boolean
  latencyMs: number | null
  checkedAt: string
  error: string | null
}

const DEFAULT_PROBE_TIMEOUT_MS = 8_000

export const normalizeConnectionUrl = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) {
    return ''
  }

  const strippedTrailingSlash = normalized.replace(/\/+$/, '')
  try {
    const parsed = new URL(strippedTrailingSlash)
    if (parsed.pathname === '/health') {
      parsed.pathname = ''
      parsed.search = ''
      parsed.hash = ''
    }

    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return strippedTrailingSlash.replace(/\/health$/i, '')
  }
}

const createTimeoutError = (timeoutMs: number) =>
  new Error(`连接探测超时（${timeoutMs} ms），请确认手机能直接访问该 Hub 地址。`)

const readProbeErrorMessage = (error: unknown, timeoutMs: number) => {
  if (!(error instanceof Error)) {
    return '连接失败'
  }

  const normalizedMessage = error.message.trim()
  if (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    /aborted/i.test(normalizedMessage)
  ) {
    return createTimeoutError(timeoutMs).message
  }

  return normalizedMessage || '连接失败'
}
export const probeBackendConnection = async (
  url: string,
  options?: {
    timeoutMs?: number
  },
): Promise<ConnectionProbeResult> => {
  const normalizedUrl = normalizeConnectionUrl(url)
  const checkedAt = new Date().toISOString()

  if (!normalizedUrl) {
    return {
      url: '',
      healthOk: false,
      latencyMs: null,
      checkedAt,
      error: '地址为空',
    }
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const targetUrl = `${normalizedUrl}/health`
  const startTime =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()

  const controller = new AbortController()
  const timeout = window.setTimeout(
    () => controller.abort(createTimeoutError(timeoutMs)),
    timeoutMs,
  )

  try {
    const response = await fetch(targetUrl, {
      cache: 'no-store',
      signal: controller.signal,
    })
    const endTime =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()

    return {
      url: normalizedUrl,
      healthOk: response.ok,
      latencyMs: endTime - startTime,
      checkedAt,
      error: response.ok ? null : `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      url: normalizedUrl,
      healthOk: false,
      latencyMs: null,
      checkedAt,
      error: readProbeErrorMessage(error, timeoutMs),
    }
  } finally {
    clearTimeout(timeout)
  }
}
