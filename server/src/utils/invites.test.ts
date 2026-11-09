import { describe, expect, it } from "vitest"
import { inviteBelongsTo, inviteDecision, pendingKind, rejoinsOnSignIn, tokenUsableFor } from "./invites"

const LATER = "2999-01-01T00:00:00.000Z"
const EARLIER = "2000-01-01T00:00:00.000Z"
const removed = { organizationId: null, member: false, passwordSet: true, rejoinUntil: null }
const invitee = { organizationId: "org-a", member: false, passwordSet: false, kind: "invite" }

describe("tokenUsableFor", () => {
  it("lets an invite token set only a first password", () => {
    expect(tokenUsableFor("invite", { kind: "invite", passwordSet: false })).toBe(true)
    expect(tokenUsableFor("invite", { kind: "invite", passwordSet: true })).toBe(false)
    expect(tokenUsableFor("invite", { kind: "reset", passwordSet: false })).toBe(false)
  })

  it("lets a reset token replace only an existing password, and refuses tokens of unknown kind", () => {
    expect(tokenUsableFor("reset", { kind: "reset", passwordSet: true })).toBe(true)
    expect(tokenUsableFor("reset", { kind: "invite", passwordSet: true })).toBe(false)
    expect(tokenUsableFor("reset", { kind: null, passwordSet: true })).toBe(false)
  })
})

describe("inviteBelongsTo", () => {
  it("accepts a pending invite of the same workspace", () => {
    expect(inviteBelongsTo(invitee, "org-a")).toBe(true)
  })

  it("refuses another workspace's invite, a joined account and an account with a password", () => {
    expect(inviteBelongsTo({ ...invitee, organizationId: "org-b" }, "org-a")).toBe(false)
    expect(inviteBelongsTo({ ...invitee, member: true }, "org-a")).toBe(false)
    expect(inviteBelongsTo({ ...invitee, passwordSet: true }, "org-a")).toBe(false)
    expect(inviteBelongsTo({ ...invitee, kind: "reset" }, "org-a")).toBe(false)
  })
})

describe("inviteDecision", () => {
  it("creates an account for a new email", () => {
    expect(inviteDecision(null, "org-a")).toBe("new")
  })

  it("invites a removed account back without a token, and refreshes an expired or own invite back", () => {
    expect(inviteDecision(removed, "org-a")).toBe("rejoin")
    expect(inviteDecision({ ...removed, organizationId: "org-b", rejoinUntil: EARLIER }, "org-a")).toBe("rejoin")
    expect(inviteDecision({ ...removed, organizationId: "org-a", rejoinUntil: LATER }, "org-a")).toBe("rejoin")
  })

  it("refuses a member of any workspace and another workspace's pending invites", () => {
    expect(inviteDecision({ ...removed, organizationId: "org-a", member: true }, "org-a")).toBe("refuse")
    expect(inviteDecision({ ...removed, organizationId: "org-b", rejoinUntil: LATER }, "org-a")).toBe("refuse")
    expect(inviteDecision({ ...removed, passwordSet: false, organizationId: "org-b" }, "org-a")).toBe("refuse")
    expect(inviteDecision({ ...removed, passwordSet: false, organizationId: "org-a" }, "org-a")).toBe("pending")
  })
})

describe("rejoinsOnSignIn", () => {
  it("rejoins while the invite back is open", () => {
    expect(rejoinsOnSignIn({ organizationId: "org-a", member: false, rejoinUntil: LATER })).toBe(true)
  })

  it("ignores an expired or missing invite back and a member", () => {
    expect(rejoinsOnSignIn({ organizationId: "org-a", member: false, rejoinUntil: EARLIER })).toBe(false)
    expect(rejoinsOnSignIn({ organizationId: "org-a", member: false, rejoinUntil: null })).toBe(false)
    expect(rejoinsOnSignIn({ organizationId: "org-a", member: true, rejoinUntil: LATER })).toBe(false)
  })
})

describe("pendingKind", () => {
  const invitedBack = { organizationId: "org-a", member: false, passwordSet: true, rejoinUntil: LATER, kind: null }

  it("lists this workspace's invite links and open invites back", () => {
    expect(pendingKind({ ...invitee, rejoinUntil: null }, "org-a")).toBe("invite")
    expect(pendingKind(invitedBack, "org-a")).toBe("rejoin")
  })

  it("leaves out expired invites back, other workspaces and members", () => {
    expect(pendingKind({ ...invitedBack, rejoinUntil: EARLIER }, "org-a")).toBeNull()
    expect(pendingKind(invitedBack, "org-b")).toBeNull()
    expect(pendingKind({ ...invitedBack, member: true }, "org-a")).toBeNull()
    expect(pendingKind({ ...invitedBack, passwordSet: false }, "org-a")).toBeNull()
  })
})
