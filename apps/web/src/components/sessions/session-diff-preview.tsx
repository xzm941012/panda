import { memo, useEffect, useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import cssLanguage from 'highlight.js/lib/languages/css'
import javascriptLanguage from 'highlight.js/lib/languages/javascript'
import jsonLanguage from 'highlight.js/lib/languages/json'
import markdownLanguage from 'highlight.js/lib/languages/markdown'
import typescriptLanguage from 'highlight.js/lib/languages/typescript'
import xmlLanguage from 'highlight.js/lib/languages/xml'

type DiffLineKind = 'meta' | 'hunk' | 'context' | 'add' | 'remove'

type ParsedDiffLine = {
  kind: DiffLineKind
  content: string
  oldLineNumber: number | null
  newLineNumber: number | null
  displayLineNumber: number | null
}

type SessionDiffPreviewProps = {
  diffText: string
  filePath: string
  emptyMessage: string
}

hljs.registerLanguage('typescript', typescriptLanguage)
hljs.registerLanguage('javascript', javascriptLanguage)
hljs.registerLanguage('css', cssLanguage)
hljs.registerLanguage('json', jsonLanguage)
hljs.registerLanguage('markdown', markdownLanguage)
hljs.registerLanguage('xml', xmlLanguage)

const unifiedDiffCache = new Map<string, ParsedDiffLine[]>()
const diffHighlightCache = new Map<string, string>()
const RENDER_CACHE_LIMIT = 300

const getCachedComputation = <T,>(
  cache: Map<string, T>,
  key: string,
  compute: () => T,
) => {
  const cached = cache.get(key)
  if (cached !== undefined) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const value = compute()
  cache.set(key, value)
  if (cache.size > RENDER_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) {
      cache.delete(oldestKey)
    }
  }
  return value
}

const inferCodeLanguage = (filePath: string) => {
  const normalized = filePath.toLowerCase()

  if (
    normalized.endsWith('.ts') ||
    normalized.endsWith('.tsx') ||
    normalized.endsWith('.mts') ||
    normalized.endsWith('.cts')
  ) {
    return 'typescript'
  }

  if (
    normalized.endsWith('.js') ||
    normalized.endsWith('.jsx') ||
    normalized.endsWith('.mjs') ||
    normalized.endsWith('.cjs')
  ) {
    return 'javascript'
  }

  if (normalized.endsWith('.json')) {
    return 'json'
  }

  if (
    normalized.endsWith('.css') ||
    normalized.endsWith('.scss') ||
    normalized.endsWith('.less')
  ) {
    return 'css'
  }

  if (
    normalized.endsWith('.html') ||
    normalized.endsWith('.svg') ||
    normalized.endsWith('.xml')
  ) {
    return 'xml'
  }

  if (normalized.endsWith('.md') || normalized.endsWith('.mdx')) {
    return 'markdown'
  }

  return null
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const parseUnifiedDiff = (diffText: string): ParsedDiffLine[] =>
  getCachedComputation(unifiedDiffCache, diffText, () => {
    const lines = diffText.split(/\r?\n/)
    const parsed: ParsedDiffLine[] = []
    let oldLineNumber: number | null = null
    let newLineNumber: number | null = null

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '')
      const normalizedLine = line.trimStart()
      const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(
        normalizedLine,
      )

      if (normalizedLine.startsWith('@@')) {
        if (hunkMatch) {
          oldLineNumber = Number(hunkMatch[1])
          newLineNumber = Number(hunkMatch[2])
        }
        continue
      }

      if (
        line.startsWith('diff --git ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('*** ')
      ) {
        continue
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        parsed.push({
          kind: 'add',
          content: line.slice(1),
          oldLineNumber: null,
          newLineNumber,
          displayLineNumber: newLineNumber,
        })
        if (newLineNumber !== null) {
          newLineNumber += 1
        }
        continue
      }

      if (line.startsWith('-') && !line.startsWith('---')) {
        parsed.push({
          kind: 'remove',
          content: line.slice(1),
          oldLineNumber,
          newLineNumber: null,
          displayLineNumber: oldLineNumber,
        })
        if (oldLineNumber !== null) {
          oldLineNumber += 1
        }
        continue
      }

      parsed.push({
        kind: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldLineNumber,
        newLineNumber,
        displayLineNumber: newLineNumber ?? oldLineNumber,
      })
      if (oldLineNumber !== null) {
        oldLineNumber += 1
      }
      if (newLineNumber !== null) {
        newLineNumber += 1
      }
    }

    const hasRealLineNumbers = parsed.some(
      (line) =>
        (line.kind === 'add' || line.kind === 'remove' || line.kind === 'context') &&
        line.displayLineNumber !== null,
    )

    if (!hasRealLineNumbers) {
      let fallbackLineNumber = 1
      for (const line of parsed) {
        if (line.kind === 'add' || line.kind === 'remove' || line.kind === 'context') {
          line.displayLineNumber = fallbackLineNumber
          fallbackLineNumber += 1
        }
      }
    }

    return parsed
  })

const highlightDiffContent = (content: string, filePath: string) =>
  getCachedComputation(diffHighlightCache, `${filePath}\u0000${content}`, () => {
    const language = inferCodeLanguage(filePath)
    if (!language || !content.trim()) {
      return escapeHtml(content)
    }

    try {
      return hljs.highlight(content, {
        language,
        ignoreIllegals: true,
      }).value
    } catch {
      return escapeHtml(content)
    }
  })

const isDiffMetaLine = (line: ParsedDiffLine) =>
  line.kind === 'meta' || line.kind === 'hunk'

export const SessionDiffPreview = memo(function SessionDiffPreview({
  diffText,
  filePath,
  emptyMessage,
}: SessionDiffPreviewProps) {
  const diffLines = useMemo(() => parseUnifiedDiff(diffText), [diffText])
  const shouldDeferHighlight = diffLines.length > 180 || diffText.length > 16_000
  const [highlightReady, setHighlightReady] = useState(!shouldDeferHighlight)

  useEffect(() => {
    if (!shouldDeferHighlight) {
      setHighlightReady(true)
      return
    }

    setHighlightReady(false)

    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
      cancelIdleCallback?: (handle: number) => void
    }
    const idleHandle = idleWindow.requestIdleCallback?.(
      () => {
        setHighlightReady(true)
      },
      { timeout: 220 },
    )
    const timeoutHandle =
      idleHandle === undefined
        ? window.setTimeout(() => {
            setHighlightReady(true)
          }, 32)
        : null

    return () => {
      if (idleHandle !== undefined) {
        idleWindow.cancelIdleCallback?.(idleHandle)
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle)
      }
    }
  }, [diffText, shouldDeferHighlight])

  if (!diffText.trim()) {
    return <div className="patch-file-card__empty">{emptyMessage}</div>
  }

  return (
    <div className="patch-diff">
      {diffLines.map((line, index) => (
        <div
          key={`${line.kind}-${index}-${line.oldLineNumber ?? 'x'}-${line.newLineNumber ?? 'y'}`}
          className={`patch-diff__line is-${line.kind} ${isDiffMetaLine(line) ? 'is-meta-block' : ''}`}
        >
          {isDiffMetaLine(line) ? null : (
            <span className="patch-diff__number">
              {line.displayLineNumber ?? ''}
            </span>
          )}
          <span
            className="patch-diff__content"
            dangerouslySetInnerHTML={{
              __html: highlightReady
                ? highlightDiffContent(line.content || ' ', filePath)
                : escapeHtml(line.content || ' '),
            }}
          />
        </div>
      ))}
    </div>
  )
})
