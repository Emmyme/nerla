import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import type { Onboarding } from "@/lib/api/users"
import { GettingStarted } from "./GettingStarted"

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock("@/lib/api/users", () => ({ onboardingAPI: api }))

const answer = (states: ("done" | "todo")[]): Onboarding => ({
  welcomeSeen: true,
  checklistDismissed: false,
  tips: [],
  steps: states.map((state, i) => ({ id: i === 0 ? "profile" : "task", state, optional: false })),
})

const show = () =>
  render(
    <MemoryRouter>
      <GettingStarted onNewTask={() => undefined} />
    </MemoryRouter>,
  )

describe("GettingStarted", () => {
  it("is gone once every step is done", async () => {
    api.get.mockResolvedValue(answer(["done", "done"]))
    const { container } = show()
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("counts the steps done and goes for good when dismissed", async () => {
    api.get.mockResolvedValue(answer(["done", "todo"]))
    api.save.mockResolvedValue({ ok: true })
    const { container } = show()
    expect(await screen.findByRole("button", { name: "Getting started 1 of 2" })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }))
    expect(api.save).toHaveBeenCalledWith({ checklistDismissed: true })
    expect(container).toBeEmptyDOMElement()
  })
})
