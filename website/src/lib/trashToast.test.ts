import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/request"

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const restore = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/api/trash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/trash")>()),
  trashAPI: { restore },
}))

import { movedToTrash } from "./trashToast"

const undo = () => toast.success.mock.calls.at(-1)![1].action.onClick()
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => vi.resetAllMocks())

describe("Undo after a move to the trash", () => {
  it("restores exactly the entry the delete made, once however often it is clicked", async () => {
    const restored = { kind: "event" as const, event: { id: "e1" } }
    restore.mockResolvedValue(restored)
    const onRestored = vi.fn()
    movedToTrash("Event moved to the trash", { kind: "event", id: "e1" }, onRestored)
    expect(toast.success.mock.calls[0][1].action.label).toBe("Undo")

    undo()
    undo()
    await settle()
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith({ kind: "event", id: "e1" })
    expect(onRestored).toHaveBeenCalledWith(restored)
  })

  it("says why when the item can't come back, and where it still can", async () => {
    restore.mockRejectedValueOnce(new ApiError(409, { error: "Restore the project first" })).mockRejectedValueOnce(new TypeError("offline"))
    const onRestored = vi.fn()
    movedToTrash("Task moved to the trash", { kind: "task", id: "t1" }, onRestored)
    undo()
    movedToTrash("Event moved to the trash", { kind: "event", id: "e1" }, onRestored)
    undo()
    await settle()
    expect(toast.error.mock.calls.map(([text]) => text)).toEqual([
      "Restore the project first",
      "Couldn't bring it back. You can still restore it from the trash.",
    ])
    expect(onRestored).not.toHaveBeenCalled()
  })
})
