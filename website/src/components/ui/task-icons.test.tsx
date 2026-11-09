import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { PriorityIcon } from "./priority-icon"
import { StatusIcon } from "./status-icon"

describe("task icons", () => {
  it("draws an unknown status as to do", () => {
    render(<StatusIcon status={"cancelled" as never} />)
    expect(screen.getByRole("img", { name: "To do" })).toBeInTheDocument()
  })

  it("labels the urgent priority icon", () => {
    render(<PriorityIcon priority="urgent" />)
    expect(screen.getByRole("img", { name: "Urgent" })).toBeInTheDocument()
  })
})
