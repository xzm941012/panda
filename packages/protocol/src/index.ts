import { z } from 'zod'

export const providerKindSchema = z.enum(['codex', 'claude'])
export const sessionModeSchema = z.enum(['managed', 'attached-live', 'history-only'])
export const sessionHealthSchema = z.enum(['active', 'idle', 'attention', 'offline'])
export const sessionRunStateSchema = z.enum(['idle', 'running', 'completed'])
export const attachmentKindSchema = z.enum(['image', 'file'])
export const skillScopeSchema = z.enum(['user', 'repo', 'system', 'admin'])

export const sessionCapabilitySchema = z.object({
  can_stream_live: z.boolean(),
  can_send_input: z.boolean(),
  can_interrupt: z.boolean(),
  can_approve: z.boolean(),
  can_reject: z.boolean(),
  can_show_git: z.boolean(),
  can_show_terminal: z.boolean(),
})

export const sessionContextUsageSchema = z.object({
  used_tokens: z.number(),
  total_tokens: z.number(),
  remaining_tokens: z.number(),
  percent_used: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
  updated_at: z.string(),
})

export const planStepStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

export const sessionPlanStepSchema = z.object({
  id: z.string(),
  step: z.string(),
  status: planStepStatusSchema,
})

export const sessionPlanSnapshotSchema = z.object({
  session_id: z.string(),
  turn_id: z.string().nullable(),
  source: z.enum(['rollout', 'app-server']),
  updated_at: z.string(),
  explanation: z.string().nullable().default(null),
  steps: z.array(sessionPlanStepSchema),
  completed_count: z.number().int().nonnegative(),
  total_count: z.number().int().nonnegative(),
  is_active: z.boolean(),
})

export const sessionSubagentSchema = z.object({
  parent_session_id: z.string(),
  root_session_id: z.string().nullable().default(null),
  nickname: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  depth: z.number().int().nonnegative(),
})

export const sessionInteractionKindSchema = z.enum([
  'user_input',
  'command_execution_approval',
  'file_change_approval',
  'permissions_approval',
  'mcp_elicitation',
])

export const sessionInteractionStatusSchema = z.enum([
  'pending',
  'submitting',
  'resolved',
])

export const sessionInteractionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable().default(null),
  emphasis: z.enum(['default', 'primary', 'danger']).default('default'),
})

export const sessionInteractionQuestionSchema = z.object({
  id: z.string(),
  header: z.string().nullable().default(null),
  question: z.string(),
  options: z.array(sessionInteractionOptionSchema).default([]),
  allow_other: z.boolean().default(false),
  is_secret: z.boolean().default(false),
})

export const sessionInteractionRequestSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  turn_id: z.string().nullable().default(null),
  item_id: z.string().nullable().default(null),
  kind: sessionInteractionKindSchema,
  status: sessionInteractionStatusSchema,
  title: z.string(),
  description: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  options: z.array(sessionInteractionOptionSchema).default([]),
  questions: z.array(sessionInteractionQuestionSchema).default([]),
  allow_freeform: z.boolean().default(false),
  freeform_placeholder: z.string().nullable().default(null),
  submit_label: z.string().nullable().default(null),
})

export const timelineAttachmentSchema = z.object({
  id: z.string(),
  kind: attachmentKindSchema,
  name: z.string().nullable().default(null),
  mime_type: z.string().nullable().default(null),
  size_bytes: z.number().int().nonnegative().nullable().default(null),
  content_url: z.string().nullable().default(null),
})

export const sessionInputAttachmentSchema = z.object({
  id: z.string(),
  kind: attachmentKindSchema,
  name: z.string(),
  mime_type: z.string().nullable().default(null),
  size_bytes: z.number().int().nonnegative().nullable().default(null),
  data_url: z.string(),
})

export const projectSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  scope: skillScopeSchema,
  enabled: z.boolean(),
})

export const codexCommandAvailabilitySchema = z.enum(['supported', 'unsupported'])

export const codexCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  availability: codexCommandAvailabilitySchema.default('supported'),
})

export const codexCommandCatalogSchema = z.object({
  cli_version: z.string().nullable().default(null),
  loaded_at: z.string(),
  cache_ttl_ms: z.number().int().nonnegative(),
  commands: z.array(codexCommandSchema),
})

export const codexAvailableModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string().nullable().default(null),
  supportedReasoningEfforts: z.array(z.string()).default([]),
})

export const codexCommandPanelStatusSchema = z.enum([
  'running',
  'awaiting_input',
  'completed',
  'failed',
])

export const codexCommandPanelInputTypeSchema = z.enum(['none', 'choice', 'text'])

export const codexCommandPanelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable().default(null),
})

export const codexCommandPanelEffectSchema = z
  .object({
    type: z.literal('set_session_model'),
    model: z.string(),
    reasoning_effort: z.string().nullable().default(null),
  })
  .nullable()
  .default(null)

export const codexCommandPanelSchema = z.object({
  panel_id: z.string(),
  session_id: z.string(),
  command_name: z.string(),
  command_text: z.string(),
  title: z.string(),
  description: z.string().nullable().default(null),
  status: codexCommandPanelStatusSchema,
  body: z.string(),
  submitted_at: z.string(),
  updated_at: z.string(),
  input_type: codexCommandPanelInputTypeSchema,
  options: z.array(codexCommandPanelOptionSchema).default([]),
  input_placeholder: z.string().nullable().default(null),
  submit_label: z.string().nullable().default(null),
  effect: codexCommandPanelEffectSchema,
})

export const codexCommandPanelResponseSchema = z.object({
  panel: codexCommandPanelSchema,
})

export const agentStatusSchema = z.enum(['online', 'offline'])

export const agentNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string().nullable().default(null),
  host: z.string(),
  tailscale_ip: z.string().nullable().default(null),
  tailscale_dns_name: z.string().nullable().default(null),
  direct_base_url: z.string(),
  ws_base_url: z.string(),
  status: agentStatusSchema,
  provider_availability: z.array(providerKindSchema),
  project_count: z.number(),
  session_count: z.number(),
  transport: z.enum(['direct-agent', 'hub-routed']),
  version: z.string().nullable().default(null),
  registered_at: z.string().nullable().default(null),
  last_seen_at: z.string().nullable().default(null),
})

export const projectRefSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  name: z.string(),
  display_name: z.string().nullable(),
  pinned: z.boolean(),
  path: z.string(),
  branch: z.string(),
  worktree: z.string(),
  runtime_profiles: z.array(z.string()),
  preview_url: z.string().nullable(),
})

export const sessionRefSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  project_id: z.string(),
  provider: providerKindSchema,
  archived: z.boolean(),
  title: z.string(),
  mode: sessionModeSchema,
  health: sessionHealthSchema,
  branch: z.string(),
  worktree: z.string(),
  summary: z.string(),
  latest_assistant_message: z.string().nullable().default(null),
  last_event_at: z.string(),
  pinned: z.boolean(),
  run_state: sessionRunStateSchema,
  run_state_changed_at: z.string().nullable(),
  context_usage: sessionContextUsageSchema.nullable().default(null),
  subagent: sessionSubagentSchema.nullable().default(null),
  capability: sessionCapabilitySchema,
})

export const timelinePatchFileSummarySchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
})

export const timelinePatchSummarySchema = z.object({
  files: z.array(timelinePatchFileSummarySchema),
  additions: z.number(),
  deletions: z.number(),
})

export const timelineEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['user', 'assistant', 'thinking', 'tool', 'system']),
  title: z.string(),
  body: z.string(),
  body_truncated: z.boolean().default(false),
  detail_available: z.boolean().default(false),
  patch_summary: timelinePatchSummarySchema.nullable().default(null),
  session_ids: z.array(z.string()).default([]),
  timestamp: z.string(),
  accent: z.enum(['primary', 'secondary', 'muted']),
  attachments: z.array(timelineAttachmentSchema).default([]),
})

export const sessionTimelineViewSchema = z.enum(['tail', 'full_compact'])

export const sessionTimelineSnapshotSchema = z.object({
  session_id: z.string(),
  generated_at: z.string(),
  view: sessionTimelineViewSchema,
  anchor_entry_id: z.string().nullable().default(null),
  has_earlier_entries: z.boolean().default(false),
  entries: z.array(timelineEntrySchema),
})

export const changeSetSourceSchema = z.enum(['app-server', 'rollout-fallback'])
export const changeSetStatusSchema = z.enum(['running', 'completed'])
export const changeFileKindSchema = z.enum(['add', 'delete', 'update'])

export const changeFileSchema = z.object({
  path: z.string(),
  kind: changeFileKindSchema,
  move_path: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  diff: z.string(),
  item_id: z.string().nullable(),
})

export const changeFileSummarySchema = changeFileSchema.omit({
  diff: true,
}).extend({
  diff_available: z.boolean().default(false),
})

export const changeSetSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  turn_id: z.string(),
  source: changeSetSourceSchema,
  status: changeSetStatusSchema,
  started_at: z.string(),
  completed_at: z.string().nullable(),
  updated_at: z.string(),
  aggregated_diff: z.string(),
  files: z.array(changeFileSchema),
})

export const changeSetSummarySchema = changeSetSchema.omit({
  aggregated_diff: true,
  files: true,
}).extend({
  aggregated_diff_available: z.boolean().default(false),
  files: z.array(changeFileSummarySchema),
})

export const sessionChangeSetFileDiffSchema = z.object({
  session_id: z.string(),
  change_set_id: z.string(),
  file: changeFileSchema,
  empty_message: z.string().default('此变更没有可展示的补丁内容'),
})

export const gitFileSchema = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed']),
  additions: z.number(),
  deletions: z.number(),
})

export const sessionGitFileStatusSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
])

export const sessionGitWorkspaceFileSchema = z.object({
  path: z.string(),
  previous_path: z.string().nullable().default(null),
  status: sessionGitFileStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
})

export const sessionGitWorkspaceFileDiffSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  path: z.string(),
  previous_path: z.string().nullable().default(null),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diff: z.string(),
})

export const sessionGitWorkspaceSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  branch: z.string(),
  branches: z.array(z.string()),
  upstream_branch: z.string().nullable().default(null),
  ahead_count: z.number().int().nonnegative(),
  behind_count: z.number().int().nonnegative(),
  files: z.array(sessionGitWorkspaceFileSchema),
  updated_at: z.string(),
})

export const sessionGitHistoryCommitFileSchema = z.object({
  path: z.string(),
  previous_path: z.string().nullable().default(null),
  status: sessionGitFileStatusSchema,
})

export const sessionGitHistoryCommitSchema = z.object({
  oid: z.string(),
  short_oid: z.string(),
  subject: z.string(),
  author_name: z.string(),
  authored_at: z.string(),
  committed_at: z.string(),
  parent_oids: z.array(z.string()).default([]),
  refs: z.array(z.string()).default([]),
  files: z.array(sessionGitHistoryCommitFileSchema),
})

export const sessionGitHistoryFileDiffSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  commit_oid: z.string(),
  path: z.string(),
  previous_path: z.string().nullable().default(null),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  diff: z.string(),
})

export const sessionGitHistorySchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  branch: z.string(),
  upstream_branch: z.string().nullable().default(null),
  head_oid: z.string().nullable().default(null),
  upstream_head_oid: z.string().nullable().default(null),
  commits: z.array(sessionGitHistoryCommitSchema),
  updated_at: z.string(),
})

export const sessionGitActionSchema = z.enum([
  'discard-file',
  'discard-all',
  'commit-all',
  'switch-branch',
  'push',
])

export const sessionGitActionResponseSchema = z.object({
  ok: z.literal(true),
  workspace: sessionGitWorkspaceSchema,
})

export const sessionTurnActionSchema = z.enum([
  'rollback',
])

export const sessionTurnActionResponseSchema = z.object({
  ok: z.literal(true),
  turn_id: z.string(),
  change_set_id: z.string(),
  workspace: sessionGitWorkspaceSchema,
})

export const sessionFilePreviewNodeKindSchema = z.enum([
  'directory',
  'file',
])

export const sessionFilePreviewFileKindSchema = z.enum([
  'markdown',
  'code',
  'text',
  'image',
  'binary',
])

export const sessionFilePreviewTreeNodeSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: sessionFilePreviewNodeKindSchema,
  has_children: z.boolean(),
  extension: z.string().nullable().default(null),
  file_kind: sessionFilePreviewFileKindSchema.nullable().default(null),
  size_bytes: z.number().int().nonnegative().nullable().default(null),
})

export const sessionFilePreviewTreeResponseSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  root_path: z.string(),
  parent_path: z.string().nullable().default(null),
  nodes: z.array(sessionFilePreviewTreeNodeSchema),
  loaded_at: z.string(),
})

export const sessionFilePreviewContentResponseSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  path: z.string(),
  name: z.string(),
  extension: z.string().nullable().default(null),
  file_kind: sessionFilePreviewFileKindSchema,
  mime_type: z.string().nullable().default(null),
  size_bytes: z.number().int().nonnegative().nullable().default(null),
  encoding: z.enum(['utf8', 'base64']).nullable().default(null),
  is_truncated: z.boolean(),
  content_text: z.string().nullable().default(null),
  content_base64: z.string().nullable().default(null),
  loaded_at: z.string(),
})

export const sessionRunCommandShellSchema = z.enum([
  'auto',
  'powershell',
  'cmd',
  'bash',
])

export const sessionRunCommandSourceSchema = z.enum([
  'user',
  'codex',
])

export const sessionRunCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  command: z.string(),
  kill_command: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  shell: sessionRunCommandShellSchema.default('auto'),
  node_version: z.string().nullable().default(null),
  port: z.number().int().positive().nullable().default(null),
  source: sessionRunCommandSourceSchema.default('user'),
  created_at: z.string(),
  updated_at: z.string(),
})

export const sessionRunCommandDraftSchema = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  command: z.string(),
  kill_command: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  shell: sessionRunCommandShellSchema.default('auto'),
  node_version: z.string().nullable().default(null),
  port: z.number().int().positive().nullable().default(null),
})

export const sessionRunCommandCatalogSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  config_path: z.string(),
  commands: z.array(sessionRunCommandSchema),
  updated_at: z.string(),
})

export const sessionRunWebsiteSourceSchema = z.enum([
  'user',
  'codex',
])

export const sessionRunWebsiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  url: z.string(),
  source: sessionRunWebsiteSourceSchema.default('user'),
  created_at: z.string(),
  updated_at: z.string(),
})

export const sessionRunWebsiteDraftSchema = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  url: z.string(),
})

export const sessionRunWebsiteCatalogSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  config_path: z.string(),
  websites: z.array(sessionRunWebsiteSchema),
  updated_at: z.string(),
})

export const sessionTerminalStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'stopped',
])

export const sessionTerminalOutputStreamSchema = z.enum([
  'stdout',
  'stderr',
  'system',
])

export const sessionTerminalOutputChunkSchema = z.object({
  cursor: z.number().int().nonnegative(),
  stream: sessionTerminalOutputStreamSchema,
  text: z.string(),
  timestamp: z.string(),
})

export const sessionTerminalSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  project_id: z.string(),
  command_id: z.string().nullable().default(null),
  title: z.string(),
  command: z.string(),
  cwd: z.string(),
  status: sessionTerminalStatusSchema,
  exit_code: z.number().int().nullable().default(null),
  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
  updated_at: z.string(),
  last_output_at: z.string().nullable().default(null),
  output_cursor: z.number().int().nonnegative(),
  preview: z.string().nullable().default(null),
})

export const sessionTerminalSnapshotSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  active_terminal_id: z.string().nullable().default(null),
  terminals: z.array(sessionTerminalSchema),
  updated_at: z.string(),
})

export const sessionTerminalOutputSchema = z.object({
  session_id: z.string(),
  project_id: z.string(),
  terminal: sessionTerminalSchema,
  chunks: z.array(sessionTerminalOutputChunkSchema),
  next_cursor: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
})

export const sessionRecoveryPatchSchema = z.object({
  run_state: sessionRunStateSchema.optional(),
  run_state_changed_at: z.string().nullable().optional(),
  summary: z.string().optional(),
  latest_assistant_message: z.string().nullable().optional(),
  last_event_at: z.string().optional(),
  context_usage: sessionContextUsageSchema.nullable().optional(),
})

export const sessionRecoverySnapshotSchema = z.object({
  session_id: z.string(),
  recovered_at: z.string(),
  session_patch: sessionRecoveryPatchSchema,
  timeline: z.array(timelineEntrySchema),
  interactions: z.array(sessionInteractionRequestSchema),
  plan_snapshot: sessionPlanSnapshotSchema.nullable().default(null),
  change_sets: z.array(changeSetSchema),
  terminal_snapshot: sessionTerminalSnapshotSchema.nullable().default(null),
})

export const sessionRunNodeRuntimeSchema = z.object({
  manager: z.enum(['none', 'nvm-windows']).default('none'),
  versions: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
})

export const sessionRunWorkbenchSchema = z.object({
  command_catalog: sessionRunCommandCatalogSchema,
  website_catalog: sessionRunWebsiteCatalogSchema,
  node_runtime: sessionRunNodeRuntimeSchema,
  terminal_snapshot: sessionTerminalSnapshotSchema,
})

export const sessionBootstrapSnapshotSchema = z.object({
  session_id: z.string(),
  generated_at: z.string(),
  session_patch: sessionRecoveryPatchSchema,
  timeline: sessionTimelineSnapshotSchema,
  interactions: z.array(sessionInteractionRequestSchema),
  plan_snapshot: sessionPlanSnapshotSchema.nullable().default(null),
  run_workbench: sessionRunWorkbenchSchema.nullable().default(null),
  change_sets: z.array(changeSetSummarySchema).default([]),
})

export const sessionRunCommandCatalogResponseSchema = z.object({
  catalog: sessionRunCommandCatalogSchema,
})

export const sessionRunWebsiteCatalogResponseSchema = z.object({
  catalog: sessionRunWebsiteCatalogSchema,
})

export const sessionRunCommandGenerationSchema = z.object({
  commands: z.array(sessionRunCommandDraftSchema),
  reason: z.string().nullable().default(null),
})

export const sessionRunCommandGenerationResponseSchema = z.object({
  generation: sessionRunCommandGenerationSchema,
  catalog: sessionRunCommandCatalogSchema,
})

export const sessionRunWebsiteGenerationSchema = z.object({
  websites: z.array(sessionRunWebsiteDraftSchema),
  reason: z.string().nullable().default(null),
})

export const sessionRunWebsiteGenerationResponseSchema = z.object({
  generation: sessionRunWebsiteGenerationSchema,
  catalog: sessionRunWebsiteCatalogSchema,
})

export const sessionTerminalActionResponseSchema = z.object({
  snapshot: sessionTerminalSnapshotSchema,
  terminal: sessionTerminalSchema.nullable().default(null),
})

export const devManagerServiceKeySchema = z.enum([
  'dev-hub',
  'dev-agent',
  'dev-web',
  'release-hub',
  'release-agent',
])

export const devManagerServiceStatusSchema = z.enum([
  'unknown',
  'running',
  'stopped',
  'degraded',
])

export const devManagerServiceManagerSchema = z.enum([
  'process',
  'windows-service',
])

export const devManagerServiceControllerStatusSchema = z.enum([
  'missing',
  'running',
  'stopped',
  'unknown',
])

export const devManagerJobKindSchema = z.enum([
  'dev-start',
  'dev-restart',
  'dev-stop',
  'dev-probe',
  'npm-publish',
  'release-service-install',
  'release-service-uninstall',
  'release-install-package',
  'release-restart',
  'release-install-run',
  'apk-build',
])

export const devManagerJobStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
])

export const devManagerLogLevelSchema = z.enum([
  'info',
  'success',
  'warn',
  'error',
])

export const devManagerConfigSchema = z.object({
  repo_path: z.string().nullable().default(null),
  nvm_version: z.string().nullable().default(null),
  dev_hub_port: z.number().int().positive().nullable().default(null),
  dev_hub_args: z.string().default(''),
  dev_agent_port: z.number().int().positive().nullable().default(null),
  dev_agent_hub_url: z.string().default(''),
  dev_agent_direct_base_url: z.string().default(''),
  dev_agent_ws_base_url: z.string().default(''),
  dev_agent_name: z.string().default(''),
  dev_agent_args: z.string().default(''),
  dev_web_port: z.number().int().positive().nullable().default(null),
  dev_web_hub_url: z.string().default(''),
  dev_web_args: z.string().default(''),
  release_hub_port: z.number().int().positive().nullable().default(null),
  release_hub_service_name: z.string().default('PandaHub'),
  release_hub_args: z.string().default(''),
  release_agent_port: z.number().int().positive().nullable().default(null),
  release_agent_service_name: z.string().default('PandaAgent'),
  release_agent_hub_url: z.string().default(''),
  release_agent_direct_base_url: z.string().default(''),
  release_agent_ws_base_url: z.string().default(''),
  release_agent_name: z.string().default(''),
  release_agent_args: z.string().default(''),
  updated_at: z.string().nullable().default(null),
})

export const devManagerConfigUpdateSchema = devManagerConfigSchema.extend({
  npm_token: z.string().nullable().default(null),
  clear_npm_token: z.boolean().default(false),
})

export const devManagerCredentialStateSchema = z.object({
  has_npm_token: z.boolean(),
  npm_token_hint: z.string().nullable().default(null),
})

export const devManagerServiceProbeSchema = z.object({
  checked_at: z.string(),
  url: z.string().nullable().default(null),
  ok: z.boolean(),
  status_code: z.number().int().nullable().default(null),
  duration_ms: z.number().int().nonnegative().nullable().default(null),
  message: z.string().nullable().default(null),
})

export const devManagerServiceStateSchema = z.object({
  key: devManagerServiceKeySchema,
  label: z.string(),
  status: devManagerServiceStatusSchema,
  manager: devManagerServiceManagerSchema.default('process'),
  service_name: z.string().nullable().default(null),
  service_registered: z.boolean().default(false),
  service_status: devManagerServiceControllerStatusSchema.nullable().default(null),
  configured_port: z.number().int().positive().nullable().default(null),
  detected_pids: z.array(z.number().int().positive()).default([]),
  probe: devManagerServiceProbeSchema.nullable().default(null),
})

export const devManagerJobLogEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  level: devManagerLogLevelSchema,
  message: z.string(),
})

export const devManagerJobSchema = z.object({
  id: z.string(),
  kind: devManagerJobKindSchema,
  title: z.string(),
  status: devManagerJobStatusSchema,
  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  disconnect_expected: z.boolean().default(false),
  logs: z.array(devManagerJobLogEntrySchema).default([]),
})

export const devManagerArtifactSchema = z.object({
  artifact_id: z.string(),
  file_name: z.string(),
  size_bytes: z.number().int().nonnegative(),
  built_at: z.string(),
  published_at: z.string().nullable().default(null),
  version_name: z.string().nullable().default(null),
  version_code: z.number().int().nullable().default(null),
  download_path: z.string(),
})

export const devManagerSnapshotSchema = z.object({
  generated_at: z.string(),
  config: devManagerConfigSchema,
  credentials: devManagerCredentialStateSchema,
  node_runtime: sessionRunNodeRuntimeSchema,
  services: z.array(devManagerServiceStateSchema),
  current_version: z.string().nullable().default(null),
  apk_artifact: devManagerArtifactSchema.nullable().default(null),
  jobs: z.array(devManagerJobSchema).default([]),
})

export const devManagerActionRequestSchema = z.object({
  action: z.enum([
    'start-development',
    'restart-development',
    'stop-development',
    'probe-development',
    'publish-npm',
    'install-release-services',
    'uninstall-release-services',
    'install-latest-release-package',
    'restart-release-services',
    'install-latest-release',
    'build-apk',
  ]),
})

export const devManagerActionResponseSchema = z.object({
  ok: z.literal(true),
  snapshot: devManagerSnapshotSchema,
  job: devManagerJobSchema.nullable().default(null),
})

export const runtimeProcessSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  port: z.number().nullable(),
  status: z.enum(['running', 'stopped', 'degraded']),
  log_excerpt: z.string(),
})

export const previewEndpointSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  status: z.enum(['ready', 'starting', 'stopped']),
})

export const directoryNodeSchema = z.object({
  path: z.string(),
  name: z.string(),
  has_children: z.boolean(),
})

export const createDirectoryResponseSchema = z.object({
  directory: directoryNodeSchema,
})

export const approvalRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
})

export const workspaceProjectStatsSchema = z.object({
  project_id: z.string(),
  visible_session_count: z.number().int().nonnegative(),
  archived_session_count: z.number().int().nonnegative(),
  hidden_history_count: z.number().int().nonnegative(),
})

export const workspaceProjectDirectorySchema = projectRefSchema.pick({
  id: true,
  agent_id: true,
  name: true,
  display_name: true,
  pinned: true,
  path: true,
})

export const workspaceAgentSummarySchema = agentNodeSchema.pick({
  id: true,
  name: true,
  display_name: true,
  status: true,
})

export const workspaceSessionListItemSchema = sessionRefSchema.pick({
  id: true,
  agent_id: true,
  project_id: true,
  archived: true,
  title: true,
  last_event_at: true,
  pinned: true,
  run_state: true,
  run_state_changed_at: true,
  subagent: true,
})

export const workspaceSessionDetailSchema = sessionRefSchema.pick({
  id: true,
  agent_id: true,
  project_id: true,
  archived: true,
  title: true,
  provider: true,
  mode: true,
  health: true,
  branch: true,
  worktree: true,
  summary: true,
  latest_assistant_message: true,
  last_event_at: true,
  pinned: true,
  run_state: true,
  run_state_changed_at: true,
  context_usage: true,
  subagent: true,
  capability: true,
})

export const workspaceSessionDetailResponseSchema = z.object({
  generated_at: z.string(),
  session: workspaceSessionDetailSchema,
})

export const hubDirectorySnapshotSchema = z.object({
  generated_at: z.string(),
  agents: z.array(agentNodeSchema),
})

export const hubRecentSessionSchema = sessionRefSchema.pick({
  id: true,
  title: true,
  run_state: true,
  run_state_changed_at: true,
  latest_assistant_message: true,
})

export const hubRecentSessionsSnapshotSchema = z.object({
  generated_at: z.string(),
  recent_sessions: z.array(hubRecentSessionSchema),
})

export const sessionLocationSchema = z.object({
  session_id: z.string(),
  agent_id: z.string(),
  project_id: z.string(),
  direct_base_url: z.string(),
  ws_base_url: z.string(),
})

export const workspaceDirectorySnapshotSchema = z.object({
  generated_at: z.string(),
  agent: workspaceAgentSummarySchema.nullable().default(null),
  projects: z.array(workspaceProjectDirectorySchema),
  project_stats: z.array(workspaceProjectStatsSchema).default([]),
  sessions: z.array(workspaceSessionListItemSchema),
  active_session_id: z.string(),
})

export const workspaceSessionBucketSchema = z.enum([
  'archived',
  'history',
])

export const workspaceSessionPageSchema = z.object({
  bucket: workspaceSessionBucketSchema,
  project_id: z.string().nullable().default(null),
  sessions: z.array(workspaceSessionListItemSchema),
  next_cursor: z.string().nullable().default(null),
  total_count: z.number().int().nonnegative(),
})

export const sessionToolCallDetailSchema = z.object({
  session_id: z.string(),
  entry_id: z.string(),
  command_entry: timelineEntrySchema,
  output_entries: z.array(timelineEntrySchema).default([]),
})

export const phaseOneSnapshotSchema = z.object({
  generated_at: z.string(),
  agents: z.array(agentNodeSchema),
  projects: z.array(projectRefSchema),
  sessions: z.array(sessionRefSchema),
  active_session_id: z.string(),
  timeline: z.array(timelineEntrySchema),
  changed_files: z.array(gitFileSchema),
  runtime_processes: z.array(runtimeProcessSchema),
  previews: z.array(previewEndpointSchema),
  approvals: z.array(approvalRequestSchema),
})

export const agentControlPlaneSyncSchema = z.object({
  agent: agentNodeSchema,
  projects: z.array(projectRefSchema),
  sessions: z.array(sessionRefSchema),
  active_session_id: z.string().default(''),
  generated_at: z.string(),
})

export const agentRegistrationResponseSchema = z.object({
  ok: z.literal(true),
  agent_id: z.string(),
  heartbeat_interval_ms: z.number().int().positive(),
  heartbeat_timeout_ms: z.number().int().positive(),
  registered_at: z.string(),
  received_at: z.string(),
})

export const agentActionSchema = z.enum(['rename', 'delete'])

export const agentActionRequestSchema = z.object({
  action: agentActionSchema,
  display_name: z.string().nullable().default(null),
})

export const agentActionResponseSchema = z.object({
  ok: z.literal(true),
})

export const webPushSubscriptionSettingsSchema = z.object({
  completion_notifications_enabled: z.boolean().default(false),
})

export const webPushSubscriptionKeysSchema = z.object({
  p256dh: z.string(),
  auth: z.string(),
})

export const webPushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().default(null),
  keys: webPushSubscriptionKeysSchema,
})

export const webPushDeviceSchema = z.object({
  label: z.string().nullable().default(null),
  user_agent: z.string().nullable().default(null),
})

export const webPushSubscriptionUpsertRequestSchema = z.object({
  subscription: webPushSubscriptionSchema,
  settings: webPushSubscriptionSettingsSchema.default({}),
  device: webPushDeviceSchema.default({}),
})

export const webPushSubscriptionRemoveRequestSchema = z.object({
  endpoint: z.string().url(),
})

export const webPushTestRequestSchema = z.object({
  endpoint: z.string().url(),
})

export const webPushPublicConfigSchema = z.object({
  supported: z.boolean(),
  vapid_public_key: z.string().nullable().default(null),
  subject: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
})

export const webPushSubscriptionResponseSchema = z.object({
  ok: z.literal(true),
  subscription_id: z.string(),
  endpoint: z.string().url(),
  settings: webPushSubscriptionSettingsSchema,
  created_at: z.string(),
  updated_at: z.string(),
})

export const webPushTestResponseSchema = z.object({
  ok: z.literal(true),
  endpoint: z.string().url(),
  delivered_at: z.string(),
})

export const socketEventSchema = z.object({
  type: z.enum([
    'agent.online',
    'agent.offline',
    'snapshot.changed',
    'session.updated',
    'thread.updated',
    'timeline.delta',
    'timeline.reset',
    'interaction.delta',
    'interaction.reset',
    'plan.delta',
    'plan.reset',
    'changeset.delta',
    'changeset.reset',
    'terminal.snapshot',
    'terminal.delta',
    'turn.delta',
    'turn.completed',
    'approval.requested',
  ]),
  timestamp: z.string(),
  payload: z.record(z.any()),
})

export const clientDiagnosticViewportSchema = z.object({
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  device_pixel_ratio: z.number().nonnegative(),
  visual_width: z.number().nonnegative().nullable().default(null),
  visual_height: z.number().nonnegative().nullable().default(null),
  screen_width: z.number().nonnegative().nullable().default(null),
  screen_height: z.number().nonnegative().nullable().default(null),
})

export const clientDiagnosticEnvironmentSchema = z.object({
  user_agent: z.string(),
  language: z.string().nullable().default(null),
  languages: z.array(z.string()).default([]),
  platform: z.string().nullable().default(null),
  vendor: z.string().nullable().default(null),
  online: z.boolean().nullable().default(null),
  cookie_enabled: z.boolean().nullable().default(null),
  secure_context: z.boolean(),
  standalone_display_mode: z.boolean(),
  hardware_concurrency: z.number().int().nonnegative().nullable().default(null),
  device_memory_gb: z.number().nonnegative().nullable().default(null),
  max_touch_points: z.number().int().nonnegative().nullable().default(null),
})

export const clientDiagnosticPageSchema = z.object({
  href: z.string(),
  pathname: z.string(),
  referrer: z.string().nullable().default(null),
  visibility_state: z.string().nullable().default(null),
})

export const clientDiagnosticServiceWorkerRegistrationSchema = z.object({
  scope: z.string(),
  active_script_url: z.string().nullable().default(null),
  waiting_script_url: z.string().nullable().default(null),
  installing_script_url: z.string().nullable().default(null),
})

export const clientDiagnosticServiceWorkerSchema = z.object({
  supported: z.boolean(),
  controller: z.boolean(),
  registrations: z.array(clientDiagnosticServiceWorkerRegistrationSchema).default([]),
})

export const clientDiagnosticCacheSchema = z.object({
  supported: z.boolean(),
  keys: z.array(z.string()).default([]),
})

export const clientDiagnosticManifestSchema = z.object({
  href: z.string().nullable().default(null),
  rel: z.string().nullable().default(null),
})

export const clientDiagnosticStylesheetSchema = z.object({
  href: z.string().nullable().default(null),
  owner_node: z.string().nullable().default(null),
  media: z.string().nullable().default(null),
  disabled: z.boolean(),
  css_rule_count: z.number().int().nonnegative().nullable().default(null),
})

export const clientDiagnosticResourceProbeSchema = z.object({
  url: z.string(),
  kind: z.enum(['stylesheet', 'script', 'manifest', 'icon', 'other']),
  ok: z.boolean(),
  status: z.number().int().nonnegative().nullable().default(null),
  content_type: z.string().nullable().default(null),
  cache_control: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
})

export const clientDiagnosticPerformanceEntrySchema = z.object({
  name: z.string(),
  initiator_type: z.string().nullable().default(null),
  duration_ms: z.number().nonnegative().nullable().default(null),
  transfer_size: z.number().nonnegative().nullable().default(null),
  decoded_body_size: z.number().nonnegative().nullable().default(null),
})

export const clientDiagnosticRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})

export const clientDiagnosticElementSnapshotSchema = z.object({
  selector: z.string(),
  found: z.boolean(),
  text_preview: z.string().nullable().default(null),
  rect: clientDiagnosticRectSchema.nullable().default(null),
  computed: z.record(z.string()).default({}),
})

export const clientDiagnosticReportSchema = z.object({
  captured_at: z.string(),
  page: clientDiagnosticPageSchema,
  environment: clientDiagnosticEnvironmentSchema,
  viewport: clientDiagnosticViewportSchema,
  feature_support: z.record(z.boolean()).default({}),
  service_worker: clientDiagnosticServiceWorkerSchema,
  cache: clientDiagnosticCacheSchema,
  manifest: clientDiagnosticManifestSchema,
  stylesheets: z.array(clientDiagnosticStylesheetSchema).default([]),
  resource_probes: z.array(clientDiagnosticResourceProbeSchema).default([]),
  performance_entries: z.array(clientDiagnosticPerformanceEntrySchema).default([]),
  theme_variables: z.record(z.string()).default({}),
  element_snapshots: z.array(clientDiagnosticElementSnapshotSchema).default([]),
  notes: z.array(z.string()).default([]),
})

export type SessionCapability = z.infer<typeof sessionCapabilitySchema>
export type SessionContextUsage = z.infer<typeof sessionContextUsageSchema>
export type PlanStepStatus = z.infer<typeof planStepStatusSchema>
export type SessionPlanStep = z.infer<typeof sessionPlanStepSchema>
export type SessionPlanSnapshot = z.infer<typeof sessionPlanSnapshotSchema>
export type SessionSubagent = z.infer<typeof sessionSubagentSchema>
export type SessionInteractionKind = z.infer<typeof sessionInteractionKindSchema>
export type SessionInteractionStatus = z.infer<typeof sessionInteractionStatusSchema>
export type SessionInteractionOption = z.infer<typeof sessionInteractionOptionSchema>
export type SessionInteractionQuestion = z.infer<typeof sessionInteractionQuestionSchema>
export type SessionInteractionRequest = z.infer<typeof sessionInteractionRequestSchema>
export type TimelineAttachment = z.infer<typeof timelineAttachmentSchema>
export type SessionInputAttachment = z.infer<typeof sessionInputAttachmentSchema>
export type SkillScope = z.infer<typeof skillScopeSchema>
export type ProjectSkill = z.infer<typeof projectSkillSchema>
export type CodexCommandAvailability = z.infer<typeof codexCommandAvailabilitySchema>
export type CodexCommand = z.infer<typeof codexCommandSchema>
export type CodexCommandCatalog = z.infer<typeof codexCommandCatalogSchema>
export type CodexAvailableModel = z.infer<typeof codexAvailableModelSchema>
export type CodexCommandPanelStatus = z.infer<typeof codexCommandPanelStatusSchema>
export type CodexCommandPanelInputType = z.infer<typeof codexCommandPanelInputTypeSchema>
export type CodexCommandPanelOption = z.infer<typeof codexCommandPanelOptionSchema>
export type CodexCommandPanelEffect = z.infer<typeof codexCommandPanelEffectSchema>
export type CodexCommandPanel = z.infer<typeof codexCommandPanelSchema>
export type CodexCommandPanelResponse = z.infer<typeof codexCommandPanelResponseSchema>
export type AgentNode = z.infer<typeof agentNodeSchema>
export type AgentStatus = z.infer<typeof agentStatusSchema>
export type ProjectRef = z.infer<typeof projectRefSchema>
export type SessionRef = z.infer<typeof sessionRefSchema>
export type SessionRunState = z.infer<typeof sessionRunStateSchema>
export type TimelinePatchFileSummary = z.infer<typeof timelinePatchFileSummarySchema>
export type TimelinePatchSummary = z.infer<typeof timelinePatchSummarySchema>
export type TimelineEntry = z.infer<typeof timelineEntrySchema>
export type SessionTimelineView = z.infer<typeof sessionTimelineViewSchema>
export type SessionTimelineSnapshot = z.infer<typeof sessionTimelineSnapshotSchema>
export type ChangeFile = z.infer<typeof changeFileSchema>
export type ChangeFileSummary = z.infer<typeof changeFileSummarySchema>
export type ChangeSet = z.infer<typeof changeSetSchema>
export type ChangeSetSummary = z.infer<typeof changeSetSummarySchema>
export type SessionChangeSetFileDiff = z.infer<typeof sessionChangeSetFileDiffSchema>
export type GitFile = z.infer<typeof gitFileSchema>
export type SessionGitFileStatus = z.infer<typeof sessionGitFileStatusSchema>
export type SessionGitWorkspaceFile = z.infer<typeof sessionGitWorkspaceFileSchema>
export type SessionGitWorkspaceFileDiff = z.infer<typeof sessionGitWorkspaceFileDiffSchema>
export type SessionGitWorkspace = z.infer<typeof sessionGitWorkspaceSchema>
export type SessionGitHistoryCommitFile = z.infer<typeof sessionGitHistoryCommitFileSchema>
export type SessionGitHistoryCommit = z.infer<typeof sessionGitHistoryCommitSchema>
export type SessionGitHistoryFileDiff = z.infer<typeof sessionGitHistoryFileDiffSchema>
export type SessionGitHistory = z.infer<typeof sessionGitHistorySchema>
export type SessionGitAction = z.infer<typeof sessionGitActionSchema>
export type SessionGitActionResponse = z.infer<typeof sessionGitActionResponseSchema>
export type SessionTurnAction = z.infer<typeof sessionTurnActionSchema>
export type SessionTurnActionResponse = z.infer<typeof sessionTurnActionResponseSchema>
export type SessionFilePreviewNodeKind = z.infer<typeof sessionFilePreviewNodeKindSchema>
export type SessionFilePreviewFileKind = z.infer<typeof sessionFilePreviewFileKindSchema>
export type SessionFilePreviewTreeNode = z.infer<typeof sessionFilePreviewTreeNodeSchema>
export type SessionFilePreviewTreeResponse = z.infer<typeof sessionFilePreviewTreeResponseSchema>
export type SessionFilePreviewContentResponse = z.infer<typeof sessionFilePreviewContentResponseSchema>
export type SessionRunCommandShell = z.infer<typeof sessionRunCommandShellSchema>
export type SessionRunCommandSource = z.infer<typeof sessionRunCommandSourceSchema>
export type SessionRunCommand = z.infer<typeof sessionRunCommandSchema>
export type SessionRunCommandDraft = z.infer<typeof sessionRunCommandDraftSchema>
export type SessionRunCommandCatalog = z.infer<typeof sessionRunCommandCatalogSchema>
export type SessionRunWebsiteSource = z.infer<typeof sessionRunWebsiteSourceSchema>
export type SessionRunWebsite = z.infer<typeof sessionRunWebsiteSchema>
export type SessionRunWebsiteDraft = z.infer<typeof sessionRunWebsiteDraftSchema>
export type SessionRunWebsiteCatalog = z.infer<typeof sessionRunWebsiteCatalogSchema>
export type SessionRunNodeRuntime = z.infer<typeof sessionRunNodeRuntimeSchema>
export type SessionTerminalStatus = z.infer<typeof sessionTerminalStatusSchema>
export type SessionTerminalOutputStream = z.infer<typeof sessionTerminalOutputStreamSchema>
export type SessionTerminalOutputChunk = z.infer<typeof sessionTerminalOutputChunkSchema>
export type SessionTerminal = z.infer<typeof sessionTerminalSchema>
export type SessionTerminalSnapshot = z.infer<typeof sessionTerminalSnapshotSchema>
export type SessionTerminalOutput = z.infer<typeof sessionTerminalOutputSchema>
export type SessionRecoveryPatch = z.infer<typeof sessionRecoveryPatchSchema>
export type SessionRecoverySnapshot = z.infer<typeof sessionRecoverySnapshotSchema>
export type SessionBootstrapSnapshot = z.infer<typeof sessionBootstrapSnapshotSchema>
export type SessionRunWorkbench = z.infer<typeof sessionRunWorkbenchSchema>
export type SessionRunCommandCatalogResponse = z.infer<typeof sessionRunCommandCatalogResponseSchema>
export type SessionRunWebsiteCatalogResponse = z.infer<typeof sessionRunWebsiteCatalogResponseSchema>
export type SessionRunCommandGeneration = z.infer<typeof sessionRunCommandGenerationSchema>
export type SessionRunCommandGenerationResponse = z.infer<typeof sessionRunCommandGenerationResponseSchema>
export type SessionRunWebsiteGeneration = z.infer<typeof sessionRunWebsiteGenerationSchema>
export type SessionRunWebsiteGenerationResponse = z.infer<typeof sessionRunWebsiteGenerationResponseSchema>
export type SessionTerminalActionResponse = z.infer<typeof sessionTerminalActionResponseSchema>
export type DevManagerServiceKey = z.infer<typeof devManagerServiceKeySchema>
export type DevManagerServiceStatus = z.infer<typeof devManagerServiceStatusSchema>
export type DevManagerJobKind = z.infer<typeof devManagerJobKindSchema>
export type DevManagerJobStatus = z.infer<typeof devManagerJobStatusSchema>
export type DevManagerLogLevel = z.infer<typeof devManagerLogLevelSchema>
export type DevManagerConfig = z.infer<typeof devManagerConfigSchema>
export type DevManagerConfigUpdate = z.infer<typeof devManagerConfigUpdateSchema>
export type DevManagerCredentialState = z.infer<typeof devManagerCredentialStateSchema>
export type DevManagerServiceProbe = z.infer<typeof devManagerServiceProbeSchema>
export type DevManagerServiceState = z.infer<typeof devManagerServiceStateSchema>
export type DevManagerJobLogEntry = z.infer<typeof devManagerJobLogEntrySchema>
export type DevManagerJob = z.infer<typeof devManagerJobSchema>
export type DevManagerArtifact = z.infer<typeof devManagerArtifactSchema>
export type DevManagerSnapshot = z.infer<typeof devManagerSnapshotSchema>
export type DevManagerActionRequest = z.infer<typeof devManagerActionRequestSchema>
export type DevManagerActionResponse = z.infer<typeof devManagerActionResponseSchema>
export type RuntimeProcess = z.infer<typeof runtimeProcessSchema>
export type PreviewEndpoint = z.infer<typeof previewEndpointSchema>
export type DirectoryNode = z.infer<typeof directoryNodeSchema>
export type CreateDirectoryResponse = z.infer<typeof createDirectoryResponseSchema>
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>
export type WorkspaceProjectStats = z.infer<typeof workspaceProjectStatsSchema>
export type WorkspaceProjectDirectory = z.infer<typeof workspaceProjectDirectorySchema>
export type WorkspaceAgentSummary = z.infer<typeof workspaceAgentSummarySchema>
export type WorkspaceSessionListItem = z.infer<typeof workspaceSessionListItemSchema>
export type WorkspaceSessionDetail = z.infer<typeof workspaceSessionDetailSchema>
export type WorkspaceSessionDetailResponse = z.infer<typeof workspaceSessionDetailResponseSchema>
export type WorkspaceSessionDirectory = WorkspaceSessionListItem
export type HubDirectorySnapshot = z.infer<typeof hubDirectorySnapshotSchema>
export type HubRecentSession = z.infer<typeof hubRecentSessionSchema>
export type HubRecentSessionsSnapshot = z.infer<typeof hubRecentSessionsSnapshotSchema>
export type SessionLocation = z.infer<typeof sessionLocationSchema>
export type WorkspaceDirectorySnapshot = z.infer<typeof workspaceDirectorySnapshotSchema>
export type WorkspaceSessionBucket = z.infer<typeof workspaceSessionBucketSchema>
export type WorkspaceSessionPage = z.infer<typeof workspaceSessionPageSchema>
export type SessionToolCallDetail = z.infer<typeof sessionToolCallDetailSchema>
export type PhaseOneSnapshot = z.infer<typeof phaseOneSnapshotSchema>
export type AgentControlPlaneSync = z.infer<typeof agentControlPlaneSyncSchema>
export type AgentRegistrationResponse = z.infer<typeof agentRegistrationResponseSchema>
export type AgentAction = z.infer<typeof agentActionSchema>
export type AgentActionRequest = z.infer<typeof agentActionRequestSchema>
export type AgentActionResponse = z.infer<typeof agentActionResponseSchema>
export type WebPushSubscriptionSettings = z.infer<typeof webPushSubscriptionSettingsSchema>
export type WebPushSubscriptionKeys = z.infer<typeof webPushSubscriptionKeysSchema>
export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>
export type WebPushDevice = z.infer<typeof webPushDeviceSchema>
export type WebPushSubscriptionUpsertRequest = z.infer<typeof webPushSubscriptionUpsertRequestSchema>
export type WebPushSubscriptionRemoveRequest = z.infer<typeof webPushSubscriptionRemoveRequestSchema>
export type WebPushTestRequest = z.infer<typeof webPushTestRequestSchema>
export type WebPushPublicConfig = z.infer<typeof webPushPublicConfigSchema>
export type WebPushSubscriptionResponse = z.infer<typeof webPushSubscriptionResponseSchema>
export type WebPushTestResponse = z.infer<typeof webPushTestResponseSchema>
export type SocketEvent = z.infer<typeof socketEventSchema>
export type ClientDiagnosticViewport = z.infer<typeof clientDiagnosticViewportSchema>
export type ClientDiagnosticEnvironment = z.infer<typeof clientDiagnosticEnvironmentSchema>
export type ClientDiagnosticPage = z.infer<typeof clientDiagnosticPageSchema>
export type ClientDiagnosticServiceWorkerRegistration = z.infer<typeof clientDiagnosticServiceWorkerRegistrationSchema>
export type ClientDiagnosticServiceWorker = z.infer<typeof clientDiagnosticServiceWorkerSchema>
export type ClientDiagnosticCache = z.infer<typeof clientDiagnosticCacheSchema>
export type ClientDiagnosticManifest = z.infer<typeof clientDiagnosticManifestSchema>
export type ClientDiagnosticStylesheet = z.infer<typeof clientDiagnosticStylesheetSchema>
export type ClientDiagnosticResourceProbe = z.infer<typeof clientDiagnosticResourceProbeSchema>
export type ClientDiagnosticPerformanceEntry = z.infer<typeof clientDiagnosticPerformanceEntrySchema>
export type ClientDiagnosticRect = z.infer<typeof clientDiagnosticRectSchema>
export type ClientDiagnosticElementSnapshot = z.infer<typeof clientDiagnosticElementSnapshotSchema>
export type ClientDiagnosticReport = z.infer<typeof clientDiagnosticReportSchema>

const GENERIC_IMAGE_ATTACHMENT_NAME_PATTERN =
  /^(?:image|img|photo|picture|screenshot|图片|照片|截图)(?:[-_ ]?\d+)?\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i

const normalizeAttachmentText = (value: string | null | undefined) => value?.trim() ?? ''

const attachmentIdentitySeparator = '\u0000'

const scoreTimelineAttachmentName = (value: string | null | undefined) => {
  const normalized = normalizeAttachmentText(value)
  if (!normalized) {
    return 0
  }

  if (GENERIC_IMAGE_ATTACHMENT_NAME_PATTERN.test(normalized)) {
    return 1
  }

  return 2 + Math.min(normalized.length, 64) / 100
}

const pickPreferredAttachmentName = (
  currentName: string | null | undefined,
  nextName: string | null | undefined,
) => {
  const currentScore = scoreTimelineAttachmentName(currentName)
  const nextScore = scoreTimelineAttachmentName(nextName)
  if (nextScore > currentScore) {
    return normalizeAttachmentText(nextName) || null
  }

  if (currentScore > nextScore) {
    return normalizeAttachmentText(currentName) || null
  }

  const normalizedCurrent = normalizeAttachmentText(currentName)
  const normalizedNext = normalizeAttachmentText(nextName)
  if (normalizedNext.length > normalizedCurrent.length) {
    return normalizedNext || null
  }

  return normalizedCurrent || null
}

export const getTimelineAttachmentIdentityKey = (
  attachment: Pick<
    TimelineAttachment,
    'kind' | 'name' | 'mime_type' | 'size_bytes' | 'content_url'
  >,
) => {
  const normalizedUrl = normalizeAttachmentText(attachment.content_url)
  if (normalizedUrl) {
    return [
      attachment.kind,
      'content',
      normalizedUrl,
    ].join(attachmentIdentitySeparator)
  }

  return [
    attachment.kind,
    'meta',
    normalizeAttachmentText(attachment.mime_type).toLowerCase(),
    typeof attachment.size_bytes === 'number' && Number.isFinite(attachment.size_bytes)
      ? String(Math.max(0, Math.round(attachment.size_bytes)))
      : '',
    normalizeAttachmentText(attachment.name).toLowerCase(),
  ].join(attachmentIdentitySeparator)
}

export const mergeTimelineAttachment = (
  current: TimelineAttachment,
  next: TimelineAttachment,
): TimelineAttachment => {
  const currentName = normalizeAttachmentText(current.name)
  const nextName = normalizeAttachmentText(next.name)
  const currentMimeType = normalizeAttachmentText(current.mime_type)
  const nextMimeType = normalizeAttachmentText(next.mime_type)

  return {
    id: current.id || next.id,
    kind:
      current.kind === 'image' || next.kind === 'image'
        ? 'image'
        : current.kind,
    name: pickPreferredAttachmentName(currentName, nextName),
    mime_type: currentMimeType || nextMimeType || null,
    size_bytes: current.size_bytes ?? next.size_bytes ?? null,
    content_url:
      normalizeAttachmentText(current.content_url) ||
      normalizeAttachmentText(next.content_url) ||
      null,
  }
}

export const dedupeTimelineAttachments = (
  attachments: TimelineAttachment[] | undefined,
) => {
  if (!attachments || attachments.length === 0) {
    return [] as TimelineAttachment[]
  }

  const deduped: TimelineAttachment[] = []
  const indexByIdentity = new Map<string, number>()

  for (const attachment of attachments) {
    const identityKey = getTimelineAttachmentIdentityKey(attachment)
    const existingIndex = indexByIdentity.get(identityKey)
    if (existingIndex === undefined) {
      indexByIdentity.set(identityKey, deduped.length)
      deduped.push({
        ...attachment,
        name: normalizeAttachmentText(attachment.name) || null,
        mime_type: normalizeAttachmentText(attachment.mime_type) || null,
        size_bytes:
          typeof attachment.size_bytes === 'number' && Number.isFinite(attachment.size_bytes)
            ? Math.max(0, Math.round(attachment.size_bytes))
            : null,
        content_url: normalizeAttachmentText(attachment.content_url) || null,
      })
      continue
    }

    deduped[existingIndex] = mergeTimelineAttachment(deduped[existingIndex]!, attachment)
  }

  return deduped
}

export const mergeTimelineAttachments = (
  primary: TimelineAttachment[] | undefined,
  fallback: TimelineAttachment[] | undefined,
) => dedupeTimelineAttachments([...(primary ?? []), ...(fallback ?? [])])

const iso = (time: string) => new Date(time).toISOString()

const createFullMockPhaseOneSnapshot = (): PhaseOneSnapshot => ({
  generated_at: new Date().toISOString(),
  active_session_id: 'session-managed-1',
  agents: [
    {
      id: 'agent-shanghai-main',
      name: 'studio-main',
      display_name: null,
      host: '100.88.10.14',
      tailscale_ip: '100.88.10.14',
      tailscale_dns_name: 'studio-main.tail-scale.ts.net',
      direct_base_url: 'http://100.88.10.14:4242',
      ws_base_url: 'ws://100.88.10.14:4242/ws',
      status: 'online',
      provider_availability: ['codex'],
      project_count: 2,
      session_count: 2,
      transport: 'direct-agent',
      version: '0.1.0',
      registered_at: iso('2026-03-18T10:30:00+08:00'),
      last_seen_at: iso('2026-03-18T10:58:00+08:00'),
    },
    {
      id: 'agent-macbook',
      name: 'macbook-air',
      display_name: null,
      host: '100.89.20.77',
      tailscale_ip: '100.89.20.77',
      tailscale_dns_name: 'macbook-air.tail-scale.ts.net',
      direct_base_url: 'http://100.89.20.77:4242',
      ws_base_url: 'ws://100.89.20.77:4242/ws',
      status: 'online',
      provider_availability: ['codex'],
      project_count: 1,
      session_count: 1,
      transport: 'hub-routed',
      version: '0.1.0',
      registered_at: iso('2026-03-18T10:20:00+08:00'),
      last_seen_at: iso('2026-03-18T10:55:00+08:00'),
    },
  ],
  projects: [
    {
      id: 'project-panda',
      agent_id: 'agent-shanghai-main',
      name: 'panda',
      display_name: null,
      pinned: false,
      path: 'D:/ai/panda',
      branch: 'main',
      worktree: 'default',
      runtime_profiles: ['dev', 'storybook', 'test'],
      preview_url: 'https://panda.tailnet.ts.net',
    },
    {
      id: 'project-remodex-lab',
      agent_id: 'agent-shanghai-main',
      name: 'remodex',
      display_name: null,
      pinned: false,
      path: 'D:/ai/remodex',
      branch: 'phase1-ui',
      worktree: 'mobile-lab',
      runtime_profiles: ['dev'],
      preview_url: null,
    },
    {
      id: 'project-notes',
      agent_id: 'agent-macbook',
      name: 'notes',
      display_name: null,
      pinned: false,
      path: 'D:/Users/dev/notes',
      branch: 'research',
      worktree: 'default',
      runtime_profiles: ['dev'],
      preview_url: null,
    },
  ],
  sessions: [
    {
      id: 'session-managed-1',
      agent_id: 'agent-shanghai-main',
      project_id: 'project-panda',
      provider: 'codex',
      archived: false,
      title: 'Stage 1 buildout',
      mode: 'managed',
      health: 'active',
      branch: 'main',
      worktree: 'default',
      summary: 'Monorepo scaffold, PWA shell, agent bootstrap API',
      latest_assistant_message: 'Wiring the shell.',
      last_event_at: iso('2026-03-18T10:58:00+08:00'),
      pinned: false,
      run_state: 'running',
      run_state_changed_at: iso('2026-03-18T10:57:20+08:00'),
      context_usage: null,
      subagent: null,
      capability: {
        can_stream_live: true,
        can_send_input: true,
        can_interrupt: true,
        can_approve: true,
        can_reject: true,
        can_show_git: true,
        can_show_terminal: true,
      },
    },
    {
      id: 'session-live-2',
      agent_id: 'agent-shanghai-main',
      project_id: 'project-remodex-lab',
      provider: 'codex',
      archived: false,
      title: 'Remote attach',
      mode: 'attached-live',
      health: 'idle',
      branch: 'phase1-ui',
      worktree: 'mobile-lab',
      summary: '',
      latest_assistant_message: null,
      last_event_at: iso('2026-03-18T10:48:00+08:00'),
      pinned: false,
      run_state: 'completed',
      run_state_changed_at: iso('2026-03-18T10:48:00+08:00'),
      context_usage: null,
      subagent: null,
      capability: {
        can_stream_live: true,
        can_send_input: false,
        can_interrupt: false,
        can_approve: false,
        can_reject: false,
        can_show_git: true,
        can_show_terminal: true,
      },
    },
    {
      id: 'session-history-3',
      agent_id: 'agent-macbook',
      project_id: 'project-notes',
      provider: 'codex',
      archived: false,
      title: 'Research notes',
      mode: 'history-only',
      health: 'offline',
      branch: 'research',
      worktree: 'default',
      summary: '',
      latest_assistant_message: null,
      last_event_at: iso('2026-03-17T19:12:00+08:00'),
      pinned: false,
      run_state: 'idle',
      run_state_changed_at: null,
      context_usage: null,
      subagent: null,
      capability: {
        can_stream_live: false,
        can_send_input: false,
        can_interrupt: false,
        can_approve: false,
        can_reject: false,
        can_show_git: true,
        can_show_terminal: false,
      },
    },
  ],
  timeline: [
    {
      id: 'entry-1',
      kind: 'system',
      title: 'Session ready',
      body: 'Managed session attached.',
      body_truncated: false,
      detail_available: false,
      patch_summary: null,
      session_ids: [],
      timestamp: iso('2026-03-18T10:40:00+08:00'),
      accent: 'muted',
      attachments: [],
    },
    {
      id: 'entry-2',
      kind: 'user',
      title: 'Prompt',
      body: 'Start stage one.',
      body_truncated: false,
      detail_available: false,
      patch_summary: null,
      session_ids: [],
      timestamp: iso('2026-03-18T10:44:00+08:00'),
      accent: 'primary',
      attachments: [],
    },
    {
      id: 'entry-3',
      kind: 'thinking',
      title: 'Plan',
      body: 'Aligning routes and session state.',
      body_truncated: false,
      detail_available: false,
      patch_summary: null,
      session_ids: [],
      timestamp: iso('2026-03-18T10:45:30+08:00'),
      accent: 'secondary',
      attachments: [],
    },
    {
      id: 'entry-4',
      kind: 'tool',
      title: 'Tool activity',
      body: 'Scanned docs/, checked runtime versions, and created the initial workspace directories.',
      body_truncated: false,
      detail_available: false,
      patch_summary: null,
      session_ids: [],
      timestamp: iso('2026-03-18T10:48:00+08:00'),
      accent: 'secondary',
      attachments: [],
    },
    {
      id: 'entry-5',
      kind: 'assistant',
      title: 'Focus',
      body: 'Wiring the shell.',
      body_truncated: false,
      detail_available: false,
      patch_summary: null,
      session_ids: [],
      timestamp: iso('2026-03-18T10:58:00+08:00'),
      accent: 'primary',
      attachments: [],
    },
  ],
  changed_files: [
    { path: 'apps/web/src/components/dashboard.tsx', status: 'added', additions: 248, deletions: 0 },
    { path: 'packages/protocol/src/index.ts', status: 'modified', additions: 94, deletions: 12 },
    { path: 'apps/agent/src/index.ts', status: 'modified', additions: 77, deletions: 3 },
  ],
  runtime_processes: [
    {
      id: 'runtime-dev',
      name: 'dev',
      command: 'pnpm --filter @panda/web dev --host 0.0.0.0 --port 4173',
      port: 4173,
      status: 'running',
      log_excerpt: 'Vite server ready on 0.0.0.0:4173 and previewed over the tailnet.',
    },
    {
      id: 'runtime-agent',
      name: 'agent',
      command: 'pnpm --filter @panda/agent dev',
      port: 4242,
      status: 'running',
      log_excerpt: 'Fastify listening on http://0.0.0.0:4242 with WebSocket events enabled.',
    },
  ],
  previews: [
    { id: 'preview-main', label: 'PWA preview', url: 'https://panda.tailnet.ts.net', status: 'ready' },
    { id: 'preview-storybook', label: 'Design lab', url: 'https://storybook.tailnet.ts.net', status: 'starting' },
  ],
  approvals: [
    {
      id: 'approval-1',
      title: 'Write workspace files',
      description: 'Create monorepo config, React app shell, and Fastify agent entrypoints.',
      status: 'approved',
    },
    {
      id: 'approval-2',
      title: 'Attach external Codex session',
      description: 'External session controls remain experimental until app-server transport is available.',
      status: 'pending',
    },
  ],
})

const filterSnapshotForAgent = (
  snapshot: PhaseOneSnapshot,
  agentId: string,
): PhaseOneSnapshot => {
  const agents = snapshot.agents
    .filter((agent) => agent.id === agentId)
    .map((agent) => ({
      ...agent,
      transport: 'direct-agent' as const,
    }))
  const projects = snapshot.projects.filter((project) => project.agent_id === agentId)
  const sessions = snapshot.sessions.filter((session) => session.agent_id === agentId)

  return {
    ...snapshot,
    agents: agents.map((agent) => ({
      ...agent,
      project_count: projects.filter((project) => project.agent_id === agent.id).length,
      session_count: sessions.filter((session) => session.agent_id === agent.id).length,
    })),
    projects,
    sessions,
    active_session_id:
      sessions.find((session) => session.id === snapshot.active_session_id)?.id ??
      sessions[0]?.id ??
      snapshot.active_session_id,
  }
}

export const createDirectPhaseOneSnapshot = (): PhaseOneSnapshot =>
  filterSnapshotForAgent(createFullMockPhaseOneSnapshot(), 'agent-shanghai-main')

export const createHubPhaseOneSnapshot = (): PhaseOneSnapshot =>
  createFullMockPhaseOneSnapshot()

export const createMockPhaseOneSnapshot = (): PhaseOneSnapshot =>
  createHubPhaseOneSnapshot()
