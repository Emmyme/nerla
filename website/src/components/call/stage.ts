export type StageTile = { key: string; participant: string; source: "camera" | "screen"; publishedAt: number; local?: boolean }

export type StageMode = "grid" | "speaker"

type StageLayout =
  | { kind: "grid"; tiles: StageTile[] }
  | { kind: "focus"; main: StageTile; strip: StageTile[] }
  | { kind: "pair"; main: StageTile; self: StageTile }
  | { kind: "presenting"; share: StageTile; strip: StageTile[] }

export function stageLayout(tiles: StageTile[], opts: { pinned?: string; mode: StageMode; activeSpeaker?: string }): StageLayout {
  const others = (main: StageTile) => tiles.filter((t) => t !== main)
  const focus = (main: StageTile): StageLayout => ({ kind: "focus", main, strip: others(main) })

  const newestShare = tiles.reduce<StageTile | undefined>(
    (best, t) => (t.source === "screen" && (!best || t.publishedAt > best.publishedAt) ? t : best),
    undefined,
  )
  if (newestShare?.local) return { kind: "presenting", share: newestShare, strip: others(newestShare) }
  if (newestShare) return focus(newestShare)

  const pinned = opts.pinned ? tiles.find((t) => t.key === opts.pinned) : undefined
  if (pinned) return focus(pinned)

  const remote = tiles.filter((t) => t.source === "camera" && !t.local)

  // The local tile takes the main spot only when it is alone
  if (opts.mode === "speaker" && tiles.length > 0) {
    return focus(remote.find((t) => t.participant === opts.activeSpeaker) ?? remote[0] ?? tiles[0])
  }

  const self = tiles.find((t) => t.local)
  if (tiles.length === 2 && remote.length === 1 && self) return { kind: "pair", main: remote[0], self }

  return { kind: "grid", tiles }
}

const PAGE_STEPS = [1, 2, 4, 9, 16]

/** How many tiles one grid page holds, phones top out at four */
export function pageSize(count: number, narrow: boolean): number {
  const cap = narrow ? 4 : 16
  return Math.min(cap, PAGE_STEPS.find((step) => step >= count) ?? 16)
}

/** The column count and tile width that make the largest 16:9 tiles fit the box */
export function fitTiles(count: number, width: number, height: number, gap: number): { cols: number; tileWidth: number } {
  let best = { cols: 1, tileWidth: 0 }
  if (count <= 0 || width <= 0 || height <= 0) return best
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const byWidth = (width - gap * (cols - 1)) / cols
    const byHeight = ((height - gap * (rows - 1)) / rows) * (16 / 9)
    const tileWidth = Math.floor(Math.min(byWidth, byHeight))
    if (tileWidth > best.tileWidth) best = { cols, tileWidth }
  }
  return best
}

/** Phones fill the stage instead of keeping 16:9: one column for two tiles, two columns for three or four */
export function fillGrid(count: number): { cols: number; rows: number } {
  const cols = count <= 2 ? 1 : 2
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) }
}
