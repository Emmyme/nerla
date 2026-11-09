export type ProjectSwatchKey =
  "pistachio" | "pistachio-deep" | "bubblegum" | "bubblegum-deep" | "sky" | "sky-deep" | "lavender" | "lavender-deep"

// `legacy` is an older green hex that still reads as pistachio
export const PROJECT_SWATCHES: readonly { key: ProjectSwatchKey; hex: string; legacy?: string }[] = [
  { key: "pistachio", hex: "#D5EDB5", legacy: "#BDF2DC" },
  { key: "pistachio-deep", hex: "#A8D477", legacy: "#7EDDB5" },
  { key: "bubblegum", hex: "#FF9CC8" },
  { key: "bubblegum-deep", hex: "#FF6FAE" },
  { key: "sky", hex: "#BFE3FF" },
  { key: "sky-deep", hex: "#7CC2F7" },
  { key: "lavender", hex: "#DCD0FF" },
  { key: "lavender-deep", hex: "#B39CFF" },
]

function hueAndSaturation(hex: string): { hue: number; sat: number } {
  const h = hex.replace("#", "")
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return { hue: 0, sat: 0 }
  const l = (max + min) / 2
  const sat = d / (1 - Math.abs(2 * l - 1))
  let hue: number
  if (max === r) hue = ((g - b) / d) % 6
  else if (max === g) hue = (b - r) / d + 2
  else hue = (r - g) / d + 4
  return { hue: (hue * 60 + 360) % 360, sat }
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, 360 - d)
}

const LAVENDER = PROJECT_SWATCHES.find((s) => s.key === "lavender")!

const sameHex = (a: string, b: string) => a.replace("#", "").toLowerCase() === b.replace("#", "").toLowerCase()

export function nearestSwatch(hex: string | null | undefined): { key: ProjectSwatchKey; hex: string } {
  if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return LAVENDER
  const exact = PROJECT_SWATCHES.find((swatch) => sameHex(swatch.hex, hex) || (swatch.legacy && sameHex(swatch.legacy, hex)))
  if (exact) return { key: exact.key, hex: exact.hex }
  const { hue, sat } = hueAndSaturation(hex)
  if (sat < 0.15) return LAVENDER
  let best = PROJECT_SWATCHES[0]
  let bestDistance = Infinity
  for (const swatch of PROJECT_SWATCHES) {
    const hues = [swatch.hex, swatch.legacy].filter((h): h is string => !!h).map((h) => hueAndSaturation(h).hue)
    const d = Math.min(...hues.map((h) => hueDistance(hue, h)))
    if (d < bestDistance) {
      best = swatch
      bestDistance = d
    }
  }
  return { key: best.key, hex: best.hex }
}
