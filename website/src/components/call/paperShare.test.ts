import { describe, expect, it, vi } from "vitest"
import { GuestDocTokens, meetingNotes, paperMessage, readPaperMessage } from "./paperShare"

const SHARE = "0b6f3a52-6d0e-4f43-9d77-2f1c1a8f4b10"

describe("paper messages", () => {
  it("reads back a share id and ignores anything else", () => {
    expect(readPaperMessage(paperMessage(SHARE))).toEqual({ shareId: SHARE })
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(readPaperMessage(bytes("not json"))).toBeNull()
    expect(readPaperMessage(bytes(JSON.stringify({ shareId: "../files" })))).toBeNull()
    expect(readPaperMessage(bytes(JSON.stringify({ id: SHARE })))).toBeNull()
  })
})

describe("meetingNotes", () => {
  it("lays out the title, date, people and the three sections", () => {
    const content = meetingNotes("Design review", new Date(2026, 9, 28), [
      { id: "u1", name: "Ann Berg" },
      { id: null, name: "Gail (Guest)" },
    ])
    expect(content[0]).toEqual({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Design review" }] })
    expect(content[1]).toEqual({ type: "paragraph", content: [{ type: "text", text: "28 October 2026" }] })
    expect(content[2].content).toEqual([
      { type: "mention", attrs: { id: "u1", label: "Ann Berg" } },
      { type: "text", text: ", Gail (Guest)" },
    ])
    const headings = content.filter((node) => node.type === "heading" && node.attrs?.level === 2).map((node) => node.content?.[0].text)
    expect(headings).toEqual(["Agenda", "Notes", "Action items"])
    expect(content.at(-1)?.type).toBe("taskList")
  })
})

describe("GuestDocTokens", () => {
  it("keeps a token while more than five minutes are left and fetches a new one after", async () => {
    let now = 0
    const fetch = vi.fn(async () => ({ token: `t${fetch.mock.calls.length}`, expiresAt: new Date(now + 10 * 60_000).toISOString() }))
    const tokens = new GuestDocTokens(fetch, () => now)
    expect(await tokens.get(SHARE)).toBe("t1")
    now = 4 * 60_000
    expect(await tokens.get(SHARE)).toBe("t1")
    now = 5 * 60_000 + 1
    expect(await tokens.get(SHARE)).toBe("t2")
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("shares one refresh between callers who ask at once", async () => {
    let now = 0
    const fetch = vi.fn(async () => ({ token: `t${fetch.mock.calls.length}`, expiresAt: new Date(now + 10 * 60_000).toISOString() }))
    const tokens = new GuestDocTokens(fetch, () => now)
    await tokens.get(SHARE)
    now = 6 * 60_000
    expect(await Promise.all([tokens.get(SHARE), tokens.get(SHARE), tokens.get(SHARE)])).toEqual(["t2", "t2", "t2"])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
