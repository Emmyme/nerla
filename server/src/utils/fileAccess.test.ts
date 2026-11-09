import { describe, expect, it } from "vitest"
import { can, canLinkInto, factsKind, fileRole, removalDeadline, type FileAction, type FileFacts, type ViewerFacts } from "./fileAccess"
import { DAY_MS } from "./eventTime"

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

const file = (facts: Partial<FileFacts> = {}): FileFacts => ({
  organizationId: "org-a",
  ownerId: "owner",
  ownerRemovedAt: null,
  projectId: null,
  kind: "file",
  isDraft: false,
  deletedAt: null,
  ...facts,
})

const viewer = (facts: Partial<ViewerFacts> = {}): ViewerFacts => ({
  userId: "owner",
  organizationId: "org-a",
  isOrgAdmin: false,
  projectRole: null,
  seesALink: false,
  hasGrant: false,
  ...facts,
})

const linkViewer = viewer({ userId: "other", seesALink: true })
const projectFile = file({ projectId: "p1", ownerId: "uploader" })

describe("fileRole", () => {
  it("gives nothing outside the workspace, for avatars and for another user's draft", () => {
    const cases: [FileFacts, ViewerFacts][] = [
      [file({ organizationId: "org-b" }), viewer()],
      [file({ kind: "avatar" }), viewer()],
      [file({ isDraft: true }), linkViewer],
    ]
    for (const [f, v] of cases) {
      expect(fileRole(f, v)).toBeNull()
      expect(can("view", f, v)).toBe(false)
    }
    expect(fileRole(file({ isDraft: true }), viewer())).toBe("owner")
    expect(can("adminDelete", file({ kind: "avatar" }), viewer({ userId: "admin", isOrgAdmin: true }))).toBe(false)
    expect(["avatar", "docimage", "file", "anything"].map(factsKind)).toEqual(["avatar", "docimage", "file", "file"])
  })

  it("hides a user's own file from a user with no link or grant, and shares it with one", () => {
    expect(fileRole(file(), viewer({ userId: "other" }))).toBeNull()
    expect(fileRole(file(), viewer({ userId: "other", hasGrant: true }))).toBe("shared")
    expect(fileRole(projectFile, viewer({ userId: "other" }))).toBeNull()
    expect(fileRole(projectFile, linkViewer)).toBe("shared")
    expect(can("view", file(), linkViewer)).toBe(true)
    expect(can("view", projectFile, linkViewer)).toBe(true)
    expect(can("rename", projectFile, linkViewer)).toBe(false)
  })

  it("keeps a removed owner's own file for link viewers until the deadline", () => {
    expect(fileRole(file({ ownerRemovedAt: daysAgo(1) }), linkViewer)).toBe("shared")
    expect(fileRole(file({ ownerRemovedAt: daysAgo(31) }), linkViewer)).toBeNull()
    expect(fileRole(file({ ownerRemovedAt: daysAgo(1) }), viewer())).toBeNull()
  })
})

describe("can", () => {
  const table = (rows: [FileAction, FileFacts, ViewerFacts, boolean][]) => {
    for (const [action, f, v, expected] of rows) expect(can(action, f, v), `${action} ${JSON.stringify(v)}`).toBe(expected)
  }

  it("opens a trashed file to its owner only", () => {
    const trashed = file({ deletedAt: daysAgo(1) })
    table([
      ["restore", trashed, viewer(), true],
      ["purge", trashed, viewer(), true],
      ["rename", trashed, viewer(), false],
      ["view", trashed, linkViewer, false],
      ["view", file({ ...projectFile, deletedAt: daysAgo(1) }), viewer({ userId: "uploader", projectRole: "member" }), true],
      ["restore", file({ ...projectFile, deletedAt: daysAgo(1) }), viewer({ userId: "uploader" }), false],
      ["restore", file({ ...projectFile, deletedAt: daysAgo(1) }), viewer({ userId: "admin", projectRole: "admin" }), true],
      ["view", file({ ...projectFile, deletedAt: daysAgo(1) }), viewer({ userId: "member", projectRole: "member" }), false],
    ])
  })

  it("purges a live file only when it is the owner's own draft", () => {
    table([
      ["purge", file({ isDraft: true }), viewer(), true],
      ["purge", file({ isDraft: true }), linkViewer, false],
      ["purge", file(), viewer(), false],
      ["purge", file({ ...projectFile, isDraft: true }), viewer({ userId: "uploader", projectRole: "admin" }), false],
    ])
  })

  it("lets the owner and project members rename, move and attach, and the uploader alone edit alt text", () => {
    const member = viewer({ userId: "member", projectRole: "member" })
    table([
      ["rename", file(), viewer(), true],
      ["move", file(), viewer(), true],
      ["rename", file(), linkViewer, false],
      ["move", file(), linkViewer, false],
      ["attach", file(), linkViewer, false],
      ["rename", projectFile, member, true],
      ["editAlt", file(), viewer(), true],
      ["editAlt", projectFile, member, false],
      ["editAlt", projectFile, viewer({ userId: "uploader", projectRole: "member" }), true],
    ])
  })

  it("never shares a project file", () => {
    table([
      ["share", file(), viewer(), true],
      ["share", file(), linkViewer, false],
      ["share", projectFile, viewer({ userId: "uploader", projectRole: "admin" }), false],
    ])
  })

  it("lets only project admins link a project file", () => {
    table([
      ["link", projectFile, viewer({ userId: "admin", projectRole: "admin" }), true],
      ["link", projectFile, viewer({ userId: "member", projectRole: "member" }), false],
    ])
  })

  it("lets the uploader and project admins trash a project file", () => {
    table([
      ["trash", projectFile, viewer({ userId: "uploader", projectRole: "member" }), true],
      ["trash", projectFile, viewer({ userId: "admin", projectRole: "admin" }), true],
      ["trash", projectFile, viewer({ userId: "member", projectRole: "member" }), false],
    ])
  })

  it("copies for viewers who are not the owner", () => {
    table([
      ["copy", file(), viewer(), false],
      ["copy", file(), linkViewer, true],
    ])
  })

  it("lets a workspace admin outside the project view and copy its files, and nothing else", () => {
    const outsider = viewer({ userId: "uploader", isOrgAdmin: true, projectRole: "viewer" })
    expect(fileRole(projectFile, outsider)).toBe("project")
    table([
      ["view", projectFile, outsider, true],
      ["copy", projectFile, outsider, true],
      ...(["rename", "move", "trash", "link", "share", "attach", "editAlt", "purge"] as const).map(
        (action): [FileAction, FileFacts, ViewerFacts, boolean] => [action, projectFile, outsider, false],
      ),
      ["view", file({ ...projectFile, deletedAt: daysAgo(1) }), outsider, false],
      ["restore", file({ ...projectFile, deletedAt: daysAgo(1) }), outsider, false],
    ])
    expect(canLinkInto({ projectId: "p1" }, projectFile, outsider)).toBe(false)
  })

  it("keeps a file posted only in the project chat from a workspace admin outside it, and open to members", () => {
    const chatFile = file({ ...projectFile, chatOnly: true })
    const outsider = viewer({ userId: "admin", isOrgAdmin: true, projectRole: "viewer" })
    expect(fileRole(chatFile, outsider)).toBeNull()
    table([
      ["view", chatFile, outsider, false],
      ["copy", chatFile, outsider, false],
      ["view", chatFile, viewer({ userId: "member", projectRole: "member" }), true],
      ["copy", chatFile, viewer({ userId: "member", projectRole: "member" }), true],
    ])
  })

  it("lets an org admin delete with no other role, and never the owner who is no admin", () => {
    table([
      ["adminDelete", file(), viewer({ userId: "admin", isOrgAdmin: true }), true],
      ["adminDelete", file({ organizationId: "org-b" }), viewer({ userId: "admin", isOrgAdmin: true }), false],
      ["adminDelete", file(), viewer(), false],
    ])
  })

  it("refuses an action it doesn't know, even to the owner", () => {
    expect(can("anything" as FileAction, file(), viewer())).toBe(false)
  })
})

describe("canLinkInto", () => {
  it("keeps a project file inside its project and lets the user's own file go anywhere", () => {
    const member = viewer({ userId: "member", projectRole: "member" })
    expect(canLinkInto({ projectId: "p2" }, projectFile, member)).toBe(false)
    expect(canLinkInto({ projectId: null }, projectFile, member)).toBe(false)
    expect(canLinkInto({ projectId: "p1" }, projectFile, member)).toBe(true)
    for (const projectId of [null, "p1", "p2"]) expect(canLinkInto({ projectId }, file(), viewer())).toBe(true)
  })
})

describe("removalDeadline", () => {
  it("is thirty days after removal", () => {
    expect(removalDeadline("2026-10-01T00:00:00.000Z")).toBe("2026-10-31T00:00:00.000Z")
  })
})
