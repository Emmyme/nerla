// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { ApiError } from "@/lib/api/request"
import type { FileItem, FileListing } from "@/lib/api/files"

const browse = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/files")>()),
  fileBrowserAPI: { browse, search: vi.fn() },
}))

import { useFiles, type FilePlace } from "./useFiles"

const listing = (...names: string[]): FileListing => ({
  folders: [],
  files: names.map((name) => ({ id: name, name, can: ["view"] }) as unknown as FileItem),
  usage: { used: 0, cap: null },
  nextCursor: null,
})
const names = (files: FileItem[]) => files.map((file) => file.name)
const options = { sort: "name" as const, dir: "asc" as const }
const mine: FilePlace = { section: "mine" }
const shared: FilePlace = { section: "shared" }

beforeEach(() => browse.mockReset())

describe("useFiles", () => {
  it("shows only the place opened last, however late the one before answers", async () => {
    let answerMine: (value: FileListing) => void = () => {}
    browse.mockImplementationOnce(() => new Promise((resolve) => (answerMine = resolve))).mockResolvedValueOnce(listing("shared.pdf"))
    const { result, rerender } = renderHook(({ place }) => useFiles(place, options), { initialProps: { place: mine } })
    const firstSignal: AbortSignal = browse.mock.calls[0][1]

    rerender({ place: shared })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(firstSignal.aborted).toBe(true)
    await act(async () => answerMine(listing("mine.pdf")))
    expect(names(result.current.files)).toEqual(["shared.pdf"])
  })

  it("keeps the rows when a refresh fails and says why, and reads a gone folder as missing", async () => {
    browse
      .mockResolvedValueOnce(listing("plan.pdf"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new ApiError(404, { error: "Folder not found" }))
    const { result, rerender } = renderHook(({ place }) => useFiles(place, options), { initialProps: { place: mine } })
    await waitFor(() => expect(result.current.status).toBe("ready"))

    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBe("Couldn't load files. Check your connection and try again."))
    expect(result.current.status).toBe("ready")
    expect(names(result.current.files)).toEqual(["plan.pdf"])

    rerender({ place: { section: "mine", folderId: "gone" } })
    await waitFor(() => expect(result.current.status).toBe("missing"))
    expect(result.current.files).toEqual([])
  })

  it("drops a next page that answers after a refresh moved the cursor, so no row shows twice", async () => {
    let answerMore: (value: FileListing) => void = () => {}
    browse
      .mockResolvedValueOnce({ ...listing("a.pdf", "b.pdf"), nextCursor: "after-b" })
      .mockImplementationOnce(() => new Promise((resolve) => (answerMore = resolve)))
      .mockResolvedValueOnce({ ...listing("a.pdf", "b.pdf", "c.pdf"), nextCursor: "after-c" })
    const { result } = renderHook(() => useFiles(mine, options))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    act(() => result.current.loadMore())
    act(() => result.current.refresh())
    await waitFor(() => expect(names(result.current.files)).toEqual(["a.pdf", "b.pdf", "c.pdf"]))
    await act(async () => answerMore(listing("c.pdf", "d.pdf")))
    expect(names(result.current.files)).toEqual(["a.pdf", "b.pdf", "c.pdf"])
    expect(result.current.loadingMore).toBe(false)
    expect(result.current.hasMore).toBe(true)
  })
})
