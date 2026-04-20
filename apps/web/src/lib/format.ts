import type { AgentNode, SessionRef } from '@panda/protocol'

type DisplayNamedEntity = {
  name: string
  display_name?: string | null
  direct_base_url?: string | null
}

export const formatTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))

export const capabilityLabel = (session: SessionRef) => {
  if (session.mode === 'managed') return 'Managed'
  if (session.mode === 'attached-live') return 'Live'
  return 'History'
}

export const composerHint = (session: SessionRef) => {
  if (session.capability.can_send_input) {
    return '输入消息'
  }
  if (session.mode === 'attached-live') {
    return '当前会话只读'
  }
  return '历史会话只读'
}

export const sessionTone = (session: SessionRef) => {
  if (session.mode === 'managed') return 'session-pill--managed'
  if (session.mode === 'attached-live') return 'session-pill--live'
  return 'session-pill--history'
}

export const statusTone = (status: string) =>
  status === 'online' ? 'dot dot--online' : 'dot dot--offline'

export const healthOrder = (health: string) => {
  const order: Record<string, number> = { active: 0, idle: 1, attention: 2, offline: 3 }
  return order[health] ?? 4
}

export const agentTransportLabel = (agent: AgentNode) =>
  agent.transport === 'hub-routed' ? 'Hub' : 'Direct'

const readHostPortFromUrl = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) {
    return null
  }

  try {
    const parsed = new URL(normalized)
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    return normalized.replace(/\/+$/, '') || null
  }
}

export const agentDisplayName = (agent: DisplayNamedEntity) =>
  agent.display_name?.trim() ||
  agent.name.trim() ||
  readHostPortFromUrl(agent.direct_base_url) ||
  '未命名节点'

export const agentOriginalName = (agent: AgentNode) => {
  const displayName = agent.display_name?.trim() ?? ''
  if (!displayName || displayName === agent.name) {
    return null
  }

  return agent.name
}

export const agentAddressLabel = (agent: AgentNode) =>
  readHostPortFromUrl(agent.direct_base_url) ||
  agent.host ||
  agent.tailscale_ip ||
  agent.tailscale_dns_name ||
  agent.direct_base_url

export const sessionStateLabel = (session: SessionRef) => {
  if (session.health === 'active') return '运行中'
  if (session.health === 'idle') return '空闲'
  if (session.health === 'attention') return '注意'
  return '离线'
}

export const sessionMetaLine = (session: SessionRef) =>
  [capabilityLabel(session), session.branch, formatTime(session.last_event_at)].join(' · ')
