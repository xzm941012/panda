import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HubDirectorySnapshot, SocketEvent } from '@panda/protocol'
import { HUB_DIRECTORY_QUERY_KEY } from '../../lib/bootstrap-query'
import { getHubClient, patchCachedHubDirectory } from '../../lib/client'
import {
  mergeHubDirectorySnapshot,
  patchHubDirectoryAgent,
} from '../../lib/hub-directory-cache'
import { useRuntimeConfig } from '../../lib/runtime-config'
import {
  readSelectedAgentConnectionHint,
  readStoredAgentId,
} from '../../lib/session-selection'

const HUB_DIRECTORY_REFRESH_DEBOUNCE_MS = 180

export const HubPresenceBridge = () => {
  const queryClient = useQueryClient()
  const { hubUrl } = useRuntimeConfig()
  const refreshTimerRef = useRef<number | null>(null)
  const selectedAgentId = readStoredAgentId()
  const selectedAgentConnectionHint = readSelectedAgentConnectionHint(selectedAgentId)
  const shouldPreferAgentDirect = Boolean(
    selectedAgentId && selectedAgentConnectionHint,
  )

  useEffect(() => {
    if (!hubUrl || shouldPreferAgentDirect) {
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let hasConnectedOnce = false
    let shouldRefreshOnConnected = false
    let ignoreNextAgentOnline = false

    const clearRefreshTimer = () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }

    const applyPresencePatch = (agentId: string, status: 'online' | 'offline') => {
      const generatedAt = new Date().toISOString()
      queryClient.setQueryData<HubDirectorySnapshot | undefined>(
        HUB_DIRECTORY_QUERY_KEY,
        (current) =>
          patchHubDirectoryAgent(current, agentId, { status }, generatedAt) ?? current,
      )
      patchCachedHubDirectory((current) =>
        patchHubDirectoryAgent(current, agentId, { status }, generatedAt) ?? current,
      )
    }

    const refreshHubDirectory = async () => {
      try {
        const nextSnapshot = await getHubClient().getHubDirectory()
        if (cancelled) {
          return
        }

        patchCachedHubDirectory(() => nextSnapshot)
        queryClient.setQueryData<HubDirectorySnapshot | undefined>(
          HUB_DIRECTORY_QUERY_KEY,
          (current) => mergeHubDirectorySnapshot(current, nextSnapshot),
        )
      } catch {
        // Ignore best-effort presence refresh failures; reconnect recovery will retry.
      }
    }

    const scheduleRefresh = () => {
      clearRefreshTimer()
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null
        void refreshHubDirectory()
      }, HUB_DIRECTORY_REFRESH_DEBOUNCE_MS)
    }

    const handleEvent = (event: SocketEvent) => {
      if (event.type === 'agent.online') {
        if (ignoreNextAgentOnline) {
          ignoreNextAgentOnline = false
          return
        }

        const agentId =
          typeof event.payload?.agentId === 'string'
            ? event.payload.agentId.trim()
            : ''
        if (!agentId) {
          return
        }

        applyPresencePatch(agentId, 'online')
        scheduleRefresh()
        return
      }

      if (event.type === 'agent.offline') {
        const agentId =
          typeof event.payload?.agentId === 'string'
            ? event.payload.agentId.trim()
            : ''
        if (!agentId) {
          return
        }

        applyPresencePatch(agentId, 'offline')
        scheduleRefresh()
        return
      }

      if (event.type === 'snapshot.changed') {
        scheduleRefresh()
      }
    }

    void refreshHubDirectory()

    try {
      unsubscribe = getHubClient().connectEvents(handleEvent, {
        reconnectWhenHidden: true,
        onStatus: (status) => {
          if (status.state === 'connected') {
            ignoreNextAgentOnline = true
            if (hasConnectedOnce && shouldRefreshOnConnected) {
              shouldRefreshOnConnected = false
              scheduleRefresh()
            }

            hasConnectedOnce = true
            return
          }

          if (hasConnectedOnce) {
            shouldRefreshOnConnected = true
          }
        },
      })
    } catch {
      // Ignore missing/invalid hub config during shell transitions.
    }

    return () => {
      cancelled = true
      clearRefreshTimer()
      unsubscribe?.()
    }
  }, [hubUrl, queryClient, shouldPreferAgentDirect])

  return null
}
