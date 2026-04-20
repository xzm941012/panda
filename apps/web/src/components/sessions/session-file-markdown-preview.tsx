import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSessionFilePreviewContentQueryOptions } from '../../lib/session-file-preview'

type SessionFileMarkdownPreviewProps = {
  agentId: string | null
  sessionId: string
  filePath: string
  content: string
}

type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'blockquote'; text: string }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }

type MarkdownListItem = {
  text: string
  checked: boolean | null
  ordinal: number | null
}

type HeadingTagName = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

const normalizeMarkdownPath = (value: string) =>
  value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/')

const resolveMarkdownRelativeAssetPath = (
  filePath: string,
  target: string,
) => {
  const trimmed = target.trim()
  if (!trimmed || /^([a-z]+:|#)/i.test(trimmed) || trimmed.startsWith('//')) {
    return null
  }

  try {
    const baseDirectory = normalizeMarkdownPath(filePath).split('/').slice(0, -1).join('/')
    const resolvedUrl = new URL(
      trimmed,
      `https://preview.local/${baseDirectory ? `${baseDirectory}/` : ''}`,
    )
    return normalizeMarkdownPath(resolvedUrl.pathname)
  } catch {
    return null
  }
}

const parseTableRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

const matchListItem = (line: string): MarkdownListItem & { ordered: boolean } | null => {
  const orderedMatch = /^\s*(\d+)\.\s+(.+)$/.exec(line)
  if (orderedMatch) {
    const taskMatch = /^\[( |x|X)\]\s+(.+)$/.exec(orderedMatch[2] ?? '')
    return {
      ordered: true,
      ordinal: Number.parseInt(orderedMatch[1] ?? '', 10),
      checked: taskMatch ? taskMatch[1].toLowerCase() === 'x' : null,
      text: taskMatch?.[2]?.trim() ?? orderedMatch[2]?.trim() ?? '',
    }
  }

  const bulletMatch = /^\s*[-*+]\s+(.+)$/.exec(line)
  if (bulletMatch) {
    const taskMatch = /^\[( |x|X)\]\s+(.+)$/.exec(bulletMatch[1] ?? '')
    return {
      ordered: false,
      ordinal: null,
      checked: taskMatch ? taskMatch[1].toLowerCase() === 'x' : null,
      text: taskMatch?.[2]?.trim() ?? bulletMatch[1]?.trim() ?? '',
    }
  }

  return null
}

const parseMarkdownBlocks = (value: string): MarkdownBlock[] => {
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let paragraphLines: string[] = []

  const flushParagraph = () => {
    const text = paragraphLines.join('\n').trim()
    if (text) {
      blocks.push({
        kind: 'paragraph',
        text,
      })
    }
    paragraphLines = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph()
      continue
    }

    const fencedCodeMatch = /^\s{0,3}(```+|~~~+)[ \t]*([^`]*)$/.exec(line)
    if (fencedCodeMatch) {
      flushParagraph()
      const fence = fencedCodeMatch[1] ?? '```'
      const language = fencedCodeMatch[2]?.trim().split(/\s+/, 1)[0] ?? null
      const contentLines: string[] = []
      const closingFence = new RegExp(`^\\s{0,3}${fence}\\s*$`)

      index += 1
      while (index < lines.length && !closingFence.test(lines[index] ?? '')) {
        contentLines.push(lines[index] ?? '')
        index += 1
      }

      blocks.push({
        kind: 'code',
        language,
        text: contentLines.join('\n'),
      })
      continue
    }

    const headingMatch = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (headingMatch) {
      flushParagraph()
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].replace(/\s+#+\s*$/, '').trim(),
      })
      continue
    }

    const quoteMatch = /^\s*>\s?(.*)$/.exec(line)
    if (quoteMatch) {
      flushParagraph()
      const quoteLines = [quoteMatch[1] ?? '']
      while (index + 1 < lines.length) {
        const nextQuoteMatch = /^\s*>\s?(.*)$/.exec(lines[index + 1] ?? '')
        if (!nextQuoteMatch) {
          break
        }
        quoteLines.push(nextQuoteMatch[1] ?? '')
        index += 1
      }
      blocks.push({
        kind: 'blockquote',
        text: quoteLines.join('\n').trim(),
      })
      continue
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[index + 1] ?? '')
    ) {
      flushParagraph()
      const headers = parseTableRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        rows.push(parseTableRow(lines[index] ?? ''))
        index += 1
      }
      index -= 1
      blocks.push({
        kind: 'table',
        headers,
        rows,
      })
      continue
    }

    const listItem = matchListItem(line)
    if (listItem) {
      flushParagraph()
      const items = [listItem]
      while (index + 1 < lines.length) {
        const nextItem = matchListItem(lines[index + 1] ?? '')
        if (!nextItem || nextItem.ordered !== listItem.ordered) {
          break
        }
        items.push(nextItem)
        index += 1
      }
      blocks.push({
        kind: 'list',
        ordered: listItem.ordered,
        items,
      })
      continue
    }

    paragraphLines.push(line)
  }

  flushParagraph()
  return blocks
}

const renderInlineMarkdown = (
  value: string,
  keyPrefix: string,
  filePath: string,
  sessionId: string,
  agentId: string | null,
): ReactNode[] => {
  const pattern =
    /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g
  const parts: ReactNode[] = []
  let lastIndex = 0

  for (const match of value.matchAll(pattern)) {
    const [raw] = match
    const offset = match.index ?? 0
    if (offset > lastIndex) {
      parts.push(<Fragment key={`${keyPrefix}-text-${offset}`}>{value.slice(lastIndex, offset)}</Fragment>)
    }

    if (match[1] !== undefined && match[2] !== undefined) {
      parts.push(
        <MarkdownImage
          key={`${keyPrefix}-image-${offset}`}
          agentId={agentId}
          sessionId={sessionId}
          filePath={filePath}
          alt={match[1]}
          target={match[2]}
        />,
      )
    } else if (match[3] !== undefined && match[4] !== undefined) {
      parts.push(
        <a
          key={`${keyPrefix}-link-${offset}`}
          href={match[4]}
          target="_blank"
          rel="noreferrer"
        >
          {renderInlineMarkdown(match[3], `${keyPrefix}-link-content-${offset}`, filePath, sessionId, agentId)}
        </a>,
      )
    } else if (match[5] !== undefined) {
      parts.push(
        <code key={`${keyPrefix}-code-${offset}`}>{match[5]}</code>,
      )
    } else if (match[6] !== undefined || match[7] !== undefined) {
      const strongText = match[6] ?? match[7] ?? ''
      parts.push(
        <strong key={`${keyPrefix}-strong-${offset}`}>
          {renderInlineMarkdown(strongText, `${keyPrefix}-strong-content-${offset}`, filePath, sessionId, agentId)}
        </strong>,
      )
    } else if (match[8] !== undefined || match[9] !== undefined) {
      const emphasisText = match[8] ?? match[9] ?? ''
      parts.push(
        <em key={`${keyPrefix}-em-${offset}`}>
          {renderInlineMarkdown(emphasisText, `${keyPrefix}-em-content-${offset}`, filePath, sessionId, agentId)}
        </em>,
      )
    }

    lastIndex = offset + raw.length
  }

  if (lastIndex < value.length) {
    parts.push(<Fragment key={`${keyPrefix}-tail`}>{value.slice(lastIndex)}</Fragment>)
  }

  return parts
}

const MarkdownImage = memo(function MarkdownImage({
  agentId,
  sessionId,
  filePath,
  alt,
  target,
}: {
  agentId: string | null
  sessionId: string
  filePath: string
  alt: string
  target: string
}) {
  const resolvedPath = resolveMarkdownRelativeAssetPath(filePath, target)
  const previewQuery = useQuery(
    getSessionFilePreviewContentQueryOptions({
      agentId,
      sessionId,
      path: resolvedPath ?? '',
      enabled: Boolean(resolvedPath),
    }),
  )

  if (!resolvedPath) {
    return <img src={target} alt={alt} loading="lazy" />
  }

  if (previewQuery.data?.file_kind === 'image' && previewQuery.data.content_base64) {
    return (
      <img
        src={`data:${previewQuery.data.mime_type ?? 'application/octet-stream'};base64,${previewQuery.data.content_base64}`}
        alt={alt}
        loading="lazy"
      />
    )
  }

  return (
    <span className="session-file-preview-markdown__image-fallback">
      [{alt || '图片'}: {target}]
    </span>
  )
})

export const SessionFileMarkdownPreview = ({
  agentId,
  sessionId,
  filePath,
  content,
}: SessionFileMarkdownPreviewProps) => {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content])

  return (
    <div className="session-file-preview-markdown">
      {blocks.map((block, blockIndex) => {
        const key = `markdown-block-${blockIndex}`

        if (block.kind === 'heading') {
          const level = Math.min(block.level, 6)
          const HeadingTag = `h${level}` as HeadingTagName
          return (
            <HeadingTag key={key}>
              {renderInlineMarkdown(block.text, key, filePath, sessionId, agentId)}
            </HeadingTag>
          )
        }

        if (block.kind === 'blockquote') {
          return (
            <blockquote key={key}>
              {block.text.split('\n').map((line, lineIndex) => (
                <p key={`${key}-quote-${lineIndex}`}>
                  {renderInlineMarkdown(line, `${key}-quote-${lineIndex}`, filePath, sessionId, agentId)}
                </p>
              ))}
            </blockquote>
          )
        }

        if (block.kind === 'code') {
          return (
            <pre key={key}>
              <code>{block.text}</code>
            </pre>
          )
        }

        if (block.kind === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          return (
            <ListTag key={key}>
              {block.items.map((item, itemIndex) => (
                <li
                  key={`${key}-item-${itemIndex}`}
                  value={block.ordered ? (item.ordinal ?? undefined) : undefined}
                >
                  {item.checked !== null ? (
                    <input
                      type="checkbox"
                      checked={item.checked}
                      readOnly
                      aria-label={item.checked ? '已完成' : '未完成'}
                    />
                  ) : null}
                  {renderInlineMarkdown(item.text, `${key}-item-${itemIndex}`, filePath, sessionId, agentId)}
                </li>
              ))}
            </ListTag>
          )
        }

        if (block.kind === 'table') {
          return (
            <table key={key}>
              <thead>
                <tr>
                  {block.headers.map((header, headerIndex) => (
                    <th key={`${key}-header-${headerIndex}`}>
                      {renderInlineMarkdown(header, `${key}-header-${headerIndex}`, filePath, sessionId, agentId)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`${key}-row-${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`}>
                        {renderInlineMarkdown(cell, `${key}-row-${rowIndex}-cell-${cellIndex}`, filePath, sessionId, agentId)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }

        return (
          <p key={key}>
            {block.text.split('\n').map((line, lineIndex) => (
              <Fragment key={`${key}-line-${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInlineMarkdown(line, `${key}-line-${lineIndex}`, filePath, sessionId, agentId)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
