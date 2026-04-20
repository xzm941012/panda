const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value == null || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const areArraysStructurallyEqual = (current: unknown[], next: unknown[]) => {
  if (current.length !== next.length) {
    return false
  }

  for (let index = 0; index < current.length; index += 1) {
    if (!areStructurallyEqual(current[index], next[index])) {
      return false
    }
  }

  return true
}

export const areStructurallyEqual = (current: unknown, next: unknown): boolean => {
  if (Object.is(current, next)) {
    return true
  }

  if (Array.isArray(current) && Array.isArray(next)) {
    return areArraysStructurallyEqual(current, next)
  }

  if (isPlainObject(current) && isPlainObject(next)) {
    const currentKeys = Object.keys(current)
    const nextKeys = Object.keys(next)
    if (currentKeys.length !== nextKeys.length) {
      return false
    }

    for (const key of currentKeys) {
      if (!(key in next)) {
        return false
      }

      if (!areStructurallyEqual(current[key], next[key])) {
        return false
      }
    }

    return true
  }

  return false
}

export const reuseStructurallyEqualValue = <T>(
  current: T | undefined,
  next: T,
): T => (current !== undefined && areStructurallyEqual(current, next) ? current : next)

export const mergeEntityArrayByKey = <T>(
  current: T[] | undefined,
  next: T[],
  readKey: (item: T) => string,
) => {
  if (!current || current.length === 0) {
    return next
  }

  const currentByKey = new Map(current.map((item) => [readKey(item), item]))
  const merged = next.map((item) =>
    reuseStructurallyEqualValue(currentByKey.get(readKey(item)), item),
  )

  if (
    current.length === merged.length &&
    current.every((item, index) => item === merged[index])
  ) {
    return current
  }

  return merged
}

