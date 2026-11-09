import { describe, expect, it } from "vitest"
import { appPath, loadApp } from "./appPath"
import { busyRetryMs, missingRulesMessage, parseLinkedFlow, passwordRules, passwordValid, probeOutcome, withoutToken } from "./authFlow"

describe("parseLinkedFlow", () => {
  it("reads the query from the search", () => {
    expect(parseLinkedFlow("?mode=activate&email=a%40b.se&token=t1", "")).toEqual({ mode: "activate", email: "a@b.se", token: "t1" })
  })

  it("reads the query inside the hash on the desktop build", () => {
    expect(parseLinkedFlow("", "#/sign-in?mode=reset&token=t")).toEqual({ mode: "reset", token: "t" })
  })

  it("ignores an unknown mode", () => {
    expect(parseLinkedFlow("?mode=signup&token=t", "")).toBeNull()
    expect(parseLinkedFlow("", "#/sign-in")).toBeNull()
  })

  it("keeps the mode when the token is missing", () => {
    expect(parseLinkedFlow("?mode=reset", "")).toEqual({ mode: "reset" })
  })

  it("drops only the token from the address", () => {
    expect(withoutToken("http://h/sign-in?mode=activate&email=a%40b.se&token=t1")).toBe("http://h/sign-in?mode=activate&email=a%40b.se")
    expect(withoutToken("http://h/#/sign-in?mode=reset&token=t")).toBe("http://h/#/sign-in?mode=reset")
  })
})

describe("appPath", () => {
  it("puts the route in the hash only on the desktop build", () => {
    expect(appPath("/sign-in", true)).toBe("/#/sign-in")
    expect(appPath("/sign-in", false)).toBe("/sign-in")
  })
})

describe("loadApp", () => {
  const stub = () => {
    const calls: string[] = []
    return {
      calls,
      location: {
        set href(value: string) {
          calls.push(`href ${value}`)
        },
        get href() {
          return ""
        },
        replace: (value: string | URL) => void calls.push(`replace ${value}`),
        reload: () => void calls.push("reload"),
      },
    }
  }

  it("reloads on the desktop build, where only the hash changes", () => {
    const { calls, location } = stub()
    loadApp("/sign-in", true, location)
    expect(calls).toEqual(["replace /#/sign-in", "reload"])
  })

  it("navigates on the web, where the path change loads the page", () => {
    const { calls, location } = stub()
    loadApp("/sign-in", false, location)
    expect(calls).toEqual(["href /sign-in"])
  })
})

describe("passwordRules", () => {
  const met = (pw: string) =>
    passwordRules(pw)
      .filter((rule) => rule.met)
      .map((rule) => rule.id)

  it("accepts exactly 8 characters and refuses 129", () => {
    expect(passwordValid("Abcdef1!")).toBe(true)
    expect(passwordValid(`Ab1!${"x".repeat(125)}`)).toBe(false)
    expect(met(`Ab1!${"x".repeat(125)}`)).not.toContain("length")
    expect(passwordValid(`Ab1!${"x".repeat(124)}`)).toBe(true)
  })

  it("counts a space and non-Latin letters as special, like the server", () => {
    expect(passwordValid("Abcdef 1")).toBe(true)
    expect(met("Abcdefä1")).toContain("special")
    expect(passwordValid("Abcdefä1")).toBe(true)
    expect(passwordValid("Abcdefg1")).toBe(false)
  })

  it("names the rules a submit is still missing", () => {
    expect(missingRulesMessage("abcdefgh")).toBe("Your password still needs an uppercase letter, a number and a special character.")
    expect(missingRulesMessage("Abcdefg1")).toBe("Your password still needs a special character.")
    expect(missingRulesMessage("Abcdef1!")).toBeNull()
  })
})

describe("busy server", () => {
  it("waits for Retry-After, or 10 seconds without one", () => {
    expect(busyRetryMs(429, "30")).toBe(30_000)
    expect(busyRetryMs(429, null)).toBe(10_000)
    expect(busyRetryMs(429, "soon")).toBe(10_000)
    expect(busyRetryMs(429, new Date(65_000).toUTCString(), 5_000)).toBe(60_000)
    expect(busyRetryMs(500, "30")).toBeNull()
  })

  it("treats a 429 probe as reachable, never as a server to reconnect", () => {
    expect(probeOutcome(429, "5", null)).toEqual({ ok: false, busy: true, retryMs: 5_000 })
    expect(probeOutcome(200, null, { needsSetup: false })).toEqual({ ok: true, needsSetup: false })
    expect(probeOutcome(503, null, null)).toEqual({ ok: false, reason: "Server returned HTTP 503" })
    expect(probeOutcome(200, null, {})).toMatchObject({ ok: false, reason: expect.any(String) })
  })
})
