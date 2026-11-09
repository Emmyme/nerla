const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g
const LINK = /\[([^\]]+)\]\(([^)\s]*)[^)]*\)/g
const AUTOLINK = /<((?:https?|mailto):[^<>\s]+)>/gi
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g
const TAG = /<\/?[a-z][^<>]*>/gi
/** A paper, board or project in Nerla, which the website opens inside the app */
const NERLA_PATH =
  /^\/(?:(?:paper|board)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|project\/[a-z0-9]+(?:-[a-z0-9]+)*)$/i

export type Made = { name: string; path: string }

/** What a create tool made, from its result's data, when it gives a Nerla path */
export function madeOf(data: unknown): Made | null {
  const { name, path } = (data ?? {}) as { name?: unknown; path?: unknown }
  return typeof name === "string" && typeof path === "string" && NERLA_PATH.test(path) ? { name, path } : null
}

/** A closing that ends a run early, with links to what it made, so the place still gets them */
export function withMade(closing: string, made: Made[]): string {
  if (!made.length) return closing
  const links = made.map((item) => `[${item.name.replace(/[[\]]/g, "")}](${item.path})`)
  return `${closing}\n\nMade so far: ${links.join(", ")}`
}

function domainOf(address: string): string | null {
  try {
    const host = new URL(address).hostname
    return host || null
  } catch {
    return null
  }
}

/** What a reply shows: images never load, links are plain text with their domain unless they open a paper, board or project in Nerla, and HTML is dropped */
export function cleanReply(text: string): string {
  return text
    .replace(IMAGE, "$1")
    .replace(LINK, (_, label: string, address: string) => {
      if (NERLA_PATH.test(address)) return `[${label}](${address})`
      const domain = domainOf(address)
      return domain && domain !== label ? `${label} (${domain})` : label
    })
    .replace(AUTOLINK, "$1")
    .replace(COMMENT, "")
    .replace(TAG, "")
    .trim()
}
