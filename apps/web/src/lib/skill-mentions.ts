import type { CodexCommand, ProjectSkill, SkillScope } from '@panda/protocol'

export type InlineRichToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; value: string }
  | { kind: 'emphasis'; value: string }
  | { kind: 'path-link'; label: string; path: string }
  | { kind: 'skill'; raw: string; name: string }
  | { kind: 'command'; raw: string; name: string }

export type ActiveSkillMention = {
  start: number
  end: number
  query: string
}

export type ActiveSlashCommand = {
  start: number
  end: number
  query: string
}

const INLINE_TOKEN_PATTERN =
  /\[[^\]]+\]\([^)]+\)|`[^`\n]+`|\*\*.+?\*\*|\*[^*\n][^*\n]*\*|\$[A-Za-z0-9._-]+|\/[A-Za-z][A-Za-z0-9._-]*/g
const SKILL_NAME_CHAR_PATTERN = /^[A-Za-z0-9._-]$/
const SLASH_COMMAND_NAME_CHAR_PATTERN = /^[A-Za-z0-9._-]$/

const isWhitespaceCharacter = (value: string) => /\s/.test(value)

const isSkillNameCharacter = (value: string) => SKILL_NAME_CHAR_PATTERN.test(value)
const isSlashCommandNameCharacter = (value: string) =>
  SLASH_COMMAND_NAME_CHAR_PATTERN.test(value)

const normalizeQuery = (value: string) => value.trim().toLowerCase()

const getNameSegments = (value: string) =>
  normalizeQuery(value)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)

const getScopeRank = (scope: SkillScope) => {
  if (scope === 'repo') {
    return 0
  }

  if (scope === 'user') {
    return 1
  }

  return 2
}

export const getSkillScopeLabel = (scope: SkillScope) => {
  if (scope === 'repo') {
    return '项目'
  }

  if (scope === 'user') {
    return '个人'
  }

  return '系统'
}

export const tokenizeInlineRichContent = (value: string): InlineRichToken[] => {
  const tokens: InlineRichToken[] = []
  let lastIndex = 0

  for (const match of value.matchAll(INLINE_TOKEN_PATTERN)) {
    const matchedValue = match[0]
    const matchIndex = match.index ?? 0

    if (matchedValue.startsWith('$')) {
      const previousCharacter = matchIndex > 0 ? value[matchIndex - 1] ?? '' : ''
      if (matchIndex > 0 && !isWhitespaceCharacter(previousCharacter)) {
        continue
      }
    }

    if (matchedValue.startsWith('/')) {
      const previousCharacter = matchIndex > 0 ? value[matchIndex - 1] ?? '' : ''
      if (matchIndex > 0 && !isWhitespaceCharacter(previousCharacter)) {
        continue
      }
    }

    if (matchIndex > lastIndex) {
      tokens.push({
        kind: 'text',
        value: value.slice(lastIndex, matchIndex),
      })
    }

    if (matchedValue.startsWith('`') && matchedValue.endsWith('`')) {
      tokens.push({
        kind: 'code',
        value: matchedValue.slice(1, -1),
      })
    } else if (matchedValue.startsWith('**') && matchedValue.endsWith('**')) {
      tokens.push({
        kind: 'strong',
        value: matchedValue.slice(2, -2),
      })
    } else if (matchedValue.startsWith('*') && matchedValue.endsWith('*')) {
      tokens.push({
        kind: 'emphasis',
        value: matchedValue.slice(1, -1),
      })
    } else if (matchedValue.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(matchedValue)
      if (linkMatch) {
        tokens.push({
          kind: 'path-link',
          label: linkMatch[1] ?? '',
          path: linkMatch[2] ?? '',
        })
      } else {
        tokens.push({
          kind: 'text',
          value: matchedValue,
        })
      }
    } else if (matchedValue.startsWith('/')) {
      tokens.push({
        kind: 'command',
        raw: matchedValue,
        name: matchedValue.slice(1),
      })
    } else {
      tokens.push({
        kind: 'skill',
        raw: matchedValue,
        name: matchedValue.slice(1),
      })
    }

    lastIndex = matchIndex + matchedValue.length
  }

  if (lastIndex < value.length) {
    tokens.push({
      kind: 'text',
      value: value.slice(lastIndex),
    })
  }

  return tokens
}

export const getActiveSkillMention = (
  value: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): ActiveSkillMention | null => {
  if (selectionStart !== selectionEnd) {
    return null
  }

  let tokenStart = selectionStart
  while (tokenStart > 0 && isSkillNameCharacter(value[tokenStart - 1] ?? '')) {
    tokenStart -= 1
  }

  const dollarIndex = tokenStart - 1
  if (dollarIndex < 0 || value[dollarIndex] !== '$') {
    return null
  }

  const previousCharacter = dollarIndex > 0 ? value[dollarIndex - 1] ?? '' : ''
  if (dollarIndex > 0 && !isWhitespaceCharacter(previousCharacter)) {
    return null
  }

  let tokenEnd = selectionStart
  while (tokenEnd < value.length && isSkillNameCharacter(value[tokenEnd] ?? '')) {
    tokenEnd += 1
  }

  return {
    start: dollarIndex,
    end: tokenEnd,
    query: value.slice(dollarIndex + 1, selectionStart),
  }
}

export const replaceActiveSkillMention = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
  skillName: string,
) => {
  const activeMention = getActiveSkillMention(value, selectionStart, selectionEnd)
  if (!activeMention) {
    return null
  }

  const trailingCharacter = value[activeMention.end] ?? ''
  const shouldAddTrailingSpace = trailingCharacter.length === 0
  const insertion = shouldAddTrailingSpace ? `$${skillName} ` : `$${skillName}`
  const nextValue =
    `${value.slice(0, activeMention.start)}${insertion}${value.slice(activeMention.end)}`
  const nextSelection = activeMention.start + insertion.length

  return {
    value: nextValue,
    selectionStart: nextSelection,
    selectionEnd: nextSelection,
  }
}

export const isSlashCommandInput = (value: string) => value.startsWith('/')

export const getActiveSlashCommand = (
  value: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): ActiveSlashCommand | null => {
  if (!isSlashCommandInput(value) || selectionStart !== selectionEnd) {
    return null
  }

  const firstWhitespaceIndex = value.search(/\s/)
  const tokenBoundary = firstWhitespaceIndex < 0 ? value.length : firstWhitespaceIndex
  if (selectionStart > tokenBoundary) {
    return null
  }

  let tokenEnd = 1
  while (tokenEnd < value.length && isSlashCommandNameCharacter(value[tokenEnd] ?? '')) {
    tokenEnd += 1
  }

  if (selectionStart > tokenEnd) {
    return null
  }

  return {
    start: 0,
    end: tokenEnd,
    query: value.slice(1, selectionStart),
  }
}

export const replaceActiveSlashCommand = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
  commandName: string,
) => {
  const activeCommand = getActiveSlashCommand(value, selectionStart, selectionEnd)
  if (!activeCommand) {
    return null
  }

  const trailingCharacter = value[activeCommand.end] ?? ''
  const shouldAddTrailingSpace = trailingCharacter.length === 0
  const insertion = shouldAddTrailingSpace ? `/${commandName} ` : `/${commandName}`
  const nextValue =
    `${value.slice(0, activeCommand.start)}${insertion}${value.slice(activeCommand.end)}`
  const nextSelection = activeCommand.start + insertion.length

  return {
    value: nextValue,
    selectionStart: nextSelection,
    selectionEnd: nextSelection,
  }
}

export const filterProjectSkills = (
  skills: ProjectSkill[],
  query: string,
): ProjectSkill[] => {
  const normalizedQuery = normalizeQuery(query)

  const filteredSkills = skills.filter((skill) => {
    if (!skill.enabled) {
      return false
    }

    if (!normalizedQuery) {
      return true
    }

    const normalizedName = normalizeQuery(skill.name)
    const normalizedDescription = normalizeQuery(skill.description)
    return (
      normalizedName.includes(normalizedQuery) ||
      normalizedDescription.includes(normalizedQuery)
    )
  })

  const getMatchRank = (skill: ProjectSkill) => {
    if (!normalizedQuery) {
      return 0
    }

    const normalizedName = normalizeQuery(skill.name)
    const normalizedDescription = normalizeQuery(skill.description)
    const nameSegments = getNameSegments(skill.name)

    if (normalizedName === normalizedQuery) {
      return 0
    }

    if (nameSegments.some((segment) => segment === normalizedQuery)) {
      return 1
    }

    if (normalizedName.startsWith(normalizedQuery)) {
      return 2
    }

    if (nameSegments.some((segment) => segment.startsWith(normalizedQuery))) {
      return 3
    }

    if (normalizedName.includes(normalizedQuery)) {
      return 4
    }

    if (normalizedDescription.startsWith(normalizedQuery)) {
      return 5
    }

    return 6
  }

  return [...filteredSkills].sort((left, right) => {
    const leftRank = getMatchRank(left)
    const rightRank = getMatchRank(right)
    if (leftRank !== rightRank) {
      return leftRank - rightRank
    }

    const scopeRankDiff = getScopeRank(left.scope) - getScopeRank(right.scope)
    if (scopeRankDiff !== 0) {
      return scopeRankDiff
    }

    const leftName = normalizeQuery(left.name)
    const rightName = normalizeQuery(right.name)
    return leftName.localeCompare(rightName)
  })
}

export const filterCodexCommands = (
  commands: CodexCommand[],
  query: string,
) => {
  const normalizedQuery = normalizeQuery(query)
  const filteredCommands = commands.filter((command) => {
    if (!normalizedQuery) {
      return true
    }

    const normalizedName = normalizeQuery(command.name)
    const normalizedDescription = normalizeQuery(command.description)
    return (
      normalizedName.includes(normalizedQuery) ||
      normalizedDescription.includes(normalizedQuery)
    )
  })

  return [...filteredCommands].sort((left, right) => {
    const leftName = normalizeQuery(left.name)
    const rightName = normalizeQuery(right.name)
    const leftExact = leftName === normalizedQuery ? 0 : leftName.startsWith(normalizedQuery) ? 1 : 2
    const rightExact =
      rightName === normalizedQuery ? 0 : rightName.startsWith(normalizedQuery) ? 1 : 2

    if (leftExact !== rightExact) {
      return leftExact - rightExact
    }

    if (left.availability !== right.availability) {
      return left.availability === 'supported' ? -1 : 1
    }

    return leftName.localeCompare(rightName)
  })
}
