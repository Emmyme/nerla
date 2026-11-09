import {
  Archive,
  Bug,
  Butterfly,
  Cloud,
  Code,
  CrownSimple,
  Flask,
  Flower,
  Heart,
  Image,
  Leaf,
  Lightning,
  PaintBrush,
  Sparkle,
  type IconComponent,
} from "@/components/icons"

/** Kept in step with SYMBOL_KEYS on the server, which a test checks */
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

type SymbolEntry = { key: SymbolKey; label: string; Icon: IconComponent }

const ICONS: Record<SymbolKey, [string, IconComponent]> = {
  heart: ["Heart", Heart],
  archive: ["Archive", Archive],
  bug: ["Bug", Bug],
  butterfly: ["Butterfly", Butterfly],
  cloud: ["Cloud", Cloud],
  code: ["Code", Code],
  crown: ["Crown", CrownSimple],
  flask: ["Flask", Flask],
  flower: ["Flower", Flower],
  image: ["Image", Image],
  leaf: ["Leaf", Leaf],
  lightning: ["Lightning", Lightning],
  brush: ["Paint brush", PaintBrush],
  sparkle: ["Sparkle", Sparkle],
}

export const SYMBOLS: SymbolEntry[] = SYMBOL_KEYS.map((key) => ({ key, label: ICONS[key][0], Icon: ICONS[key][1] }))

const BY_KEY = new Map(SYMBOLS.map((entry) => [entry.key as string, entry]))

/** The entry for a stored value, or undefined for null and for keys this build does not know */
export const symbolFor = (key: string | null | undefined): SymbolEntry | undefined => (key ? BY_KEY.get(key) : undefined)
