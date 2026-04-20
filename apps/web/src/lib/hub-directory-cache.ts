import type { HubDirectorySnapshot } from '@panda/protocol'
import {
  mergeEntityArrayByKey,
  reuseStructurallyEqualValue,
} from './directory-structural-sharing'

export const patchHubDirectoryAgent = (
  snapshot: HubDirectorySnapshot | undefined | null,
  agentId: string,
  update: Partial<HubDirectorySnapshot['agents'][number]>,
  generatedAt: string = new Date().toISOString(),
): HubDirectorySnapshot | undefined | null => {
  if (!snapshot) {
    return snapshot
  }

  let changed = false
  const agents = snapshot.agents.map((agent) => {
    if (agent.id !== agentId) {
      return agent
    }

    const hasAgentChanged = Object.entries(update).some(
      ([key, value]) =>
        agent[key as keyof typeof agent] !== value,
    )
    if (!hasAgentChanged) {
      return agent
    }

    const nextAgent = {
      ...agent,
      ...update,
    }
    changed = true
    return nextAgent
  })

  if (!changed) {
    return snapshot
  }

  return {
    ...snapshot,
    generated_at: generatedAt,
    agents,
  }
}

export const mergeHubDirectorySnapshot = (
  current: HubDirectorySnapshot | undefined,
  next: HubDirectorySnapshot,
): HubDirectorySnapshot => {
  if (!current) {
    return next
  }

  const agents = mergeEntityArrayByKey(current.agents, next.agents, (agent) => agent.id)
  const generatedAt = reuseStructurallyEqualValue(
    current.generated_at,
    next.generated_at,
  )

  if (
    current.agents === agents &&
    current.generated_at === generatedAt
  ) {
    return current
  }

  return {
    ...next,
    generated_at: generatedAt,
    agents,
  }
}
