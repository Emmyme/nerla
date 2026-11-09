// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { shouldIgnoreKey, useTaskShortcuts } from "./useTaskShortcuts"

function ignored(target: Element, init: KeyboardEventInit = {}) {
  let result: boolean | undefined
  const listener = (e: KeyboardEvent) => {
    result = shouldIgnoreKey(e)
  }
  window.addEventListener("keydown", listener)
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, ...init }))
  window.removeEventListener("keydown", listener)
  return result
}

function addDialog(modal: boolean) {
  const dialog = document.body.appendChild(document.createElement("div"))
  dialog.setAttribute("role", "dialog")
  if (modal) dialog.setAttribute("aria-modal", "true")
}

afterEach(() => {
  document.body.replaceChildren()
})

describe("shouldIgnoreKey", () => {
  it("ignores typing targets, modifier keys and open modal dialogs", () => {
    const input = document.body.appendChild(document.createElement("input"))
    expect(ignored(input)).toBe(true)
    const select = document.body.appendChild(document.createElement("button"))
    select.setAttribute("role", "combobox")
    expect(ignored(select)).toBe(true)
    expect(ignored(document.body, { ctrlKey: true })).toBe(true)
    addDialog(true)
    expect(ignored(document.body)).toBe(true)
  })

  it("lets plain keys through, also with a non-modal panel open", () => {
    expect(ignored(document.body)).toBe(false)
    addDialog(false)
    expect(ignored(document.body)).toBe(false)
  })
})

describe("useTaskShortcuts", () => {
  it("moves with arrow keys only inside a task region, while J works anywhere", () => {
    const next = vi.fn()
    renderHook(() => useTaskShortcuts({ next }))
    const press = (target: Element, key: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    const outside = document.body.appendChild(document.createElement("button"))
    const region = document.body.appendChild(document.createElement("div"))
    region.setAttribute("data-task-nav", "")
    const row = region.appendChild(document.createElement("button"))

    expect(press(outside, "ArrowDown")).toBe(true)
    expect(next).not.toHaveBeenCalled()
    press(row, "ArrowDown")
    press(outside, "j")
    expect(next).toHaveBeenCalledTimes(2)
  })
})
