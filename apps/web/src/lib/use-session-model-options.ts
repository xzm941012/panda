import { useSyncExternalStore } from 'react'
import {
  DEFAULT_SESSION_MODEL_OPTIONS,
  readStoredSessionModelOptions,
  SESSION_MODEL_OPTIONS_STORAGE_KEY,
  SESSION_MODEL_OPTIONS_UPDATED_EVENT,
} from './session-composer-preferences'

const subscribe = (onStoreChange: () => void) => {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === SESSION_MODEL_OPTIONS_STORAGE_KEY
    ) {
      onStoreChange()
    }
  }

  const handleModelOptionsUpdated = () => {
    onStoreChange()
  }

  window.addEventListener('storage', handleStorage)
  window.addEventListener(
    SESSION_MODEL_OPTIONS_UPDATED_EVENT,
    handleModelOptionsUpdated,
  )

  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(
      SESSION_MODEL_OPTIONS_UPDATED_EVENT,
      handleModelOptionsUpdated,
    )
  }
}

const getSnapshot = () => readStoredSessionModelOptions()

const getServerSnapshot = () => DEFAULT_SESSION_MODEL_OPTIONS

export const useSessionModelOptions = () =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
