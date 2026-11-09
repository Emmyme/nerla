/** The symbols a project, group chat or folder can show. The website keeps one icon per key. */
export const SYMBOL_KEYS = [
  "heart",
  "archive",
  "bug",
  "butterfly",
  "cloud",
  "code",
  "crown",
  "flask",
  "flower",
  "image",
  "leaf",
  "lightning",
  "brush",
  "sparkle",
] as const

export type SymbolKey = (typeof SYMBOL_KEYS)[number]
