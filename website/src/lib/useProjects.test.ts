// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

const getUserProjects = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/projects")>()),
  projectsAPI: { getUserProjects },
}))

import { notifyProjectsChanged, resetProjectsStore, useProjects } from "./useProjects"

beforeEach(() => {
  resetProjectsStore()
  getUserProjects.mockReset()
  getUserProjects.mockResolvedValue([{ id: "p1", name: "Apollo", slug: "apollo" }])
})

afterEach(() => resetProjectsStore())

describe("useProjects", () => {
  it("shares one fetch between subscribers and refetches on change", async () => {
    const a = renderHook(() => useProjects())
    const b = renderHook(() => useProjects())
    await waitFor(() => expect(a.result.current.status).toBe("ready"))
    expect(b.result.current.projects).toHaveLength(1)
    expect(getUserProjects).toHaveBeenCalledTimes(1)

    getUserProjects.mockResolvedValue([])
    act(() => notifyProjectsChanged())
    await waitFor(() => expect(b.result.current.projects).toHaveLength(0))
    expect(getUserProjects).toHaveBeenCalledTimes(2)
    a.unmount()
    b.unmount()
  })

  it("reports an error status when the fetch fails", async () => {
    getUserProjects.mockRejectedValue(new Error("down"))
    const view = renderHook(() => useProjects())
    await waitFor(() => expect(view.result.current.status).toBe("error"))
    view.unmount()
  })
})
