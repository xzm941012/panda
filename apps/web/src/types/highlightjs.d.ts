declare module 'highlight.js/lib/core' {
  const hljs: {
    registerLanguage: (name: string, language: unknown) => void
    highlight: (
      value: string,
      options: { language: string; ignoreIllegals?: boolean },
    ) => { value: string }
  }

  export default hljs
}

declare module 'highlight.js/lib/languages/css' {
  const language: unknown
  export default language
}

declare module 'highlight.js/lib/languages/javascript' {
  const language: unknown
  export default language
}

declare module 'highlight.js/lib/languages/json' {
  const language: unknown
  export default language
}

declare module 'highlight.js/lib/languages/markdown' {
  const language: unknown
  export default language
}

declare module 'highlight.js/lib/languages/typescript' {
  const language: unknown
  export default language
}

declare module 'highlight.js/lib/languages/xml' {
  const language: unknown
  export default language
}
