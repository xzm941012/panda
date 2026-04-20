import { useEffect, useRef } from 'react'
import { SettingsPage } from './settings-page'

type SettingsOverlayProps = {
  onClose: () => void
}

export const SettingsOverlay = ({ onClose }: SettingsOverlayProps) => {
  const overlayRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const previousDocumentOverflow = document.documentElement.style.overflow
    const previousBodyOverflow = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    overlayRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.documentElement.style.overflow = previousDocumentOverflow
      document.body.style.overflow = previousBodyOverflow
    }
  }, [onClose])

  return (
    <div
      ref={overlayRef}
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      tabIndex={-1}
    >
      <SettingsPage mode="overlay" onRequestClose={onClose} />
    </div>
  )
}
