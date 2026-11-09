import { describe, expect, it } from "vitest"
import { cleanReply, madeOf, withMade } from "./aiReply"

describe("cleanReply", () => {
  it("never loads an image, shows a link's domain and drops HTML", () => {
    expect(cleanReply("![cat](http://x/y.png)")).toBe("cat")
    expect(cleanReply("[docs](https://example.com/a)")).toBe("docs (example.com)")
    expect(cleanReply("<img src=x>hi")).toBe("hi")
  })

  it("keeps a link to a paper or board in Nerla", () => {
    const path = "/board/6f1d3c4e-2a7b-4c8d-9e0f-1a2b3c4d5e6f"
    expect(cleanReply(`See [Brainstorm](${path})`)).toBe(`See [Brainstorm](${path})`)
    expect(cleanReply(`[Brainstorm](https://e.com${path})`)).toBe("Brainstorm (e.com)")
    expect(cleanReply("[Website](/project/website-relaunch)")).toBe("[Website](/project/website-relaunch)")
  })

  it("links what a run made when it closes early", () => {
    const made = madeOf({ id: "x", name: "Brainstorm", kind: "board", path: "/board/6f1d3c4e-2a7b-4c8d-9e0f-1a2b3c4d5e6f" })
    expect(withMade("I stopped.", made ? [made] : [])).toBe(
      "I stopped.\n\nMade so far: [Brainstorm](/board/6f1d3c4e-2a7b-4c8d-9e0f-1a2b3c4d5e6f)",
    )
    expect(madeOf({ name: "Elsewhere", path: "https://e.com/board/x" })).toBeNull()
  })

  it("keeps text after a lone angle bracket", () => {
    const text = "Use count<limit here.\n\nSecond paragraph stays?"
    expect(cleanReply(text)).toBe(text)
  })
})
