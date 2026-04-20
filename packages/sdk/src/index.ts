import {
  changeSetSummarySchema,
  codexCommandCatalogSchema,
  codexCommandPanelResponseSchema,
  createMockPhaseOneSnapshot,
  createDirectoryResponseSchema,
  devManagerActionResponseSchema,
  devManagerConfigUpdateSchema,
  devManagerSnapshotSchema,
  directoryNodeSchema,
  hubDirectorySnapshotSchema,
  hubRecentSessionsSnapshotSchema,
  phaseOneSnapshotSchema,
  projectSkillSchema,
  sessionLocationSchema,
  sessionRunCommandCatalogResponseSchema,
  sessionRunCommandGenerationResponseSchema,
  sessionRunWebsiteCatalogResponseSchema,
  sessionRunWebsiteGenerationResponseSchema,
  sessionRunWorkbenchSchema,
  sessionTerminalActionResponseSchema,
  sessionTerminalOutputSchema,
  sessionGitActionResponseSchema,
  sessionFilePreviewContentResponseSchema,
  sessionFilePreviewTreeResponseSchema,
  sessionTurnActionResponseSchema,
  sessionGitHistorySchema,
  sessionGitHistoryFileDiffSchema,
  sessionInteractionRequestSchema,
  sessionInputAttachmentSchema,
  sessionGitWorkspaceSchema,
  sessionGitWorkspaceFileDiffSchema,
  sessionBootstrapSnapshotSchema,
  sessionChangeSetFileDiffSchema,
  sessionPlanSnapshotSchema,
  sessionRecoverySnapshotSchema,
  sessionToolCallDetailSchema,
  socketEventSchema,
  sessionTimelineSnapshotSchema,
  workspaceDirectorySnapshotSchema,
  workspaceSessionBucketSchema,
  workspaceSessionDetailResponseSchema,
  workspaceSessionPageSchema,
  webPushPublicConfigSchema,
  webPushSubscriptionRemoveRequestSchema,
  webPushSubscriptionResponseSchema,
  webPushSubscriptionSettingsSchema,
  webPushTestRequestSchema,
  webPushTestResponseSchema,
  type ChangeSetSummary,
  type CodexCommandCatalog,
  type CodexCommandPanelResponse,
  type CreateDirectoryResponse,
  type DevManagerActionResponse,
  type DevManagerConfigUpdate,
  type DevManagerSnapshot,
  type DirectoryNode,
  type HubDirectorySnapshot,
  type HubRecentSessionsSnapshot,
  type AgentRegistrationResponse,
  type AgentActionResponse,
  type AgentAction,
  agentRegistrationResponseSchema,
  agentActionResponseSchema,
  type PhaseOneSnapshot,
  type ProjectSkill,
  type SessionLocation,
  type SessionRunCommandCatalogResponse,
  type SessionRunCommandDraft,
  type SessionRunCommandGenerationResponse,
  type SessionRunWebsiteCatalogResponse,
  type SessionRunWebsiteDraft,
  type SessionRunWebsiteGenerationResponse,
  type SessionRunWorkbench,
  type SessionTerminalActionResponse,
  type SessionTerminalOutput,
  type SessionGitActionResponse,
  type SessionFilePreviewContentResponse,
  type SessionFilePreviewTreeResponse,
  type SessionTurnActionResponse,
  type SessionGitHistory,
  type SessionGitHistoryFileDiff,
  type SessionGitWorkspace,
  type SessionGitWorkspaceFileDiff,
  type SessionInteractionRequest,
  type SessionBootstrapSnapshot,
  type SessionChangeSetFileDiff,
  type SessionInputAttachment,
  type SessionPlanSnapshot,
  type SessionRecoverySnapshot,
  type SessionToolCallDetail,
  type SocketEvent,
  type SessionTimelineSnapshot,
  type SessionTimelineView,
  type WebPushPublicConfig,
  type WebPushSubscriptionResponse,
  type WebPushTestResponse,
  type WebPushSubscriptionUpsertRequest,
  type WorkspaceDirectorySnapshot,
  type WorkspaceSessionBucket,
  type WorkspaceSessionDetailResponse,
  type WorkspaceSessionPage,
} from '@panda/protocol'

const toWsUrl = (baseUrl: string) => {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  return url.toString()
}

export class PandaClient {
  getConnectionKey() {
    return `${this.baseUrl}::${this.wsBaseUrl}`
  }

  constructor(
    private readonly baseUrl: string,
    private readonly wsBaseUrl: string = toWsUrl(baseUrl),
  ) {}

  private async readJson<T>(input: URL | string, schema: { parse: (value: unknown) => T }) {
    const response = await fetch(input)
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`)
    }

    return schema.parse(await response.json())
  }

  private async postJson<T>(
    pathname: string,
    body: unknown,
    schema?: { parse: (value: unknown) => T },
  ): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const json = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error((json as { error?: string } | null)?.error ?? `Request failed with ${response.status}`)
    }

    return schema ? schema.parse(json) : (json as T)
  }

  async getPhaseOneSnapshot(options?: {
    fallbackToMock?: boolean
    fallbackSnapshot?: () => PhaseOneSnapshot
  }): Promise<PhaseOneSnapshot> {
    const {
      fallbackToMock = true,
      fallbackSnapshot = createMockPhaseOneSnapshot,
    } = options ?? {}

    try {
      const response = await fetch(new URL('/api/bootstrap', this.baseUrl))
      if (!response.ok) {
        throw new Error(`Bootstrap request failed with ${response.status}`)
      }

      const json = await response.json()
      return phaseOneSnapshotSchema.parse(json)
    } catch (error) {
      if (!fallbackToMock) {
        throw error
      }

      return fallbackSnapshot()
    }
  }

  async getHubDirectory(): Promise<HubDirectorySnapshot> {
    return this.readJson(
      new URL('/api/hub/directory', this.baseUrl),
      hubDirectorySnapshotSchema,
    )
  }

  async getHubRecentSessions(): Promise<HubRecentSessionsSnapshot> {
    return this.readJson(
      new URL('/api/hub/recent-sessions', this.baseUrl),
      hubRecentSessionsSnapshotSchema,
    )
  }

  async getSessionLocation(sessionId: string): Promise<SessionLocation> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/location`, this.baseUrl),
      sessionLocationSchema,
    )
  }

  async getWorkspaceDirectory(options?: {
    selectedSessionId?: string | null
  }): Promise<WorkspaceDirectorySnapshot> {
    const url = new URL('/api/workspace', this.baseUrl)
    if (options?.selectedSessionId) {
      url.searchParams.set('selectedSessionId', options.selectedSessionId)
    }

    return this.readJson(url, workspaceDirectorySnapshotSchema)
  }

  async getWorkspaceSessionPage(input: {
    bucket: WorkspaceSessionBucket
    projectId?: string | null
    cursor?: string | null
    limit?: number
    selectedSessionId?: string | null
  }): Promise<WorkspaceSessionPage> {
    const url = new URL('/api/workspace/sessions', this.baseUrl)
    url.searchParams.set('bucket', workspaceSessionBucketSchema.parse(input.bucket))
    if (input.projectId) {
      url.searchParams.set('projectId', input.projectId)
    }
    if (input.cursor) {
      url.searchParams.set('cursor', input.cursor)
    }
    if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
      url.searchParams.set('limit', String(Math.max(1, Math.floor(input.limit))))
    }
    if (input.selectedSessionId) {
      url.searchParams.set('selectedSessionId', input.selectedSessionId)
    }

    return this.readJson(url, workspaceSessionPageSchema)
  }

  async getWorkspaceSessionDetail(sessionId: string): Promise<WorkspaceSessionDetailResponse> {
    const url = new URL('/api/workspace/session-detail', this.baseUrl)
    url.searchParams.set('sessionId', sessionId)
    return this.readJson(url, workspaceSessionDetailResponseSchema)
  }

  async getSessionTimeline(
    sessionId: string,
    options?: {
      view?: SessionTimelineView
    },
  ): Promise<SessionTimelineSnapshot> {
    const url = new URL(`/api/sessions/${sessionId}/timeline`, this.baseUrl)
    if (options?.view) {
      url.searchParams.set('view', options.view)
    }

    return this.readJson(url, sessionTimelineSnapshotSchema)
  }

  async getSessionChangeSets(sessionId: string): Promise<ChangeSetSummary[]> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/change-sets`, this.baseUrl),
      {
        parse: (value: unknown) =>
          Array.isArray(value)
            ? value.map((entry) => changeSetSummarySchema.parse(entry))
            : [],
      },
    )
  }

  async getSessionBootstrap(sessionId: string): Promise<SessionBootstrapSnapshot> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/bootstrap`, this.baseUrl),
      sessionBootstrapSnapshotSchema,
    )
  }

  async getSessionToolCallDetail(
    sessionId: string,
    entryId: string,
  ): Promise<SessionToolCallDetail> {
    const url = new URL(`/api/sessions/${sessionId}/tool-detail`, this.baseUrl)
    url.searchParams.set('entryId', entryId)
    return this.readJson(url, sessionToolCallDetailSchema)
  }

  async getSessionChangeSetFileDiff(
    sessionId: string,
    input: {
      changeSetId: string
      path: string
      itemId?: string | null
    },
  ): Promise<SessionChangeSetFileDiff> {
    const url = new URL(`/api/sessions/${sessionId}/change-set-file-diff`, this.baseUrl)
    url.searchParams.set('changeSetId', input.changeSetId)
    url.searchParams.set('path', input.path)
    if (input.itemId) {
      url.searchParams.set('itemId', input.itemId)
    }

    return this.readJson(url, sessionChangeSetFileDiffSchema)
  }

  async getSessionGitWorkspace(sessionId: string): Promise<SessionGitWorkspace> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/git-workspace`, this.baseUrl),
      sessionGitWorkspaceSchema,
    )
  }

  async getSessionGitWorkspaceFileDiff(
    sessionId: string,
    options: {
      path: string
      previousPath?: string | null
    },
  ): Promise<SessionGitWorkspaceFileDiff> {
    const url = new URL(`/api/sessions/${sessionId}/git-workspace/file-diff`, this.baseUrl)
    url.searchParams.set('path', options.path)
    if (options.previousPath) {
      url.searchParams.set('previousPath', options.previousPath)
    }

    return this.readJson(url, sessionGitWorkspaceFileDiffSchema)
  }

  async getSessionGitHistory(sessionId: string): Promise<SessionGitHistory> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/git/history`, this.baseUrl),
      sessionGitHistorySchema,
    )
  }

  async getSessionFilePreviewTree(
    sessionId: string,
    options?: {
      path?: string | null
    },
  ): Promise<SessionFilePreviewTreeResponse> {
    const url = new URL(`/api/sessions/${sessionId}/file-preview/tree`, this.baseUrl)
    const nextPath = options?.path?.trim()
    if (nextPath) {
      url.searchParams.set('path', nextPath)
    }

    return this.readJson(url, sessionFilePreviewTreeResponseSchema)
  }

  async getSessionFilePreviewContent(
    sessionId: string,
    options: {
      path: string
    },
  ): Promise<SessionFilePreviewContentResponse> {
    const url = new URL(`/api/sessions/${sessionId}/file-preview/content`, this.baseUrl)
    url.searchParams.set('path', options.path)

    return this.readJson(url, sessionFilePreviewContentResponseSchema)
  }

  async getSessionGitHistoryFileDiff(
    sessionId: string,
    options: {
      commitOid: string
      path: string
      previousPath?: string | null
    },
  ): Promise<SessionGitHistoryFileDiff> {
    const url = new URL(`/api/sessions/${sessionId}/git/history/file-diff`, this.baseUrl)
    url.searchParams.set('commitOid', options.commitOid)
    url.searchParams.set('path', options.path)
    if (options.previousPath) {
      url.searchParams.set('previousPath', options.previousPath)
    }

    return this.readJson(url, sessionGitHistoryFileDiffSchema)
  }

  async getSessionRunWorkbench(sessionId: string): Promise<SessionRunWorkbench> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/run-workbench`, this.baseUrl),
      sessionRunWorkbenchSchema,
    )
  }

  async saveSessionRunCommand(input: {
    sessionId: string
    action: 'create' | 'update' | 'delete'
    commandId?: string
    command?: SessionRunCommandDraft
  }): Promise<SessionRunCommandCatalogResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/run-commands`,
      {
        action: input.action,
        commandId: input.commandId ?? null,
        command: input.command ?? null,
      },
      sessionRunCommandCatalogResponseSchema,
    )
  }

  async generateSessionRunCommand(input: {
    sessionId: string
    prompt: string
    model?: string | null
  }): Promise<SessionRunCommandGenerationResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/run-commands/generate`,
      {
        prompt: input.prompt,
        model: input.model,
      },
      sessionRunCommandGenerationResponseSchema,
    )
  }

  async saveSessionRunWebsite(input: {
    sessionId: string
    action: 'create' | 'update' | 'delete'
    websiteId?: string
    website?: SessionRunWebsiteDraft
  }): Promise<SessionRunWebsiteCatalogResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/run-websites`,
      {
        action: input.action,
        websiteId: input.websiteId ?? null,
        website: input.website ?? null,
      },
      sessionRunWebsiteCatalogResponseSchema,
    )
  }

  async generateSessionRunWebsite(input: {
    sessionId: string
    prompt: string
    model?: string | null
  }): Promise<SessionRunWebsiteGenerationResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/run-websites/generate`,
      {
        prompt: input.prompt,
        model: input.model,
      },
      sessionRunWebsiteGenerationResponseSchema,
    )
  }

  async executeSessionTerminalAction(input: {
    sessionId: string
    action: 'run-command' | 'run-kill-command' | 'stop' | 'close' | 'focus'
    commandId?: string
    terminalId?: string
  }): Promise<SessionTerminalActionResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/terminals`,
      {
        action: input.action,
        commandId: input.commandId ?? null,
        terminalId: input.terminalId ?? null,
      },
      sessionTerminalActionResponseSchema,
    )
  }

  async getSessionTerminalOutput(input: {
    sessionId: string
    terminalId: string
    cursor?: number
  }): Promise<SessionTerminalOutput> {
    const url = new URL(
      `/api/sessions/${input.sessionId}/terminals/${input.terminalId}/output`,
      this.baseUrl,
    )
    if (typeof input.cursor === 'number' && Number.isFinite(input.cursor)) {
      url.searchParams.set('cursor', String(Math.max(0, Math.floor(input.cursor))))
    }

    return this.readJson(url, sessionTerminalOutputSchema)
  }

  async getSessionPlan(sessionId: string): Promise<SessionPlanSnapshot | null> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/plan`, this.baseUrl),
      {
        parse: (value: unknown) =>
          value == null ? null : sessionPlanSnapshotSchema.parse(value),
      },
    )
  }

  async getSessionInteractions(sessionId: string): Promise<SessionInteractionRequest[]> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/interactions`, this.baseUrl),
      {
        parse: (value: unknown) =>
          Array.isArray(value)
            ? value.map((entry) => sessionInteractionRequestSchema.parse(entry))
            : [],
      },
    )
  }

  async getSessionRecoverySnapshot(sessionId: string): Promise<SessionRecoverySnapshot> {
    return this.readJson(
      new URL(`/api/sessions/${sessionId}/recovery`, this.baseUrl),
      sessionRecoverySnapshotSchema,
    )
  }

  async getProjectSkills(projectId: string): Promise<ProjectSkill[]> {
    return this.readJson(
      new URL(`/api/projects/${projectId}/skills`, this.baseUrl),
      {
        parse: (value: unknown) =>
          Array.isArray(value)
            ? value.map((entry) => projectSkillSchema.parse(entry))
            : [],
      },
    )
  }

  async getCodexCommands(): Promise<CodexCommandCatalog> {
    return this.readJson(
      new URL('/api/codex/commands', this.baseUrl),
      codexCommandCatalogSchema,
    )
  }

  async refreshCodexCommands(): Promise<CodexCommandCatalog> {
    return this.postJson(
      '/api/codex/commands/refresh',
      {},
      codexCommandCatalogSchema,
    )
  }

  async listDirectories(input: { agentId?: string; path?: string | null }): Promise<DirectoryNode[]> {
    const url = new URL('/api/directories', this.baseUrl)
    if (input.agentId) {
      url.searchParams.set('agentId', input.agentId)
    }
    if (input.path) {
      url.searchParams.set('path', input.path)
    }

    return this.readJson(url, {
      parse: (value: unknown) =>
        Array.isArray(value)
          ? value.map((entry) => directoryNodeSchema.parse(entry))
          : [],
    })
  }

  async createDirectory(input: {
    agentId?: string
    parentPath: string
    name: string
  }): Promise<CreateDirectoryResponse> {
    return this.postJson('/api/directories', input, createDirectoryResponseSchema)
  }

  async createProject(input: { agentId?: string; name: string; path: string }) {
    return this.postJson('/api/projects', input)
  }

  async createSession(input: {
    agentId?: string
    projectId: string
    title: string
    input?: string
    attachments?: SessionInputAttachment[]
    model?: string
    titleGenerationModel?: string
    reasoningEffort?: string
    serviceTier?: 'fast'
    planMode?: boolean
    yoloMode?: boolean
  }) {
    return this.postJson('/api/sessions', {
      ...input,
      attachments: input.attachments?.map((attachment) =>
        sessionInputAttachmentSchema.parse(attachment),
      ),
      serviceTier: input.serviceTier,
      planMode: input.planMode,
      yoloMode: input.yoloMode,
    })
  }

  async updateSession(input: {
    sessionId: string
    action: 'pin' | 'unpin' | 'archive' | 'delete' | 'rename'
    name?: string
  }) {
    return this.postJson(`/api/sessions/${input.sessionId}/actions`, {
      action: input.action,
      name: input.name,
    })
  }

  async updateThread(input: {
    projectId: string
    action: 'pin' | 'unpin' | 'rename' | 'remove' | 'archive' | 'unarchive' | 'reorder'
    name?: string
    orderedProjectIds?: string[]
  }) {
    return this.postJson(`/api/threads/${input.projectId}/actions`, {
      action: input.action,
      name: input.name,
      orderedProjectIds: input.orderedProjectIds,
    })
  }

  async sendSessionInput(input: {
    sessionId: string
    input: string
    attachments?: SessionInputAttachment[]
    model?: string
    reasoningEffort?: string
    serviceTier?: 'fast'
    planMode?: boolean
    yoloMode?: boolean
  }) {
    return this.postJson(`/api/sessions/${input.sessionId}/input`, {
      input: input.input,
      attachments: input.attachments?.map((attachment) =>
        sessionInputAttachmentSchema.parse(attachment),
      ),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      planMode: input.planMode,
      yoloMode: input.yoloMode,
    })
  }

  async executeSessionCommand(input: {
    sessionId: string
    input: string
  }): Promise<CodexCommandPanelResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/commands/execute`,
      {
        input: input.input,
      },
      codexCommandPanelResponseSchema,
    )
  }

  async respondToSessionCommand(input: {
    sessionId: string
    panelId: string
    optionId?: string | null
    text?: string | null
  }): Promise<CodexCommandPanelResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/commands/respond`,
      {
        panelId: input.panelId,
        optionId: input.optionId ?? null,
        text: input.text ?? null,
      },
      codexCommandPanelResponseSchema,
    )
  }

  async respondToSessionInteraction(input: {
    sessionId: string
    requestId: string
    optionId?: string | null
    text?: string | null
    answers?: Record<string, string>
  }) {
    return this.postJson(
      `/api/sessions/${input.sessionId}/interactions/${input.requestId}/respond`,
      {
        optionId: input.optionId ?? null,
        text: input.text ?? null,
        answers: input.answers ?? null,
      },
    )
  }

  async interruptSession(sessionId: string) {
    return this.postJson(`/api/sessions/${sessionId}/interrupt`, {})
  }

  async registerAgent(snapshot: unknown): Promise<AgentRegistrationResponse> {
    return this.postJson(
      '/api/agents/register',
      snapshot,
      agentRegistrationResponseSchema,
    )
  }

  async heartbeatAgent(snapshot: unknown): Promise<AgentRegistrationResponse> {
    return this.postJson(
      '/api/agents/heartbeat',
      snapshot,
      agentRegistrationResponseSchema,
    )
  }

  async updateAgent(input: {
    agentId: string
    action: AgentAction
    displayName?: string | null
  }): Promise<AgentActionResponse> {
    return this.postJson(
      `/api/agents/${input.agentId}/actions`,
      {
        action: input.action,
        display_name: input.displayName ?? null,
      },
      agentActionResponseSchema,
    )
  }

  async getWebPushPublicConfig(): Promise<WebPushPublicConfig> {
    return this.readJson(
      new URL('/api/push/public-key', this.baseUrl),
      webPushPublicConfigSchema,
    )
  }

  async upsertWebPushSubscription(
    input: WebPushSubscriptionUpsertRequest,
  ): Promise<WebPushSubscriptionResponse> {
    return this.postJson(
      '/api/push/subscriptions',
      {
        subscription: input.subscription,
        settings: webPushSubscriptionSettingsSchema.parse(input.settings),
        device: input.device ?? null,
      },
      webPushSubscriptionResponseSchema,
    )
  }

  async removeWebPushSubscription(input: {
    endpoint: string
  }): Promise<{ ok: true }> {
    return this.postJson(
      '/api/push/subscriptions/remove',
      webPushSubscriptionRemoveRequestSchema.parse(input),
    )
  }

  async sendWebPushTest(input: {
    endpoint: string
  }): Promise<WebPushTestResponse> {
    return this.postJson(
      '/api/push/test',
      webPushTestRequestSchema.parse(input),
      webPushTestResponseSchema,
    )
  }

  async executeSessionGitAction(input: {
    sessionId: string
    action: 'discard-file' | 'discard-all' | 'commit-all' | 'switch-branch' | 'push'
    path?: string
    branch?: string
    message?: string
  }): Promise<SessionGitActionResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/git/actions`,
      {
        action: input.action,
        path: input.path,
        branch: input.branch,
        message: input.message,
      },
      sessionGitActionResponseSchema,
    )
  }

  async executeSessionTurnAction(input: {
    sessionId: string
    turnId: string
    action: 'rollback'
  }): Promise<SessionTurnActionResponse> {
    return this.postJson(
      `/api/sessions/${input.sessionId}/turns/${input.turnId}/actions`,
      {
        action: input.action,
      },
      sessionTurnActionResponseSchema,
    )
  }

  async getDevManagerSnapshot(options?: {
    includeServiceProbe?: boolean
  }): Promise<DevManagerSnapshot> {
    const url = new URL('/api/dev-manager', this.baseUrl)
    if (options?.includeServiceProbe) {
      url.searchParams.set('includeServiceProbe', '1')
    }
    return this.readJson(
      url,
      devManagerSnapshotSchema,
    )
  }

  async saveDevManagerConfig(
    input: DevManagerConfigUpdate,
  ): Promise<DevManagerSnapshot> {
    return this.postJson(
      '/api/dev-manager/config',
      devManagerConfigUpdateSchema.parse(input),
      devManagerSnapshotSchema,
    )
  }

  async executeDevManagerAction(input: {
    action:
      | 'start-development'
      | 'restart-development'
      | 'stop-development'
      | 'probe-development'
      | 'publish-npm'
      | 'install-release-services'
      | 'uninstall-release-services'
      | 'install-latest-release-package'
      | 'restart-release-services'
      | 'install-latest-release'
      | 'build-apk'
  }): Promise<DevManagerActionResponse> {
    return this.postJson(
      '/api/dev-manager/actions',
      input,
      devManagerActionResponseSchema,
    )
  }

  createEventStream(
    onEvent: (event: SocketEvent) => void,
    options?: {
      sessionId?: string
      reconnectWhenHidden?: boolean
      onStatus?: (status: {
        state: 'connected' | 'reconnecting' | 'failed'
        attempt: number
        maxAttempts: number
        error?: string
      }) => void
    },
  ): {
    setSessionId: (sessionId?: string | null) => void
    close: () => void
  } {
    const maxAttempts = 5
    const reconnectBaseDelayMs = 1200
    const reconnectMaxDelayMs = 10_000
    const foregroundRecoveryThrottleMs = 1_500
    let socket: WebSocket | null = null
    let desiredSessionId = options?.sessionId?.trim() ?? ''
    let subscribedSessionId = ''
    let closedByClient = false
    let reconnectAttempt = 0
    let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null
    let reconnectPending = false
    let foregroundRecoveryPending = false
    let waitingForForeground = false
    let lastForegroundRecoveryAt = 0

    const hasDocumentVisibilityApi =
      typeof document !== 'undefined' &&
      typeof document.visibilityState === 'string'

    const isDocumentHidden = () =>
      hasDocumentVisibilityApi && document.visibilityState === 'hidden'
    const reconnectWhenHidden = options?.reconnectWhenHidden === true

    const isSocketHealthy = (target: WebSocket | null) =>
      target?.readyState === WebSocket.OPEN ||
      target?.readyState === WebSocket.CONNECTING

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        globalThis.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const emitStatus = (
      state: 'connected' | 'reconnecting' | 'failed',
      error?: string,
    ) => {
      options?.onStatus?.({
        state,
        attempt: reconnectAttempt,
        maxAttempts,
        error,
      })
    }

    const sendSessionSubscription = (nextSessionId: string) => {
      const activeSocket = socket
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
        return
      }

      if (subscribedSessionId && subscribedSessionId !== nextSessionId) {
        activeSocket.send(
          JSON.stringify({
            type: 'session.unsubscribe',
            sessionId: subscribedSessionId,
          }),
        )
        subscribedSessionId = ''
      }

      if (!nextSessionId || subscribedSessionId === nextSessionId) {
        return
      }

      subscribedSessionId = nextSessionId
      activeSocket.send(
        JSON.stringify({
          type: 'session.subscribe',
          sessionId: nextSessionId,
        }),
      )
    }

    const scheduleReconnect = (error?: string) => {
      if (closedByClient) {
        return
      }

      if (reconnectPending) {
        return
      }

      if (!reconnectWhenHidden && isDocumentHidden()) {
        reconnectPending = false
        waitingForForeground = true
        clearReconnectTimer()
        emitStatus('failed', error)
        return
      }

      reconnectAttempt += 1
      if (!reconnectWhenHidden && reconnectAttempt > maxAttempts) {
        reconnectAttempt = maxAttempts
        waitingForForeground = true
        emitStatus('failed', error)
        return
      }

      reconnectPending = true
      waitingForForeground = false
      emitStatus('reconnecting', error)
      clearReconnectTimer()
      const reconnectAttemptForDelay = reconnectWhenHidden
        ? Math.min(reconnectAttempt, maxAttempts)
        : reconnectAttempt
      const reconnectDelayMs = Math.min(
        reconnectMaxDelayMs,
        reconnectBaseDelayMs * 2 ** Math.max(0, reconnectAttemptForDelay - 1),
      )
      reconnectTimer = globalThis.setTimeout(() => {
        reconnectPending = false
        connect()
      }, reconnectDelayMs)
    }

    const connect = () => {
      if (closedByClient || isSocketHealthy(socket)) {
        return
      }

      clearReconnectTimer()
      reconnectPending = false
      waitingForForeground = false
      const nextSocket = new WebSocket(this.wsBaseUrl)
      socket = nextSocket

      nextSocket.addEventListener('open', () => {
        if (closedByClient || socket !== nextSocket) {
          return
        }

        reconnectPending = false
        foregroundRecoveryPending = false
        reconnectAttempt = 0
        emitStatus('connected')
        sendSessionSubscription(desiredSessionId)
      })

      nextSocket.addEventListener('message', (message) => {
        if (socket !== nextSocket) {
          return
        }

        const parsed = socketEventSchema.safeParse(
          JSON.parse(message.data as string),
        )
        if (parsed.success) {
          onEvent(parsed.data)
        }
      })

      nextSocket.addEventListener('error', () => {
        if (closedByClient || socket !== nextSocket) {
          return
        }

        const errorMessage = `无法连接到 ${this.wsBaseUrl}`
        if (nextSocket.readyState !== WebSocket.OPEN) {
          scheduleReconnect(errorMessage)
        }
      })

      nextSocket.addEventListener('close', (event) => {
        if (socket === nextSocket) {
          socket = null
        }

        if (closedByClient || socket !== null) {
          return
        }

        const errorMessage =
          event.reason?.trim() ||
          `WebSocket 已断开（code ${event.code || 'unknown'}）`
        scheduleReconnect(errorMessage)
      })
    }

    const requestForegroundRecovery = (error?: string) => {
      if (closedByClient || isSocketHealthy(socket) || foregroundRecoveryPending) {
        return
      }

      const now = Date.now()
      if (now - lastForegroundRecoveryAt < foregroundRecoveryThrottleMs) {
        return
      }

      lastForegroundRecoveryAt = now
      foregroundRecoveryPending = true
      reconnectAttempt = 0
      reconnectPending = false
      waitingForForeground = false
      clearReconnectTimer()
      emitStatus('reconnecting', error)
      connect()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return
      }

      if (waitingForForeground || !isSocketHealthy(socket)) {
        requestForegroundRecovery('应用回到前台，正在恢复连接')
      }
    }

    const handlePageShow = () => {
      if (waitingForForeground || !isSocketHealthy(socket)) {
        requestForegroundRecovery('页面恢复显示，正在恢复连接')
      }
    }

    const handleWindowFocus = () => {
      if (waitingForForeground || !isSocketHealthy(socket)) {
        requestForegroundRecovery('窗口重新聚焦，正在恢复连接')
      }
    }

    const handleOnline = () => {
      if (waitingForForeground || !isSocketHealthy(socket)) {
        requestForegroundRecovery('网络已恢复，正在重新连接')
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', handlePageShow)
      window.addEventListener('focus', handleWindowFocus)
      window.addEventListener('online', handleOnline)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    connect()

    return {
      setSessionId: (sessionId) => {
        desiredSessionId = sessionId?.trim() ?? ''

        if (closedByClient) {
          return
        }

        sendSessionSubscription(desiredSessionId)
      },
      close: () => {
        closedByClient = true
        reconnectPending = false
        foregroundRecoveryPending = false
        waitingForForeground = false
        clearReconnectTimer()
        if (typeof window !== 'undefined') {
          window.removeEventListener('pageshow', handlePageShow)
          window.removeEventListener('focus', handleWindowFocus)
          window.removeEventListener('online', handleOnline)
        }
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', handleVisibilityChange)
        }

        const socketToClose = socket
        if (socketToClose?.readyState === WebSocket.OPEN && subscribedSessionId) {
          socketToClose.send(
            JSON.stringify({
              type: 'session.unsubscribe',
              sessionId: subscribedSessionId,
            }),
          )
        }
        subscribedSessionId = ''
        socket = null

        if (socketToClose?.readyState === WebSocket.CONNECTING) {
          const closePendingSocket = () => {
            try {
              socketToClose.close()
            } catch {
              // Ignore best-effort shutdown failures during teardown.
            }
          }
          socketToClose.addEventListener('open', closePendingSocket, { once: true })
          return
        }

        socketToClose?.close()
      },
    }
  }

  connectEvents(
    onEvent: (event: SocketEvent) => void,
    options?: {
      sessionId?: string
      reconnectWhenHidden?: boolean
      onStatus?: (status: {
        state: 'connected' | 'reconnecting' | 'failed'
        attempt: number
        maxAttempts: number
        error?: string
      }) => void
    },
  ): () => void {
    const stream = this.createEventStream(onEvent, options)
    return () => {
      stream.close()
    }
  }
}

export const createClient = (
  baseUrl: string,
  options?: { wsBaseUrl?: string },
) =>
  new PandaClient(
    baseUrl,
    options?.wsBaseUrl ?? toWsUrl(baseUrl),
  )
