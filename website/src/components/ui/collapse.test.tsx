import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { Collapse } from "./collapse"

describe("Collapse", () => {
  it("hides closed content from focus and the accessibility tree, and shows it again on open", () => {
    const { rerender } = render(
      <Collapse open>
        <button type="button">Inside</button>
      </Collapse>,
    )
    expect(screen.getByRole("button", { name: "Inside" })).toBeVisible()

    rerender(
      <Collapse open={false}>
        <button type="button">Inside</button>
      </Collapse>,
    )
    expect(screen.queryByRole("button", { name: "Inside" })).toBeNull()
    expect(screen.getByText("Inside").closest(".motion-collapse")).toHaveProperty("inert", true)

    rerender(
      <Collapse open>
        <button type="button">Inside</button>
      </Collapse>,
    )
    expect(screen.getByRole("button", { name: "Inside" })).toBeVisible()
  })
})
