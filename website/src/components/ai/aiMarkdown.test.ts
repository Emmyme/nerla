import { describe, expect, it } from "vitest"
import { parseAiMarkdown } from "./aiMarkdown"

describe("parseAiMarkdown", () => {
  it("reads bold and italic runs in a paragraph", () => {
    const [block] = parseAiMarkdown("**a** and *b*")
    expect(block.type).toBe("paragraph")
    if (block.type !== "paragraph") return
    expect(block.runs).toContainEqual({ text: "a", bold: true })
    expect(block.runs).toContainEqual({ text: "b", italic: true })
  })

  it("reads one list with two items", () => {
    const blocks = parseAiMarkdown("- one\n- two")
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe("list")
    if (blocks[0].type !== "list") return
    expect(blocks[0].items).toHaveLength(2)
  })

  it("keeps a link as text with its domain", () => {
    const [block] = parseAiMarkdown("[x](https://e.com)")
    if (block.type !== "paragraph") throw new Error("not a paragraph")
    expect(block.runs.map((run) => run.text).join("")).toContain("x (e.com)")
  })

  it("links a Nerla paper path inside the app", () => {
    const id = "6f1d3c4e-2a7b-4c8d-9e0f-1a2b3c4d5e6f"
    const [inApp] = parseAiMarkdown(`See [Plan](/paper/${id}) and /board/${id}`)
    if (inApp.type !== "paragraph") throw new Error("not a paragraph")
    expect(inApp.runs).toContainEqual({ text: "Plan", href: `/paper/${id}` })
    expect(inApp.runs).toContainEqual({ text: "Open the board", href: `/board/${id}` })
    const [project] = parseAiMarkdown("[Website](/project/website-relaunch)")
    if (project.type !== "paragraph") throw new Error("not a paragraph")
    expect(project.runs).toContainEqual({ text: "Website", href: "/project/website-relaunch" })
    const [outside] = parseAiMarkdown(`[Plan](https://e.com/paper/${id}) https://e.com/paper/${id}`)
    if (outside.type !== "paragraph") throw new Error("not a paragraph")
    expect(outside.runs.every((run) => !run.href)).toBe(true)
    expect(outside.runs.map((run) => run.text).join("")).toContain("Plan (e.com)")
  })
})
