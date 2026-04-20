const consumeTaggedBlock = (input: string, tagName: string) => {
  if (!input.startsWith(`<${tagName}>`)) {
    return null
  }

  const closingTag = `</${tagName}>`
  const closingIndex = input.indexOf(closingTag)
  if (closingIndex < 0) {
    return ''
  }

  return input.slice(closingIndex + closingTag.length).trimStart()
}

export const stripInjectedUserText = (value: string) => {
  let next = value.trimStart()

  while (next) {
    const strippedUserInstructions = consumeTaggedBlock(next, 'user_instructions')
    if (strippedUserInstructions !== null) {
      next = strippedUserInstructions
      continue
    }

    const strippedEnvironmentContext = consumeTaggedBlock(next, 'environment_context')
    if (strippedEnvironmentContext !== null) {
      next = strippedEnvironmentContext
      continue
    }

    const strippedTurnAborted = consumeTaggedBlock(next, 'turn_aborted')
    if (strippedTurnAborted !== null) {
      next = strippedTurnAborted
      continue
    }

    if (/^# AGENTS?\.md instructions for /u.test(next)) {
      return ''
    }

    break
  }

  return next.trim()
}

export const isInjectedUserText = (value: string) =>
  stripInjectedUserText(value).length === 0
