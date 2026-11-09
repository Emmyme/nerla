import { describe, it, expect, vi } from "vitest"
import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import BaseModal from "./BaseModal"

describe("BaseModal", () => {
  it("is a dialog named by its title and closes on Escape", async () => {
    const onClose = vi.fn()
    render(
      <BaseModal isOpen onClose={onClose} title="Join meeting">
        <input aria-label="Meeting id" />
      </BaseModal>,
    )
    expect(screen.getByRole("dialog", { name: "Join meeting" })).toBeInTheDocument()
    await userEvent.setup().keyboard("{Escape}")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("returns focus to the element that opened it", async () => {
    function Opener() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Join
          </button>
          <BaseModal isOpen={open} onClose={() => setOpen(false)} title="Join meeting">
            <input aria-label="Meeting id" autoFocus />
          </BaseModal>
        </>
      )
    }
    render(<Opener />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Join" }))
    expect(screen.getByLabelText("Meeting id")).toHaveFocus()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.getByRole("button", { name: "Join" })).toHaveFocus())
  })
})
