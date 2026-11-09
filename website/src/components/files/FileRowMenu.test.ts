import { describe, expect, it } from "vitest"
import type { FileAction, FileItem } from "@/lib/api/files"
import { menuEntries, type FileActions, type RowItem } from "./FileRowMenu"

const file = (can: FileAction[], overrides: Partial<FileItem> = {}): RowItem => ({
  kind: "file",
  item: {
    id: "f1",
    name: "photo.png",
    size: 10,
    mimeType: "image/png",
    kind: "image",
    docType: null,
    altText: null,
    owner: { id: "u1", name: "Ann", avatarUrl: null },
    projectId: null,
    folderId: null,
    updatedAt: "2026-10-24 10:00:00",
    deletedAt: null,
    removalDeadline: null,
    context: null,
    can,
    ...overrides,
  },
})

const noop = () => {}
const actions: FileActions = { open: noop, download: noop, rename: noop, move: noop, copy: noop, describe: noop, trash: noop }
const admin: FileActions = { ...actions, onShare: noop, onLink: noop, onManageLinks: noop, onDeleteForGood: noop }
const labels = (row: RowItem, given = actions) => menuEntries(row, given).map((entry) => entry.label)

describe("the file row menu", () => {
  it("offers only what the file's rights allow", () => {
    expect(labels(file(["view"]))).toEqual(["Open", "Download"])
    expect(labels(file(["view", "rename", "move", "copy", "editAlt", "trash"]))).toEqual([
      "Open",
      "Download",
      "Rename…",
      "Move…",
      "Save to my files",
      "Description…",
      "Delete",
    ])
    expect(labels(file(["view", "editAlt"], { mimeType: "application/pdf", name: "plan.pdf", kind: "pdf" }))).toEqual(["Open", "Download"])
    expect(labels(file(["view"], { docType: "paper", mimeType: "application/x-nerla-paper", name: "Plan" }))).toEqual(["Open"])
  })

  it("shows Share and Get link only with the right and a page that handles them", () => {
    expect(labels(file(["view", "share", "link"]))).toEqual(["Open", "Download"])
    expect(labels(file(["view", "share", "link"]), { ...actions, onShare: noop, onLink: noop })).toEqual([
      "Open",
      "Download",
      "Share…",
      "Get link…",
    ])
  })

  it("gives a workspace admin Links and Delete forever only where their own rights stop", () => {
    expect(labels(file(["view"]), admin)).toEqual(["Open", "Download", "Links…", "Delete forever…"])
    expect(labels(file(["view", "link", "trash"]), admin)).toEqual(["Open", "Download", "Get link…", "Delete"])
  })
})
