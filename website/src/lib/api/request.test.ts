import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { noticeReadOnly, PROJECT_READ_ONLY_EVENT } from "./request"

const helpers = readFileSync(resolve(__dirname, "../../../../server/src/routes/helpers.ts"), "utf8")
const serverRefusal = helpers.match(/export const READ_ONLY = \{ error: "([^"]+)" \}/)?.[1]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("noticeReadOnly", () => {
  it("recognises the server's read-only refusal text", () => {
    expect(serverRefusal).toBeTruthy()
    const page = new EventTarget()
    const heard = vi.fn()
    page.addEventListener(PROJECT_READ_ONLY_EVENT, heard)
    vi.stubGlobal("window", page)
    noticeReadOnly(403, { error: serverRefusal })
    expect(heard).toHaveBeenCalledOnce()
  })
})
