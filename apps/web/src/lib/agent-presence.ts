import type { AgentStatus } from '@panda/protocol'

export type AgentTransportState =
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'idle'

export type AgentIndicatorState = 'online' | 'reconnecting' | 'offline'

export const deriveAgentIndicatorState = (
  hubPresence: AgentStatus | null | undefined,
  transportState: AgentTransportState | null | undefined,
): AgentIndicatorState => {
  if (hubPresence === 'offline') {
    return 'offline'
  }

  if (hubPresence === 'online' && transportState === 'connected') {
    return 'online'
  }

  return hubPresence === 'online' ? 'reconnecting' : 'offline'
}

export const getAgentIndicatorLabel = (state: AgentIndicatorState) => {
  switch (state) {
    case 'online':
      return '节点在线'
    case 'reconnecting':
      return '节点重连中'
    case 'offline':
      return '节点离线'
    default:
      return '节点状态未知'
  }
}
