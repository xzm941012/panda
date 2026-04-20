export const SESSION_MODEL_STORAGE_KEY = 'panda:session-model'
export const SESSION_COMMAND_EXECUTION_MODEL_STORAGE_KEY =
  'panda:command-execution-model'
export const SESSION_TITLE_GENERATION_MODEL_STORAGE_KEY =
  'panda:title-generation-model'
export const SESSION_MODEL_OPTIONS_STORAGE_KEY = 'panda:session-model-options'
export const SESSION_MODEL_OPTIONS_UPDATED_EVENT =
  'panda:session-model-options-updated'
export const SESSION_REASONING_STORAGE_KEY = 'panda:session-reasoning'
export const SESSION_FAST_MODE_STORAGE_KEY = 'panda:session-fast-mode'
export const SESSION_PLAN_MODE_STORAGE_KEY = 'panda:session-plan-mode'
export const SESSION_YOLO_MODE_STORAGE_KEY = 'panda:session-yolo-mode'

export type SessionComposerModelOption = {
  label: string
  value: string
  description?: string | null
}

export type SessionManagedModelOption = SessionComposerModelOption & {
  id: string
}

export const DEFAULT_SESSION_MODEL_OPTIONS: SessionManagedModelOption[] = [
  {
    id: 'gpt-5.4',
    label: 'gpt-5.4',
    value: 'gpt-5.4',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'gpt-5.3-codex',
    value: 'gpt-5.3-codex',
  },
  {
    id: 'gpt-5.3',
    label: 'gpt-5.3',
    value: 'gpt-5.3',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini',
    value: 'gpt-5.4-mini',
  },
  {
    id: 'gpt-5.2',
    label: 'gpt-5.2',
    value: 'gpt-5.2',
  },
]

export const REASONING_OPTIONS = [
  {
    label: '低',
    value: 'low',
  },
  {
    label: '中',
    value: 'medium',
  },
  {
    label: '高',
    value: 'high',
  },
  {
    label: '极高',
    value: 'xhigh',
  },
] as const

export type SessionComposerModelValue = string
export type SessionComposerReasoningValue =
  (typeof REASONING_OPTIONS)[number]['value']

const DEFAULT_MODEL = DEFAULT_SESSION_MODEL_OPTIONS[0]?.value ?? 'gpt-5.4'
const DEFAULT_COMMAND_EXECUTION_MODEL = 'gpt-5.4-mini'
const DEFAULT_TITLE_GENERATION_MODEL = 'gpt-5.4-mini'
const DEFAULT_REASONING = REASONING_OPTIONS[2].value

const normalizeText = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

const normalizeModelOption = (
  value: unknown,
  index: number,
): SessionManagedModelOption | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as {
    id?: unknown
    label?: unknown
    value?: unknown
    description?: unknown
  }
  const normalizedValue = normalizeText(candidate.value)
  const normalizedLabel = normalizeText(candidate.label) || normalizedValue
  const normalizedId =
    normalizeText(candidate.id) || normalizedValue || `custom-model-${index + 1}`

  if (!normalizedLabel || !normalizedValue) {
    return null
  }

  const normalizedDescription = normalizeText(candidate.description)

  return {
    id: normalizedId,
    label: normalizedLabel,
    value: normalizedValue,
    description: normalizedDescription || null,
  }
}

const dedupeModelOptions = (
  options: SessionManagedModelOption[],
): SessionManagedModelOption[] => {
  const usedIds = new Set<string>()
  const usedValues = new Set<string>()

  return options.flatMap((option) => {
    const valueKey = option.value.toLowerCase()
    if (usedValues.has(valueKey)) {
      return []
    }
    usedValues.add(valueKey)

    let nextId = option.id
    let suffix = 2
    while (usedIds.has(nextId)) {
      nextId = `${option.id}-${suffix}`
      suffix += 1
    }
    usedIds.add(nextId)

    return [
      {
        ...option,
        id: nextId,
      },
    ]
  })
}

const normalizeModelOptions = (value: unknown): SessionManagedModelOption[] => {
  if (!Array.isArray(value)) {
    return DEFAULT_SESSION_MODEL_OPTIONS
  }

  const normalized = dedupeModelOptions(
    value.flatMap((entry, index) => {
      const option = normalizeModelOption(entry, index)
      return option ? [option] : []
    }),
  )

  return normalized.length > 0 ? normalized : DEFAULT_SESSION_MODEL_OPTIONS
}

const readStorageValue = (key: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const emitModelOptionsUpdated = () => {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new Event(SESSION_MODEL_OPTIONS_UPDATED_EVENT))
}

const writeStorageValue = (key: string, value: string) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore preference persistence failures.
  }
}

const readStorageBoolean = (key: string, fallback = false) => {
  const value = readStorageValue(key)
  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  return fallback
}

const writeStorageBoolean = (key: string, value: boolean) => {
  writeStorageValue(key, value ? 'true' : 'false')
}

const getSessionScopedStorageKey = (
  prefix: string,
  sessionId: string | null | undefined,
) => {
  const normalizedSessionId = sessionId?.trim()
  if (!normalizedSessionId) {
    return null
  }

  return `${prefix}:${normalizedSessionId}`
}

export const createSessionManagedModelOption = (
  value?: Partial<SessionManagedModelOption>,
): SessionManagedModelOption => {
  const fallbackValue = normalizeText(value?.value) || ''
  const fallbackLabel = normalizeText(value?.label) || fallbackValue

  return {
    id:
      normalizeText(value?.id) ||
      normalizeText(value?.value) ||
      `custom-model-${Date.now()}`,
    label: fallbackLabel,
    value: fallbackValue,
    description: normalizeText(value?.description) || null,
  }
}

export const getSessionModelOptions = (): SessionComposerModelOption[] =>
  readStoredSessionModelOptions().map(({ id: _id, ...option }) => option)

export const readStoredSessionModelOptions = (): SessionManagedModelOption[] => {
  const raw = readStorageValue(SESSION_MODEL_OPTIONS_STORAGE_KEY)
  if (!raw) {
    return DEFAULT_SESSION_MODEL_OPTIONS
  }

  try {
    return normalizeModelOptions(JSON.parse(raw))
  } catch {
    return DEFAULT_SESSION_MODEL_OPTIONS
  }
}

export const writeStoredSessionModelOptions = (
  value: SessionManagedModelOption[],
) => {
  const normalizedOptions = normalizeModelOptions(value)
  writeStorageValue(
    SESSION_MODEL_OPTIONS_STORAGE_KEY,
    JSON.stringify(normalizedOptions),
  )
  emitModelOptionsUpdated()
}

export const isKnownModelValue = (
  value: string | null | undefined,
): value is SessionComposerModelValue =>
  typeof value === 'string' && value.trim().length > 0

export const isKnownReasoningValue = (
  value: string | null | undefined,
): value is SessionComposerReasoningValue =>
  REASONING_OPTIONS.some((option) => option.value === value)

export const readStoredSessionModel = (): SessionComposerModelValue => {
  const storedValue = readStorageValue(SESSION_MODEL_STORAGE_KEY)
  const modelOptions = readStoredSessionModelOptions()
  return modelOptions.some((option) => option.value === storedValue)
    ? (storedValue as SessionComposerModelValue)
    : (modelOptions[0]?.value ?? DEFAULT_MODEL)
}

export const readStoredCommandExecutionModel = (): SessionComposerModelValue => {
  const storedValue = readStorageValue(SESSION_COMMAND_EXECUTION_MODEL_STORAGE_KEY)
  const modelOptions = readStoredSessionModelOptions()
  if (modelOptions.some((option) => option.value === storedValue)) {
    return storedValue as SessionComposerModelValue
  }

  const defaultOption =
    modelOptions.find((option) => option.value === DEFAULT_COMMAND_EXECUTION_MODEL) ??
    modelOptions[0]
  return defaultOption?.value ?? DEFAULT_COMMAND_EXECUTION_MODEL
}

export const readStoredTitleGenerationModel = (): SessionComposerModelValue => {
  const storedValue = readStorageValue(SESSION_TITLE_GENERATION_MODEL_STORAGE_KEY)
  const modelOptions = readStoredSessionModelOptions()
  if (modelOptions.some((option) => option.value === storedValue)) {
    return storedValue as SessionComposerModelValue
  }

  const defaultOption =
    modelOptions.find((option) => option.value === DEFAULT_TITLE_GENERATION_MODEL) ??
    modelOptions[0]
  return defaultOption?.value ?? DEFAULT_TITLE_GENERATION_MODEL
}

export const readStoredSessionReasoning = (): SessionComposerReasoningValue => {
  const storedValue = readStorageValue(SESSION_REASONING_STORAGE_KEY)
  return isKnownReasoningValue(storedValue) ? storedValue : DEFAULT_REASONING
}

export const writeStoredSessionModel = (value: SessionComposerModelValue) => {
  writeStorageValue(SESSION_MODEL_STORAGE_KEY, value)
}

export const writeStoredCommandExecutionModel = (
  value: SessionComposerModelValue,
) => {
  writeStorageValue(SESSION_COMMAND_EXECUTION_MODEL_STORAGE_KEY, value)
}

export const writeStoredTitleGenerationModel = (
  value: SessionComposerModelValue,
) => {
  writeStorageValue(SESSION_TITLE_GENERATION_MODEL_STORAGE_KEY, value)
}

export const writeStoredSessionReasoning = (
  value: SessionComposerReasoningValue,
) => {
  writeStorageValue(SESSION_REASONING_STORAGE_KEY, value)
}

export const readStoredSessionFastMode = (
  sessionId: string | null | undefined,
) => {
  const storageKey = getSessionScopedStorageKey(
    SESSION_FAST_MODE_STORAGE_KEY,
    sessionId,
  )
  return storageKey ? readStorageBoolean(storageKey) : false
}

export const readStoredSessionPlanMode = (
  sessionId: string | null | undefined,
) => {
  const storageKey = getSessionScopedStorageKey(
    SESSION_PLAN_MODE_STORAGE_KEY,
    sessionId,
  )
  return storageKey ? readStorageBoolean(storageKey) : false
}

export const readStoredSessionYoloMode = (
  sessionId: string | null | undefined,
) => {
  const storageKey = getSessionScopedStorageKey(
    SESSION_YOLO_MODE_STORAGE_KEY,
    sessionId,
  )
  return storageKey ? readStorageBoolean(storageKey) : false
}

export const writeStoredSessionFastMode = (
  sessionId: string | null | undefined,
  value: boolean,
) => {
  const storageKey = getSessionScopedStorageKey(
    SESSION_FAST_MODE_STORAGE_KEY,
    sessionId,
  )
  if (!storageKey) {
    return
  }

  writeStorageBoolean(storageKey, value)
}

export const writeStoredSessionPlanMode = (
  sessionId: string | null | undefined,
  value: boolean,
) => {
  const storageKey = getSessionScopedStorageKey(
    SESSION_PLAN_MODE_STORAGE_KEY,
    sessionId,
  )
  if (!storageKey) {
    return
  }

  writeStorageBoolean(storageKey, value)
}

export const writeStoredSessionYoloMode = (
  sessionId: string | null | undefined,
  value: boolean,
) => {
  const storageKey = getSessionScopedStorageKey(
    SESSION_YOLO_MODE_STORAGE_KEY,
    sessionId,
  )
  if (!storageKey) {
    return
  }

  writeStorageBoolean(storageKey, value)
}

export const writeStoredSessionModes = (
  sessionId: string | null | undefined,
  value: {
    isFastModeEnabled: boolean
    isPlanModeEnabled: boolean
    isYoloModeEnabled: boolean
  },
) => {
  writeStoredSessionFastMode(sessionId, value.isFastModeEnabled)
  writeStoredSessionPlanMode(sessionId, value.isPlanModeEnabled)
  writeStoredSessionYoloMode(sessionId, value.isYoloModeEnabled)
}

export const getSessionModelLabel = (value: string | null | undefined) =>
  getSessionModelLabelFromOptions(value, getSessionModelOptions())

export const getSessionModelLabelFromOptions = (
  value: string | null | undefined,
  options: readonly SessionComposerModelOption[] = getSessionModelOptions(),
) =>
  options.find((option) => option.value === value)?.label ??
  (typeof value === 'string' && value.trim()
    ? value.trim()
    : options[0]?.label ?? DEFAULT_MODEL)

export const getSessionReasoningLabel = (value: string | null | undefined) =>
  REASONING_OPTIONS.find((option) => option.value === value)?.label ??
  REASONING_OPTIONS[2].label
