import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AiHeld } from "@/lib/api/ai"
import { HeldCard, heldFields } from "./HeldCard"

const keys = (tool: string, args: Record<string, unknown>) => heldFields(tool, args).map((field) => field.key)

describe("heldFields", () => {
  it("hides only the values the tool's summary names", () => {
    expect(keys("create_task", { title: "Plan", projectId: "p1", assigneeId: "u1", dueDate: "2026-11-01" })).toEqual(["title", "dueDate"])
  })

  it("shows every value of a tool it doesn't know", () => {
    expect(keys("something_new", { projectId: "p1", taskId: "t1", note: "Hi" })).toEqual(["projectId", "taskId", "note"])
  })
})

const card = (overrides: Partial<AiHeld> = {}): AiHeld => ({
  id: "h1",
  kind: "changes",
  requestId: "r1",
  source: "ai",
  tokenName: null,
  place: { kind: "dm" },
  items: [
    { id: "i1", tool: "delete_task", args: { taskId: "t1" }, summary: "Delete WEB-1" },
    { id: "i2", tool: "delete_task", args: { taskId: "t2" }, summary: "Delete WEB-2" },
  ],
  status: "waiting",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...overrides,
})

afterEach(() => vi.useRealTimers())

describe("an Allow card", () => {
  it("runs only the ticked changes, and nothing once none is ticked", async () => {
    const onAnswer = vi.fn(async () => {})
    render(<HeldCard held={card()} onAnswer={onAnswer} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("checkbox", { name: "Delete WEB-2" }))
    expect(screen.getByText("1 of 2 ticked")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Allow" }))
    expect(onAnswer).toHaveBeenCalledWith("allow", ["i1"])

    await user.click(screen.getByRole("checkbox", { name: "Delete WEB-1" }))
    expect(screen.getByRole("button", { name: "Allow" })).toHaveAttribute("aria-disabled", "true")
    await user.click(screen.getByRole("button", { name: "Allow" }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })

  it("sends one answer while it is busy, and says so when the answer didn't go through", async () => {
    let fail: (err: Error) => void = () => {}
    const onAnswer = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)))
    render(<HeldCard held={card()} onAnswer={onAnswer} />)
    const user = userEvent.setup()
    const allow = screen.getByRole("button", { name: "Allow" })
    await user.click(allow)
    await user.click(allow)
    expect(onAnswer).toHaveBeenCalledTimes(1)
    await act(async () => fail(new TypeError("Failed to fetch")))
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't send your answer. Try again.")
  })

  it("stops offering Allow the moment it times out", () => {
    vi.useFakeTimers()
    render(<HeldCard held={card({ expiresAt: new Date(Date.now() + 1000).toISOString() })} onAnswer={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("This request timed out")
  })
})

describe("heldFields", () => {
  it("shows local times as dates, start before end, and leaves anything else exactly as written", () => {
    const fields = heldFields("create_event", { end: "2026-11-05T15:00", start: "2026-11-05T14:30", title: "2026-11-05" })
    expect(fields.map((field) => [field.key, field.value])).toEqual([
      ["start", "Thu 5 Nov 2026 14:30"],
      ["end", "Thu 5 Nov 2026 15:00"],
      ["title", "2026-11-05"],
    ])
    expect(heldFields("create_event", { start: "2026-02-30T14:30" })[0].value).toBe("2026-02-30T14:30")
  })
})
