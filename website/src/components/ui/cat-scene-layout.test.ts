import { describe, expect, it } from "vitest"
import { catBox, LAYOUT, LOGO_H, LOGO_W, REACTION, REACTION_EXTRAS, SCENE_MARGIN } from "./cat-scene-layout"

describe("cat scene layout", () => {
  it("turns the cat's box with its tilt", () => {
    const box = catBox({ x: 0, y: 0, width: 552, rotate: 90 }, false)
    expect(box.maxX - box.minX).toBeCloseTo(510)
    expect(box.maxY - box.minY).toBeCloseTo(552)
  })

  it.each(Object.entries(LAYOUT))("keeps %s inside its viewBox with room on every side", (_, { content, view }) => {
    const margin = SCENE_MARGIN - 0.001
    const w = content.maxX - content.minX
    const h = content.maxY - content.minY
    expect(content.minX - view.x).toBeGreaterThanOrEqual(w * margin)
    expect(view.x + view.width - content.maxX).toBeGreaterThanOrEqual(w * margin)
    expect(content.minY - view.y).toBeGreaterThanOrEqual(h * margin)
    expect(view.y + view.height - content.maxY).toBeGreaterThanOrEqual(h * margin)
  })

  it("frames reaction cats like the logo image in a square, with extras that barely leave it", () => {
    const { view } = REACTION
    expect(view).toEqual({ x: 0, y: (LOGO_H - LOGO_W) / 2, width: LOGO_W, height: LOGO_W })
    const slack = view.width * 0.05
    for (const box of Object.values(REACTION_EXTRAS)) {
      expect(box.minX).toBeGreaterThanOrEqual(view.x - slack)
      expect(box.minY).toBeGreaterThanOrEqual(view.y - slack)
      expect(box.maxX).toBeLessThanOrEqual(view.x + view.width + slack)
      expect(box.maxY).toBeLessThanOrEqual(view.y + view.height + slack)
    }
  })
})
