import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Outlet } from '@tanstack/react-router'
import { useRouterState } from '@tanstack/react-router'
import { RuntimeOnboardingGate } from './runtime-onboarding-gate'
import { HubPresenceBridge } from './hub-presence-bridge'
import { SessionCompletionNotifier } from './session-completion-notifier'
import { SettingsOverlay } from '../settings/settings-overlay'
import {
  addCompletionNotificationOpenListener,
  refreshCompletionNotificationPermission,
} from '../../lib/notifications'
import { applyThemeToDocument, subscribeToSystemTheme } from '../../lib/theme'
import { requiresRuntimeOnboarding, useRuntimeConfig } from '../../lib/runtime-config'
import {
  readSelectedAgentConnectionHint,
  readStoredAgentId,
} from '../../lib/session-selection'
import { useUiStore } from '../../store/ui-store'

export const AppShell = () => {
  const navigate = useNavigate()
  const runtimeConfig = useRuntimeConfig()
  void runtimeConfig
  const themeSettings = useUiStore((state) => state.themeSettings)
  const systemAppearance = useUiStore((state) => state.systemAppearance)
  const setSystemAppearance = useUiStore((state) => state.setSystemAppearance)
  const isSettingsOverlayOpen = useUiStore((state) => state.isSettingsOverlayOpen)
  const closeSettingsOverlay = useUiStore((state) => state.closeSettingsOverlay)
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const settingsOverlayOriginPathRef = useRef<string | null>(null)
  const selectedAgentId = readStoredAgentId()
  const selectedAgentConnectionHint = readSelectedAgentConnectionHint(selectedAgentId)
  const shouldPreferAgentDirect = Boolean(
    selectedAgentId && selectedAgentConnectionHint,
  )

  useEffect(() => {
    applyThemeToDocument(themeSettings, systemAppearance)
  }, [systemAppearance, themeSettings])

  useEffect(() => subscribeToSystemTheme(setSystemAppearance), [setSystemAppearance])

  useEffect(() => {
    void refreshCompletionNotificationPermission().catch(() => {})
  }, [])

  useEffect(() => {
    let cleanup: (() => void) | undefined

    void addCompletionNotificationOpenListener((url) => {
      void navigate({ to: url as never }).catch(() => {
        if (typeof window !== 'undefined') {
          window.location.assign(url)
        }
      })
    }).then((dispose) => {
      cleanup = dispose
    })

    return () => {
      cleanup?.()
    }
  }, [navigate])

  useEffect(() => {
    if (!isSettingsOverlayOpen) {
      settingsOverlayOriginPathRef.current = null
      return
    }

    if (settingsOverlayOriginPathRef.current === null) {
      settingsOverlayOriginPathRef.current = pathname
      return
    }

    if (pathname !== settingsOverlayOriginPathRef.current) {
      closeSettingsOverlay()
    }
  }, [closeSettingsOverlay, isSettingsOverlayOpen, pathname])

  if (requiresRuntimeOnboarding()) {
    return <RuntimeOnboardingGate />
  }

  return (
    <div className="app-shell">
      {!shouldPreferAgentDirect ? <HubPresenceBridge /> : null}
      <SessionCompletionNotifier />
      <div className="app-shell__content" aria-hidden={isSettingsOverlayOpen}>
        <Outlet />
      </div>
      {isSettingsOverlayOpen ? <SettingsOverlay onClose={closeSettingsOverlay} /> : null}
    </div>
  )
}
