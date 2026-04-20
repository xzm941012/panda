import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { PencilLine, Trash2 } from 'lucide-react'
import type { AgentNode, HubDirectorySnapshot } from '@panda/protocol'
import { HUB_DIRECTORY_QUERY_KEY } from '../../lib/bootstrap-query'
import { resolveConnectionTarget } from '../../lib/client'
import { syncHubDirectory } from '../../lib/directory-sync'
import {
  agentAddressLabel,
  agentDisplayName,
  agentOriginalName,
} from '../../lib/format'
import {
  queuePendingDirectoryPicker,
  queuePendingProjectId,
  queuePendingSessionId,
  writeSelectedAgentConnectionHint,
  writeStoredAgentId,
  writeStoredSessionId,
} from '../../lib/session-selection'
import { useHubDirectory } from '../../lib/use-hub-directory'
import { EmptyState } from '../shared/empty-state'

const updateAgentRequest = async (payload: {
  agentId: string
  action: 'rename' | 'delete'
  displayName?: string | null
}) => {
  const target = await resolveConnectionTarget()
  return target.client.updateAgent({
    agentId: payload.agentId,
    action: payload.action,
    displayName: payload.displayName ?? null,
  })
}

const patchSnapshotAgent = (
  snapshot: HubDirectorySnapshot | undefined,
  agentId: string,
  update: Partial<AgentNode>,
) => {
  if (!snapshot) {
    return snapshot
  }

  return {
    ...snapshot,
    agents: snapshot.agents.map((agent) =>
      agent.id === agentId ? { ...agent, ...update } : agent,
    ),
  }
}

const removeSnapshotAgent = (
  snapshot: HubDirectorySnapshot | undefined,
  agentId: string,
) => {
  if (!snapshot) {
    return snapshot
  }

  return {
    ...snapshot,
    agents: snapshot.agents.filter((agent) => agent.id !== agentId),
  }
}

export const NodesPage = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const {
    data: snapshot,
    isPending,
    isFetching,
    error: snapshotError,
  } = useHubDirectory()

  const [canManageNodes, setCanManageNodes] = useState(false)
  const [renameAgentId, setRenameAgentId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteAgentId, setDeleteAgentId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [rescuedSnapshot, setRescuedSnapshot] = useState<HubDirectorySnapshot | null>(null)
  const [rescueError, setRescueError] = useState<string | null>(null)
  const [isRescuingSnapshot, setIsRescuingSnapshot] = useState(false)

  const effectiveSnapshot = snapshot ?? rescuedSnapshot
  const agents = effectiveSnapshot?.agents ?? []

  useEffect(() => {
    let cancelled = false

    void resolveConnectionTarget()
      .then((target) => {
        if (!cancelled) {
          setCanManageNodes(target.mode === 'hub')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCanManageNodes(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!snapshot) {
      return
    }

    setRescuedSnapshot(snapshot)
    setRescueError(null)
  }, [snapshot])

  useEffect(() => {
    if (snapshot || isRescuingSnapshot) {
      return
    }

    let cancelled = false
    const rescueTimer = window.setTimeout(() => {
      if (cancelled) {
        return
      }

      setIsRescuingSnapshot(true)
      setRescueError(null)
      queryClient.removeQueries({ queryKey: HUB_DIRECTORY_QUERY_KEY })
      void syncHubDirectory(queryClient)
        .then((nextSnapshot) => {
          if (cancelled) {
            return
          }

          setRescuedSnapshot(nextSnapshot)
        })
        .catch((error) => {
          if (cancelled) {
            return
          }

          setRescueError(error instanceof Error ? error.message : '节点列表刷新失败')
        })
        .finally(() => {
          if (!cancelled) {
            setIsRescuingSnapshot(false)
          }
        })
    }, 1200)

    return () => {
      cancelled = true
      window.clearTimeout(rescueTimer)
    }
  }, [queryClient, snapshot, isRescuingSnapshot])

  const renameAgent = useMemo(
    () => agents.find((agent) => agent.id === renameAgentId) ?? null,
    [agents, renameAgentId],
  )
  const deleteAgent = useMemo(
    () => agents.find((agent) => agent.id === deleteAgentId) ?? null,
    [agents, deleteAgentId],
  )

  const nodeActionMutation = useMutation({
    mutationFn: updateAgentRequest,
    onMutate: async (variables) => {
      setActionError(null)
      await queryClient.cancelQueries({ queryKey: HUB_DIRECTORY_QUERY_KEY })
      const previousSnapshot =
        queryClient.getQueryData<HubDirectorySnapshot>(HUB_DIRECTORY_QUERY_KEY)

      if (variables.action === 'rename') {
        queryClient.setQueryData<HubDirectorySnapshot | undefined>(
          HUB_DIRECTORY_QUERY_KEY,
          (current) =>
            patchSnapshotAgent(current, variables.agentId, {
              display_name: variables.displayName?.trim() || null,
            }),
        )
      }

      if (variables.action === 'delete') {
        queryClient.setQueryData<HubDirectorySnapshot | undefined>(
          HUB_DIRECTORY_QUERY_KEY,
          (current) => removeSnapshotAgent(current, variables.agentId),
        )
      }

      return { previousSnapshot }
    },
    onSuccess: (_result, variables) => {
      if (variables.action === 'rename') {
        setRenameAgentId(null)
        setRenameDraft('')
      }

      if (variables.action === 'delete') {
        setDeleteAgentId(null)
      }
    },
    onError: (error, _variables, context) => {
      if (context?.previousSnapshot) {
        queryClient.setQueryData(HUB_DIRECTORY_QUERY_KEY, context.previousSnapshot)
      }
      setActionError(error instanceof Error ? error.message : '节点操作失败')
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: HUB_DIRECTORY_QUERY_KEY })
    },
  })

  const pendingAction = nodeActionMutation.isPending
    ? nodeActionMutation.variables?.action ?? null
    : null
  const pendingAgentId = nodeActionMutation.isPending
    ? nodeActionMutation.variables?.agentId ?? null
    : null

  const openAgent = (agent: AgentNode) => {
    writeStoredAgentId(agent.id)
    writeStoredSessionId(null)
    queuePendingSessionId(null)
    queuePendingProjectId(null)
    queuePendingDirectoryPicker(false)
    writeSelectedAgentConnectionHint({
      agentId: agent.id,
      name: agent.name,
      displayName: agent.display_name ?? null,
      directBaseUrl: agent.direct_base_url,
      wsBaseUrl: agent.ws_base_url,
      createdAt: new Date().toISOString(),
    })
    void navigate({ to: '/' })
  }

  const renameDialog =
    renameAgent && typeof document !== 'undefined'
      ? createPortal(
          <div className="sheet-wrap sheet-wrap--centered" role="dialog" aria-modal="true">
            <button
              type="button"
              className="sheet-wrap__scrim"
              onClick={() => {
                setRenameAgentId(null)
                setRenameDraft('')
                setActionError(null)
              }}
              aria-label="关闭节点备注面板"
            />
            <div className="sheet-wrap__center">
              <div className="sheet-panel sheet-panel--form sheet-panel--centered node-sheet">
                <div className="node-sheet__eyebrow">节点备注</div>
                <div className="sheet-panel__title">修改显示名称</div>
                <p className="node-sheet__description">
                  留空后会恢复显示为原始节点名。
                </p>
                <div className="node-sheet__meta">
                  <span>{renameAgent.name}</span>
                  <span>{agentAddressLabel(renameAgent)}</span>
                </div>
                <input
                  className="sheet-panel__input"
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  placeholder={renameAgent.name}
                  autoFocus
                />
                {actionError ? <p className="error-text">{actionError}</p> : null}
                <div className="sheet-panel__actions">
                  <button
                    type="button"
                    className="sheet-panel__button"
                    onClick={() => {
                      setRenameAgentId(null)
                      setRenameDraft('')
                      setActionError(null)
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="sheet-panel__button is-primary"
                    disabled={pendingAction === 'rename' && pendingAgentId === renameAgent.id}
                    onClick={() => {
                      nodeActionMutation.mutate({
                        agentId: renameAgent.id,
                        action: 'rename',
                        displayName: renameDraft.trim() || null,
                      })
                    }}
                  >
                    {pendingAction === 'rename' && pendingAgentId === renameAgent.id
                      ? '保存中...'
                      : '保存'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  const deleteDialog =
    deleteAgent && typeof document !== 'undefined'
      ? createPortal(
          <div className="sheet-wrap sheet-wrap--centered" role="dialog" aria-modal="true">
            <button
              type="button"
              className="sheet-wrap__scrim"
              onClick={() => {
                setDeleteAgentId(null)
                setActionError(null)
              }}
              aria-label="关闭删除节点面板"
            />
            <div className="sheet-wrap__center">
              <div className="sheet-panel sheet-panel--form sheet-panel--centered node-sheet node-sheet--danger">
                <div className="node-sheet__eyebrow is-danger">删除注册</div>
                <div className="sheet-panel__title">确认移除这个节点？</div>
                <p className="node-sheet__description">
                  这只会删除当前 Hub 里的注册记录，不会删除远端机器。agent
                  重新注册后可以再次加入。
                </p>
                <div className="node-sheet__meta">
                  <span>{agentDisplayName(deleteAgent)}</span>
                  <span>{agentAddressLabel(deleteAgent)}</span>
                </div>
                {actionError ? <p className="error-text">{actionError}</p> : null}
                <div className="sheet-panel__actions">
                  <button
                    type="button"
                    className="sheet-panel__button"
                    onClick={() => {
                      setDeleteAgentId(null)
                      setActionError(null)
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="sheet-panel__button node-sheet__button-danger"
                    disabled={pendingAction === 'delete' && pendingAgentId === deleteAgent.id}
                    onClick={() => {
                      nodeActionMutation.mutate({
                        agentId: deleteAgent.id,
                        action: 'delete',
                      })
                    }}
                  >
                    {pendingAction === 'delete' && pendingAgentId === deleteAgent.id
                      ? '删除中...'
                      : '确认删除'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div className="nodes-screen">
      <div className="nodes-screen__header">
        <h1>节点列表</h1>
        <p>查看所有在线节点和局域网地址</p>
      </div>

      <div className="nodes-screen__content node-list">
        {!effectiveSnapshot && (isPending || isFetching || isRescuingSnapshot) ? (
          <EmptyState message="正在读取节点列表..." />
        ) : !effectiveSnapshot && (snapshotError || rescueError) ? (
          <EmptyState
            message={
              snapshotError instanceof Error
                ? snapshotError.message
                : rescueError ?? '节点列表加载失败'
            }
          />
        ) : agents.length === 0 ? (
          <EmptyState message="暂无节点" />
        ) : (
          agents.map((agent) => {
            const originalName = agentOriginalName(agent)
            const displayName = agentDisplayName(agent)
            const isRenamePending =
              pendingAction === 'rename' && pendingAgentId === agent.id
            const isDeletePending =
              pendingAction === 'delete' && pendingAgentId === agent.id

            return (
              <article
                key={agent.id}
                className={`node-card ${canManageNodes ? 'node-card--manageable' : ''}`}
              >
                <button
                  type="button"
                  className="node-card__surface"
                  onClick={() => openAgent(agent)}
                >
                  <div className="node-card__title-stack">
                    <strong>{displayName}</strong>
                    {originalName ? (
                      <span className="node-card__secondary-name">
                        原名称 · {originalName}
                      </span>
                    ) : null}
                  </div>

                  <div className="node-card__ip">{agentAddressLabel(agent)}</div>
                </button>

                <div className="node-card__rail">
                  <span
                    className={`node-status-dot ${agent.status}`}
                    aria-label={agent.status === 'online' ? '节点在线' : '节点离线'}
                    title={agent.status === 'online' ? '节点在线' : '节点离线'}
                  />

                  {canManageNodes ? (
                    <div className="node-card__actions">
                      <button
                        type="button"
                        className="node-card__icon-button"
                        aria-label={`修改 ${displayName} 的备注名称`}
                        title="修改备注名称"
                        disabled={isDeletePending}
                        onClick={() => {
                          setDeleteAgentId(null)
                          setActionError(null)
                          setRenameAgentId(agent.id)
                          setRenameDraft(agent.display_name ?? '')
                        }}
                      >
                        <PencilLine size={16} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        className="node-card__icon-button is-danger"
                        aria-label={`删除 ${displayName} 节点注册`}
                        title="删除注册节点"
                        disabled={isRenamePending}
                        onClick={() => {
                          setRenameAgentId(null)
                          setRenameDraft('')
                          setActionError(null)
                          setDeleteAgentId(agent.id)
                        }}
                      >
                        <Trash2 size={16} strokeWidth={2} />
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>
            )
          })
        )}
      </div>

      {renameDialog}
      {deleteDialog}
    </div>
  )
}
