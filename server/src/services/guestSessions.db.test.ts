import { describe, expect, it, vi } from "vitest"
import * as database from "../db"
import {
  admitGuest,
  cancelGuest,
  createGuestSession,
  getGuestSession,
  guestSecretMatches,
  pendingFor,
  takeGuestToken,
} from "./guestSessions"

describe("pendingFor", () => {
  it("lists only the room's pending, unexpired sessions, oldest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1_000_000)
    const first = await createGuestSession("Ada", "room-a")
    vi.setSystemTime(1_000_500)
    const second = await createGuestSession("Bo", "room-a")
    const admitted = await createGuestSession("Cy", "room-a")
    await createGuestSession("Di", "room-b")
    vi.useRealTimers()

    await admitGuest(admitted.id, "token", "guest-test")

    expect(await pendingFor("room-a", 1_001_000)).toEqual([
      { sessionId: first.id, guestName: "Ada" },
      { sessionId: second.id, guestName: "Bo" },
    ])
    expect(await pendingFor("room-a", 1_000_000 + 10 * 60 * 1000 + 1)).toEqual([{ sessionId: second.id, guestName: "Bo" }])
  })
})

describe("cancelGuest", () => {
  it("takes a waiting guest out of the lobby and leaves resolved sessions alone", async () => {
    const waiting = await createGuestSession("Ada", "room-c")
    const admitted = await createGuestSession("Bo", "room-c")
    await admitGuest(admitted.id, "token", "guest-test")

    expect(await cancelGuest(waiting.id, waiting.secret)).toBe("room-c")
    expect(await pendingFor("room-c")).toEqual([])
    expect(await cancelGuest(waiting.id, waiting.secret)).toBeNull()
    expect(await cancelGuest(admitted.id, admitted.secret)).toBeNull()
    expect((await getGuestSession(admitted.id))?.status).toBe("admitted")
    expect(await cancelGuest("missing", waiting.secret)).toBeNull()
  })
})

describe("takeGuestToken", () => {
  it("hands an admitted guest's token out once", async () => {
    const session = await createGuestSession("Ada", "room-d")
    expect(await takeGuestToken(session.id, session.secret)).toBeNull()
    await admitGuest(session.id, "secret-token", "guest-test")

    expect(await takeGuestToken(session.id, session.secret)).toBe("secret-token")
    expect(await takeGuestToken(session.id, session.secret)).toBeNull()
    expect((await getGuestSession(session.id))?.status).toBe("admitted")
    expect((await getGuestSession(session.id))?.token).toBeNull()
    expect(await takeGuestToken("missing", session.secret)).toBeNull()
  })
})

describe("createGuestSession", () => {
  it("keeps only the name the guest gave, never an email", async () => {
    const session = await getGuestSession((await createGuestSession("Ada", "room-g")).id)
    expect(session?.name).toBe("Ada")
    expect(session).not.toHaveProperty("email")
  })
})

describe("guest secret", () => {
  it("is 32 random bytes the server keeps only as a hash", async () => {
    const a = await createGuestSession("Ada", "room-e")
    const b = await createGuestSession("Bo", "room-e")
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(a.secret).not.toBe(b.secret)
    const stored = await getGuestSession(a.id)
    expect(JSON.stringify(stored)).not.toContain(a.secret)
    expect(stored?.secretHash.toString("hex")).not.toContain(a.secret)
  })

  it("guards the status and cancel paths, so a host who knows the session id gets nothing", async () => {
    const guest = await createGuestSession("Ada", "room-f")
    const other = await createGuestSession("Bo", "room-f")
    await admitGuest(guest.id, "guest-token", "guest-test")

    expect(await guestSecretMatches(guest.id, guest.secret)).toBe(true)
    for (const wrong of [undefined, "", other.secret, guest.secret.slice(1), `${guest.secret}0`, 42])
      expect(await guestSecretMatches(guest.id, wrong)).toBe(false)
    expect(await guestSecretMatches("missing", guest.secret)).toBe(false)

    expect(await takeGuestToken(guest.id, other.secret)).toBeNull()
    expect(await takeGuestToken(guest.id, guest.secret)).toBe("guest-token")

    expect(await cancelGuest(other.id, guest.secret)).toBeNull()
    expect(await pendingFor("room-f")).toEqual([{ sessionId: other.id, guestName: "Bo" }])
    expect(await cancelGuest(other.id, other.secret)).toBe("room-f")
  })
})

it("a waiting guest survives a restart", async () => {
  const guest = await createGuestSession("Ada", "room-h")
  // A fresh copy of the module, as a restarted or second process loads it, on the same database client
  vi.resetModules()
  vi.doMock("../db", () => database)
  const restarted = await import("./guestSessions")
  expect(restarted.getGuestSession).not.toBe(getGuestSession)
  expect(await restarted.pendingFor("room-h")).toEqual([{ sessionId: guest.id, guestName: "Ada" }])
  expect(await restarted.guestSecretMatches(guest.id, guest.secret)).toBe(true)
  expect((await restarted.getGuestSession(guest.id))?.status).toBe("pending")
})
