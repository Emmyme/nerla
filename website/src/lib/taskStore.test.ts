// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { ApiError } from "@/lib/api/request"
import type { Task } from "@/lib/api/tasks"

const updateTask = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/tasks")>()),
  tasksAPI: { updateTask },
}))

import { applyTaskPatch, messageOf, SAVE_FAILED, useTaskList } from "./taskStore"

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    identifier: null,
    number: null,
    project_id: null,
    project: null,
    title: id,
    description: null,
    status: "todo",
    priority: "none",
    assigned_to: null,
    assignee: null,
    created_by: null,
    position: 0,
    due_date: null,
    completed_at: null,
    created_at: "2026-10-23 10:00:00",
    updated_at: "2026-10-23 10:00:00",
    attachments: [],
    ...overrides,
  }
}

describe("applyTaskPatch", () => {
  it("changes only the target task and returns a new array", () => {
    const tasks = [task("a"), task("b")]
    const next = applyTaskPatch(tasks, "b", { status: "done" })
    expect(next).not.toBe(tasks)
    expect(next[0]).toBe(tasks[0])
    expect(next[1]).toEqual({ ...tasks[1], status: "done" })
    expect(tasks[1].status).toBe("todo")
  })
})

describe("useTaskList", () => {
  it("restores the old status at once and shows the server message when a change is rejected", async () => {
    updateTask.mockRejectedValue(new ApiError(400, { error: "Assigned user is not a project member" }))
    let answer: (tasks: Task[]) => void = () => {}
    const load = vi
      .fn<() => Promise<Task[]>>()
      .mockResolvedValueOnce([task("a")])
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const { result } = renderHook(() => useTaskList(load, "mine"))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = result.current.updateTask("a", { status: "done" })
    })
    // The reload after the refusal has not answered, so the old value comes from the store itself
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(result.current.tasks[0].status).toBe("todo")
    expect(result.current.error).toBe("Assigned user is not a project member")

    let resolved: string | null = null
    await act(async () => {
      answer([task("a")])
      resolved = await pending
    })
    expect(resolved).toBe("Assigned user is not a project member")
  })

  it("never lets a reload that answers late bring back an older copy than the one shown", async () => {
    updateTask.mockResolvedValue(task("a", { title: "Renamed", updated_at: "2026-10-23 10:05:00" }))
    let answer: (tasks: Task[]) => void = () => {}
    const load = vi
      .fn<() => Promise<Task[]>>()
      .mockResolvedValueOnce([task("a")])
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const { result } = renderHook(() => useTaskList(load, "mine"))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    let reloading: Promise<void> = Promise.resolve()
    act(() => {
      reloading = result.current.reload()
    })
    await act(async () => {
      await result.current.updateTask("a", { title: "Renamed" })
    })
    await act(async () => {
      answer([task("a")])
      await reloading
    })
    expect(result.current.tasks[0].title).toBe("Renamed")
  })

  it("uses the friendly fallback for server faults and keeps quiet saves off the page error", async () => {
    updateTask.mockRejectedValue(new ApiError(500, { error: "Internal Server Error" }))
    const { result } = renderHook(() => useTaskList(() => Promise.resolve([task("a")]), "mine"))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    let resolved: string | null = null
    await act(async () => {
      resolved = await result.current.updateTask("a", { status: "done" }, { quiet: true })
    })
    expect(resolved).toBe(SAVE_FAILED)
    expect(result.current.error).toBeNull()

    await act(async () => {
      resolved = await result.current.updateTask("a", { status: "done" })
    })
    expect(result.current.error).toBe(SAVE_FAILED)
    expect(messageOf(new ApiError(404, { error: "" }), "fallback")).toBe("fallback")
    expect(messageOf(new TypeError("Failed to fetch"), "fallback")).toBe("fallback")
  })

  it("keeps the optimistic value when a refetch lands while the change is pending", async () => {
    let server = [task("a")]
    let finish: (saved: Task) => void = () => {}
    updateTask.mockReturnValue(new Promise<Task>((resolve) => (finish = resolve)))
    const { result } = renderHook(() => useTaskList(() => Promise.resolve(server), "mine"))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = result.current.updateTask("a", { status: "done" })
    })
    await act(() => result.current.reload())
    expect(result.current.tasks[0].status).toBe("done")

    server = [task("a", { status: "done" })]
    let resolved: string | null = "unset"
    await act(async () => {
      finish(server[0])
      resolved = await pending
    })
    expect(resolved).toBeNull()
    await waitFor(() => expect(result.current.tasks[0].status).toBe("done"))
  })

  it("reloads other lists once after a burst of saves, never the list that saved", async () => {
    updateTask.mockImplementation((id: string, patch: Partial<Task>) => Promise.resolve(task(id, patch)))
    const loadOwn = vi.fn(() => Promise.resolve([task("a")]))
    const loadOther = vi.fn(() => Promise.resolve([task("a")]))
    const own = renderHook(() => useTaskList(loadOwn, "mine"))
    const other = renderHook(() => useTaskList(loadOther, "project"))
    await waitFor(() => expect(own.result.current.status).toBe("ready"))
    await waitFor(() => expect(other.result.current.status).toBe("ready"))

    await act(async () => {
      await own.result.current.updateTask("a", { status: "done" })
      await own.result.current.updateTask("a", { priority: "high" })
    })

    await waitFor(() => expect(loadOther).toHaveBeenCalledTimes(2))
    expect(loadOwn).toHaveBeenCalledTimes(1)
  })

  it("reloads its own list after a reassignment, so a task that left the list goes away", async () => {
    updateTask.mockImplementation((id: string, patch: Partial<Task>) => Promise.resolve(task(id, patch)))
    let server = [task("a"), task("b")]
    const load = vi.fn(() => Promise.resolve(server))
    const { result } = renderHook(() => useTaskList(load, "mine"))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    server = [task("b")]
    await act(async () => {
      await result.current.updateTask("a", { assigned_to: "someone-else" })
    })

    await waitFor(() => expect(result.current.tasks.map((t) => t.id)).toEqual(["b"]))
    expect(load).toHaveBeenCalledTimes(2)
  })
})
