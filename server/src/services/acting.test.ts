import { describe, expect, it, vi } from "vitest"

// The tool modules load with the real tables and no database connection
vi.mock("../db", async () => ({ ...(await import("../db/schema")), db: {} }))
vi.mock("./storage", () => ({}))

import { actAllowed, errorOf } from "./acting"
import { TRASH_TOOLS } from "../utils/aiGate"
import { TOOLS } from "./aiTools"

const ID = "6f1d3c4e-2a7b-4c8d-9e0f-1a2b3c4d5e6f"

describe("actAllowed", () => {
  it("lets the tools reach their own routes", () => {
    expect(actAllowed("POST", "/api/tasks")).toBe(true)
    expect(actAllowed("PUT", `/api/tasks/${ID}`)).toBe(true)
    expect(actAllowed("POST", "/api/projects")).toBe(true)
    expect(actAllowed("POST", "/api/papers")).toBe(true)
    expect(actAllowed("DELETE", `/api/tasks/${ID}`)).toBe(true)
    expect(actAllowed("POST", `/api/calendar/${ID}/restore`)).toBe(true)
    expect(actAllowed("POST", `/api/projects/${ID}/restore`)).toBe(true)
  })

  it("never reaches a delete for good, a folder or a project delete", () => {
    expect(actAllowed("DELETE", `/api/tasks/${ID}/forever`)).toBe(false)
    expect(actAllowed("DELETE", `/api/calendar/${ID}/forever`)).toBe(false)
    expect(actAllowed("DELETE", `/api/files/${ID}/forever`)).toBe(false)
    expect(actAllowed("DELETE", `/api/files/folders/${ID}`)).toBe(false)
    expect(actAllowed("DELETE", `/api/projects/${ID}`)).toBe(false)
    expect(actAllowed("DELETE", `/api/projects/${ID}/forever`)).toBe(false)
  })

  it("refuses everything else", () => {
    expect(actAllowed("PUT", "/api/organizations/x")).toBe(false)
    expect(actAllowed("POST", "/api/ai/tokens")).toBe(false)
    expect(actAllowed("DELETE", "/api/tasks/x")).toBe(false)
    expect(actAllowed("PUT", "/api/users/profile")).toBe(false)
    expect(actAllowed("PUT", `/api/projects/${ID}`)).toBe(false)
    expect(actAllowed("POST", `/api/projects/${ID}/members`)).toBe(false)
    expect(actAllowed("GET", "/api/ai/me/memory")).toBe(false)
    expect(actAllowed("PUT", "/api/ai/me/preferences")).toBe(false)
    expect(actAllowed("DELETE", "/api/ai/me/summary")).toBe(false)
    expect(actAllowed("DELETE", "/api/ai/thread")).toBe(false)
  })
})

describe("TOOLS", () => {
  it("has no delete for good, token, membership or admin tool, and holds every trash change", async () => {
    for (const tool of TOOLS) expect(tool.name).not.toMatch(/forever|purge|empty|token|member|admin/)
    for (const name of TRASH_TOOLS) expect(await TOOLS.find((tool) => tool.name === name)!.alwaysGated!({}, {} as never)).toBe(true)
    const save = TOOLS.find((tool) => tool.name === "save_preference")!
    expect(save.aiOnly).toBe(true)
    expect(await save.alwaysGated!({}, {} as never)).toBe(true)
  })

  it("refuses fields a tool doesn't know", () => {
    const createTask = TOOLS.find((tool) => tool.name === "create_task")!
    expect(createTask.input.safeParse({ title: "Plan" }).success).toBe(true)
    expect(createTask.input.safeParse({ title: "Plan", project_id: "7e4107a0-991c-4011-8f1d-eaabc8039aca" }).success).toBe(false)
  })
})

describe("errorOf", () => {
  it("names the refused fields and hides a server error", () => {
    const body = {
      error: "Invalid input",
      details: { formErrors: [], fieldErrors: { starts_at: ["Use an ISO 8601 time with Z or an offset"] } },
      stack: "x",
    }
    expect(errorOf(400, body)).toBe("Invalid input: starts_at: Use an ISO 8601 time with Z or an offset")
    expect(errorOf(400, { error: "Invalid input", details: { formErrors: ["Unrecognized key: foo"], fieldErrors: {} } })).toBe(
      "Invalid input: Unrecognized key: foo",
    )
    expect(errorOf(404, { error: "Not found" })).toBe("Not found")
    expect(errorOf(500, body)).toBe("Something went wrong")
  })
})
