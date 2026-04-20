import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PluginListenerHandle } from '@capacitor/core'
import {
  BarcodeFormat,
  BarcodeScanner,
  LensFacing,
  Resolution,
  type Barcode,
} from '@capacitor-mlkit/barcode-scanning'
import {
  normalizeConnectionUrl,
  probeBackendConnection,
  type ConnectionProbeResult,
} from '../../lib/connection-probe'
import { isNativeApp } from '../../lib/platform'

type HubConnectionFormProps = {
  title: string
  description: string
  currentHubUrl?: string
  initialHubUrl: string
  hint: string
  saveLabel: string
  savingLabel: string
  saveDescription: string
  saveSuccessMessage: string
  onSaveSuccess: (result: ConnectionProbeResult) => Promise<void>
}

type NoticeTone = 'neutral' | 'success' | 'danger'

type NoticeState = {
  tone: NoticeTone
  text: string
} | null

const formatLatency = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '未测得'
  }

  return `${Math.max(0, Math.round(value))} ms`
}

const formatProbeTime = (value: string) => {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return value
  }

  return timestamp.toLocaleString('zh-CN', {
    hour12: false,
  })
}

const parseExplicitHubUrl = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return normalizeConnectionUrl(parsed.toString())
    }
  } catch {
    // Ignore invalid absolute URLs here and continue with other fallback patterns.
  }

  const matchedUrl = trimmed.match(/https?:\/\/[^\s]+/i)?.[0]
  return matchedUrl ? normalizeConnectionUrl(matchedUrl) : ''
}

const readScannedHubUrl = (barcode: Barcode) => {
  const candidates = [
    barcode.rawValue,
    barcode.displayValue,
    barcode.urlBookmark?.url,
  ]

  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? ''
    if (!trimmed) {
      continue
    }

    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol === 'panda:' && parsed.searchParams.get('url')) {
        return parseExplicitHubUrl(parsed.searchParams.get('url') ?? '')
      }

      return parseExplicitHubUrl(parsed.toString())
    } catch {
      return parseExplicitHubUrl(trimmed)
    }
  }

  return ''
}

const IconScan = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M7 4.75H5.9A1.9 1.9 0 0 0 4 6.65v1.1M17 4.75h1.1A1.9 1.9 0 0 1 20 6.65v1.1M20 16.25v1.1a1.9 1.9 0 0 1-1.9 1.9H17M7 19.25H5.9A1.9 1.9 0 0 1 4 17.35v-1.1" />
    <path d="M8 9.25h8M8 12h8M8 14.75h5" />
  </svg>
)

const IconClose = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 6 18 18M18 6 6 18" />
  </svg>
)

export const HubConnectionForm = ({
  title,
  description,
  currentHubUrl,
  initialHubUrl,
  hint,
  saveLabel,
  savingLabel,
  saveDescription,
  saveSuccessMessage,
  onSaveSuccess,
}: HubConnectionFormProps) => {
  const [draftHubUrl, setDraftHubUrl] = useState(initialHubUrl)
  const [probeState, setProbeState] = useState<{
    loading: boolean
    result: ConnectionProbeResult | null
  }>({
    loading: false,
    result: null,
  })
  const [saveState, setSaveState] = useState({
    saving: false,
  })
  const [notice, setNotice] = useState<NoticeState>(null)
  const [scannerState, setScannerState] = useState({
    active: false,
    starting: false,
  })
  const scanListenersRef = useRef<PluginListenerHandle[]>([])

  const trimmedHubUrl = normalizeConnectionUrl(draftHubUrl)
  const canScan = isNativeApp()

  useEffect(() => {
    setDraftHubUrl(initialHubUrl)
  }, [initialHubUrl])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    document.documentElement.classList.toggle('hub-scanner-active', scannerState.active)
    document.body.classList.toggle('hub-scanner-active', scannerState.active)
    return () => {
      document.documentElement.classList.remove('hub-scanner-active')
      document.body.classList.remove('hub-scanner-active')
    }
  }, [scannerState.active])

  useEffect(() => {
    return () => {
      void (async () => {
        await Promise.all(
          scanListenersRef.current.map((listener) =>
            listener.remove().catch(() => {}),
          ),
        )
        scanListenersRef.current = []
        await BarcodeScanner.stopScan().catch(() => {})
      })()
    }
  }, [])

  const clearScanListeners = async () => {
    const listeners = [...scanListenersRef.current]
    scanListenersRef.current = []
    await Promise.all(listeners.map((listener) => listener.remove().catch(() => {})))
  }

  const stopScanner = async () => {
    setScannerState((current) => ({
      ...current,
      active: false,
    }))
    await clearScanListeners()
    await BarcodeScanner.stopScan().catch(() => {})
  }

  const handleProbe = async () => {
    if (!trimmedHubUrl) {
      setNotice({
        tone: 'danger',
        text: '请先输入可访问的 Hub 地址。',
      })
      return
    }

    setNotice(null)
    setProbeState({
      loading: true,
      result: null,
    })

    const result = await probeBackendConnection(trimmedHubUrl)
    setProbeState({
      loading: false,
      result,
    })
    setNotice({
      tone: result.healthOk ? 'success' : 'danger',
      text: result.healthOk
        ? `连接成功，延迟 ${formatLatency(result.latencyMs)}。`
        : result.error ?? '连接测试失败。',
    })
  }

  const handleSave = async () => {
    if (!trimmedHubUrl) {
      setNotice({
        tone: 'danger',
        text: '请先输入可访问的 Hub 地址。',
      })
      return
    }

    setNotice(null)
    setSaveState({
      saving: true,
    })

    try {
      const result =
        probeState.result?.url === trimmedHubUrl
          ? probeState.result
          : await probeBackendConnection(trimmedHubUrl)

      setProbeState({
        loading: false,
        result,
      })

      if (!result.healthOk) {
        setNotice({
          tone: 'danger',
          text: result.error ?? '请先确认 Hub 地址可访问，再继续保存。',
        })
        return
      }

      await onSaveSuccess(result)
      setNotice({
        tone: 'success',
        text: saveSuccessMessage,
      })
    } catch (error) {
      setNotice({
        tone: 'danger',
        text: error instanceof Error ? error.message : '保存 Hub 地址失败。',
      })
    } finally {
      setSaveState({
        saving: false,
      })
    }
  }

  const handleStartScan = async () => {
    if (!canScan) {
      return
    }

    setNotice(null)
    setScannerState({
      active: false,
      starting: true,
    })

    try {
      const supportResult = await BarcodeScanner.isSupported()
      if (!supportResult.supported) {
        setNotice({
          tone: 'danger',
          text: '当前设备不支持扫码填入，请手动输入地址。',
        })
        return
      }

      const permissionStatus = await BarcodeScanner.requestPermissions()
      if (permissionStatus.camera !== 'granted' && permissionStatus.camera !== 'limited') {
        setNotice({
          tone: 'danger',
          text: '需要相机权限才能扫码，请在系统设置中允许 Panda 使用相机。',
        })
        return
      }

      const listeners = await Promise.all([
        BarcodeScanner.addListener('barcodesScanned', (event) => {
          const scannedHubUrl = event.barcodes.map(readScannedHubUrl).find(Boolean)
          if (!scannedHubUrl) {
            setNotice({
              tone: 'danger',
              text: '二维码已识别，但没有拿到可用的 Hub 地址。',
            })
            void stopScanner()
            return
          }

          setDraftHubUrl(scannedHubUrl)
          setProbeState({
            loading: false,
            result: null,
          })
          setNotice({
            tone: 'success',
            text: '已通过扫码填入地址，可以直接测试或保存。',
          })
          void stopScanner()
        }),
        BarcodeScanner.addListener('scanError', (event) => {
          setNotice({
            tone: 'danger',
            text: event.message || '扫码失败，请稍后重试。',
          })
          void stopScanner()
        }),
      ])

      scanListenersRef.current = listeners
      setScannerState({
        active: true,
        starting: false,
      })

      await BarcodeScanner.startScan({
        formats: [BarcodeFormat.QrCode],
        lensFacing: LensFacing.Back,
        resolution: Resolution['1280x720'],
      })
    } catch (error) {
      await stopScanner()
      setNotice({
        tone: 'danger',
        text: error instanceof Error ? error.message : '无法启动扫码，请稍后重试。',
      })
    } finally {
      setScannerState((current) => ({
        ...current,
        starting: false,
      }))
    }
  }

  const scannerOverlay =
    scannerState.active && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="hub-scanner-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="扫描 Hub 地址二维码"
          >
            <div className="hub-scanner-sheet__content">
              <div className="hub-scanner-sheet__topbar">
                <span className="hub-scanner-sheet__badge">扫码填入</span>
                <button
                  type="button"
                  className="hub-scanner-sheet__close"
                  onClick={() => {
                    void stopScanner()
                  }}
                  aria-label="关闭扫码"
                >
                  <IconClose />
                </button>
              </div>

              <div className="hub-scanner-sheet__frame" aria-hidden="true">
                <span className="hub-scanner-sheet__corner hub-scanner-sheet__corner--tl" />
                <span className="hub-scanner-sheet__corner hub-scanner-sheet__corner--tr" />
                <span className="hub-scanner-sheet__corner hub-scanner-sheet__corner--bl" />
                <span className="hub-scanner-sheet__corner hub-scanner-sheet__corner--br" />
              </div>

              <div className="hub-scanner-sheet__footer">
                <p>把电脑端显示的 Hub 二维码放进取景框，识别后会自动填入地址。</p>
                <button
                  type="button"
                  className="settings-ghost-button hub-scanner-sheet__cancel"
                  onClick={() => {
                    void stopScanner()
                  }}
                >
                  取消扫码
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <div className="hub-connection-form">
        <div className="hub-connection-form__header">
          <div className="hub-connection-form__copy">
            <h3 className="hub-connection-form__title">{title}</h3>
            <p className="hub-connection-form__description">{description}</p>
          </div>
          {currentHubUrl ? (
            <div className="hub-connection-form__current">
              <span>当前</span>
              <strong>{currentHubUrl}</strong>
            </div>
          ) : null}
        </div>

        <label className="hub-connection-form__field">
          <span className="hub-connection-form__label">Hub 地址</span>
          <span className="hub-connection-form__input-shell">
            <input
              className="hub-connection-form__input"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="例如 http://192.168.31.20:4343"
              value={draftHubUrl}
              onChange={(event) => {
                setDraftHubUrl(event.target.value)
                setProbeState({
                  loading: false,
                  result: null,
                })
                setNotice(null)
              }}
            />
            {canScan ? (
              <button
                type="button"
                className="hub-connection-form__scan"
                onClick={() => {
                  void handleStartScan()
                }}
                disabled={scannerState.starting || saveState.saving || probeState.loading}
                aria-label="扫码填入 Hub 地址"
              >
                <IconScan />
                <span>{scannerState.starting ? '启动中' : '扫码'}</span>
              </button>
            ) : null}
          </span>
        </label>

        <p className="hub-connection-form__hint">{hint}</p>

        <div className="hub-connection-form__actions">
          <button
            type="button"
            className="settings-action hub-connection-form__save"
            onClick={() => {
              void handleSave()
            }}
            disabled={!trimmedHubUrl || saveState.saving || scannerState.starting}
          >
            <div className="settings-action__copy">
              <strong>{saveState.saving ? savingLabel : saveLabel}</strong>
              <span>{saveDescription}</span>
            </div>
            <span className="settings-action__state">
              {saveState.saving ? '处理中…' : '→'}
            </span>
          </button>

          <button
            type="button"
            className="settings-ghost-button hub-connection-form__test"
            onClick={() => {
              void handleProbe()
            }}
            disabled={!trimmedHubUrl || probeState.loading || saveState.saving || scannerState.starting}
          >
            {probeState.loading ? '测试中…' : '测试连接'}
          </button>
        </div>

        {probeState.result ? (
          <div className="hub-connection-form__probe">
            <div className="hub-connection-form__probe-item">
              <span>探测地址</span>
              <strong>{probeState.result.url}</strong>
            </div>
            <div className="hub-connection-form__probe-item">
              <span>连通结果</span>
              <strong className={probeState.result.healthOk ? 'is-ok' : 'is-danger'}>
                {probeState.result.healthOk
                  ? 'Hub 在线'
                  : probeState.result.error ?? '无法连接'}
              </strong>
            </div>
            <div className="hub-connection-form__probe-item">
              <span>延迟</span>
              <strong>{formatLatency(probeState.result.latencyMs)}</strong>
            </div>
            <div className="hub-connection-form__probe-item">
              <span>最近探测</span>
              <strong>{formatProbeTime(probeState.result.checkedAt)}</strong>
            </div>
          </div>
        ) : null}

        {notice ? (
          <p className={`hub-connection-form__notice is-${notice.tone}`}>{notice.text}</p>
        ) : null}
      </div>

      {scannerOverlay}
    </>
  )
}
