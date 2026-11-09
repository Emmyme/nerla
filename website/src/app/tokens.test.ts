import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { contrastRatio } from "@/lib/contrast"

const css = readFileSync(resolve(__dirname, "nerla-themes.css"), "utf8")

function parseBlock(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`nerla-themes.css has no ${selector} block`)
  const block = css.slice(css.indexOf("{", start), css.indexOf("}", start))
  const map: Record<string, string> = {}
  for (const m of block.matchAll(/--color-([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) map[m[1]] = m[2]
  return map
}

const parseMode = (mode: "light" | "dark") => parseBlock(`[data-theme="nerla"][data-mode="${mode}"]`)

/** The color of `fg` at `alpha` over `bg`, as a text color modifier draws it */
function blend(fg: string, bg: string, alpha: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(channel(fg, i) * alpha + channel(bg, i) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

describe.each(["light", "dark"] as const)("%s tokens", (mode) => {
  const t = parseMode(mode)

  it("keeps text readable on every surface", () => {
    for (const bg of ["bg", "surface", "sunk"]) {
      expect(contrastRatio(t.text, t[bg])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t["text-muted"], t[bg])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t["berry-text"], t[bg])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t["accent-text"], t[bg])).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrastRatio(t["text-on-accent"], t.accent)).toBeGreaterThanOrEqual(4.5)
  })

  it("keeps input outlines at 3:1 on the card and the page", () => {
    for (const bg of ["surface", "bg", "sunk"]) expect(contrastRatio(t.input, t[bg])).toBeGreaterThanOrEqual(3)
  })

  it("keeps marks visible on the surface", () => {
    for (const mark of ["unread", "berry", "status-todo", "status-progress", "status-done", "status-backlog"])
      expect(contrastRatio(t[mark], t.surface)).toBeGreaterThanOrEqual(3)
  })

  if (mode === "light")
    it("keeps foreground text readable on soft fills", () => {
      for (const p of ["pistachio", "bubblegum", "sky", "lavender", "lemon"])
        expect(contrastRatio(t.text, t[`${p}-soft`])).toBeGreaterThanOrEqual(4.5)
    })

  if (mode === "dark")
    it("keeps columns and the subtle fills neutral charcoal", () => {
      for (const k of ["col-backlog", "col-todo", "col-progress", "col-done", "secondary-subtle", "accent-subtle"]) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(t[k].slice(i, i + 2), 16))
        expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(8)
      }
    })

  if (mode === "dark")
    it("keeps status colors visible on the surface and their column tint", () => {
      for (const [status, col] of [
        ["backlog", "col-backlog"],
        ["todo", "col-todo"],
        ["progress", "col-progress"],
        ["done", "col-done"],
      ]) {
        expect(contrastRatio(t[`status-${status}`], t.surface)).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(t[`status-${status}`], t[col])).toBeGreaterThanOrEqual(3)
      }
    })

  it("keeps badge ink readable on its soft fill, and on the upcoming event fill halfway to the pastel", () => {
    for (const p of ["pistachio", "bubblegum", "sky", "lavender", "lemon"]) {
      expect(contrastRatio(t[`${p}-ink`], t[`${p}-soft`])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t[`${p}-ink`], blend(t[p], t[`${p}-soft`], 0.5))).toBeGreaterThanOrEqual(4.5)
    }
  })

  if (mode === "light")
    it("keeps past event titles readable at 75% ink on sunk", () => {
      for (const p of ["pistachio", "bubblegum", "sky", "lavender", "lemon"])
        expect(contrastRatio(blend(t[`${p}-ink`], t.sunk, 0.75), t.sunk)).toBeGreaterThanOrEqual(4.5)
    })

  it("keeps event ink readable on the main pastels, and past event pastels readable on sunk in dark", () => {
    for (const p of ["pistachio", "bubblegum", "sky", "lavender", "lemon"]) {
      expect(contrastRatio(t[`${p}-ink`], t[p])).toBeGreaterThanOrEqual(4.5)
      if (mode === "dark") expect(contrastRatio(t[p], t.sunk)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("keeps text readable on the hover fill and tells it from the selected fill", () => {
    for (const fg of ["text", "text-muted", "accent-text"]) expect(contrastRatio(t[fg], t.hover)).toBeGreaterThanOrEqual(4.5)
    expect(t.hover).not.toBe(t.sunk)
    expect(contrastRatio(t.selected, t.hover)).toBeGreaterThanOrEqual(1.08)
  })

  if (mode === "light")
    it("keeps the strong steps visible as marks on the surface, with ink readable on them", () => {
      for (const p of ["pistachio", "sky", "lavender"]) {
        expect(contrastRatio(t[`${p}-strong`], t.surface)).toBeGreaterThanOrEqual(1.4)
        expect(contrastRatio(t[`${p}-ink`], t[`${p}-strong`])).toBeGreaterThanOrEqual(4.5)
      }
    })

  it("raises muted text to 7:1 and hairlines and field edges to 3:1 when more contrast is on", () => {
    const more = { ...t, ...parseBlock(`[data-contrast="more"][data-theme="nerla"][data-mode="${mode}"]`) }
    for (const bg of ["bg", "surface", "sunk"]) {
      for (const fg of ["text", "text-muted"]) expect(contrastRatio(more[fg], more[bg])).toBeGreaterThanOrEqual(7)
      for (const edge of ["border", "input"]) expect(contrastRatio(more[edge], more[bg])).toBeGreaterThanOrEqual(3)
      for (const fg of ["berry-text", "accent-text"]) expect(contrastRatio(more[fg], more[bg])).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe("theme file", () => {
  it("has no gradients or pixel units", () => {
    expect(css).not.toMatch(/gradient/i)
    expect(css).not.toMatch(/\dpx/)
  })
})
