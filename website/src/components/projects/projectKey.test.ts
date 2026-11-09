import { describe, expect, it } from "vitest"
import { formatProjectKey, projectKeyError } from "./projectKey"

describe("project keys", () => {
  it("uppercases as typed, drops other characters and caps at 5", () => {
    expect(formatProjectKey("web")).toBe("WEB")
    expect(formatProjectKey("we-b 2!")).toBe("WEB2")
    expect(formatProjectKey("abcdefg")).toBe("ABCDE")
  })

  it("accepts what the server accepts and leaves empty to the server", () => {
    expect(projectKeyError("")).toBeNull()
    expect(projectKeyError("WR")).toBeNull()
    expect(projectKeyError("WEB12")).toBeNull()
    expect(projectKeyError("W")).not.toBeNull()
    expect(projectKeyError("2WEB")).not.toBeNull()
  })
})
