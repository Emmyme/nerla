import { describe, expect, it } from "vitest"
import { canSeeComments, capLevel, docLevel, docPath, isDocPath, keptAfterCall, levelBelow, type DocLevel, type DocType } from "./docAccess"
import type { FileFacts, ViewerFacts } from "./fileAccess"
import { DAY_MS } from "./eventTime"

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

const doc = (facts: Partial<FileFacts> = {}): FileFacts & { docType: DocType } => ({
  organizationId: "org-a",
  ownerId: "owner",
  ownerRemovedAt: null,
  projectId: null,
  kind: "file",
  isDraft: false,
  deletedAt: null,
  docType: "paper",
  ...facts,
})

type DocViewer = ViewerFacts & { grantLevel: DocLevel | null; callLevel: DocLevel | null }

const viewer = (facts: Partial<DocViewer> = {}): DocViewer => ({
  userId: "other",
  organizationId: "org-a",
  isOrgAdmin: false,
  projectRole: null,
  seesALink: false,
  hasGrant: false,
  grantLevel: null,
  callLevel: null,
  ...facts,
})

const granted = (level: DocLevel) => viewer({ hasGrant: true, grantLevel: level })

describe("docLevel", () => {
  it("gives the owner edit", () => {
    expect(docLevel(doc(), viewer({ userId: "owner" }))).toBe("edit")
  })

  it("gives a project member edit and a workspace admin who only reads the project view", () => {
    const projectDoc = doc({ projectId: "p1" })
    expect(docLevel(projectDoc, viewer({ projectRole: "member" }))).toBe("edit")
    expect(docLevel(projectDoc, viewer({ projectRole: "viewer", isOrgAdmin: true }))).toBe("view")
    expect(docLevel(projectDoc, viewer({ projectRole: "viewer", isOrgAdmin: true, hasGrant: true, grantLevel: "comment" }))).toBe("comment")
  })

  it("gives a grant its level", () => {
    expect(docLevel(doc(), granted("comment"))).toBe("comment")
    expect(docLevel(doc(), granted("edit"))).toBe("edit")
  })

  it("gives a chat post view, raised by a comment grant", () => {
    expect(docLevel(doc(), viewer({ seesALink: true }))).toBe("view")
    expect(docLevel(doc(), viewer({ seesALink: true, hasGrant: true, grantLevel: "comment" }))).toBe("comment")
  })

  it("gives nothing for another user's trashed doc, a removed owner's past the deadline or another workspace", () => {
    expect(docLevel(doc({ deletedAt: daysAgo(1) }), granted("edit"))).toBeNull()
    expect(docLevel(doc({ ownerRemovedAt: daysAgo(31) }), granted("edit"))).toBeNull()
    expect(docLevel(doc({ organizationId: "org-b" }), granted("edit"))).toBeNull()
  })

  it("gives the owner of a trashed doc view", () => {
    expect(docLevel(doc({ deletedAt: daysAgo(1) }), viewer({ userId: "owner" }))).toBe("view")
  })

  it("keeps an open call share's level where the Files rules hide the doc, but never across workspaces", () => {
    expect(docLevel(doc(), viewer({ callLevel: "comment" }))).toBe("comment")
    expect(docLevel(doc({ organizationId: "org-b" }), viewer({ callLevel: "comment" }))).toBeNull()
  })
})

describe("levels", () => {
  it("shows comments from comment level up", () => {
    expect(canSeeComments("view")).toBe(false)
    expect(canSeeComments("comment")).toBe(true)
    expect(canSeeComments("edit")).toBe(true)
    expect(canSeeComments(null)).toBe(false)
  })

  it("tells when a level drops, so an open connection is closed", () => {
    expect(levelBelow("view", "edit")).toBe(true)
    expect(levelBelow("edit", "edit")).toBe(false)
    expect(levelBelow("edit", "comment")).toBe(false)
  })

  it("marks a doc's row so storage never looks for an object behind it", () => {
    expect(isDocPath(docPath("f1"))).toBe(true)
    expect(isDocPath("orgs/o1/attachments/doc:f1")).toBe(false)
  })

  it("caps a request at the user's own level", () => {
    expect(capLevel("edit", "view")).toBe("view")
  })
})

describe("keptAfterCall", () => {
  const member = { isProjectMember: true }

  it("keeps the picked level for a doc made in the call", () => {
    expect(keptAfterCall({ forMeeting: true, level: "edit", openedByOwner: false, projectId: null }, member)).toBe("edit")
  })

  it("keeps view of an existing doc only when its owner showed it", () => {
    expect(keptAfterCall({ forMeeting: false, level: "edit", openedByOwner: true, projectId: null }, member)).toBe("view")
    expect(keptAfterCall({ forMeeting: false, level: "edit", openedByOwner: false, projectId: null }, member)).toBeNull()
  })

  it("keeps a doc made in the call for everyone in it when it sits in no project", () => {
    expect(keptAfterCall({ forMeeting: true, level: "comment", openedByOwner: false, projectId: null }, { isProjectMember: false })).toBe(
      "comment",
    )
  })

  it("gives users outside the project nothing for a project doc", () => {
    const outsider = { isProjectMember: false }
    for (const forMeeting of [true, false]) {
      for (const openedByOwner of [true, false]) {
        expect(keptAfterCall({ forMeeting, level: "edit", openedByOwner, projectId: "p1" }, outsider)).toBeNull()
      }
    }
  })
})
