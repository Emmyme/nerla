import { describe, expect, it } from "vitest"
import { groupChatUpdateBodySchema } from "../validation/schemas"
import { mayServePicture, styleRefusal } from "./groupPicture"

const FILE = "6a1f0c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b"
const OTHER = "7b2a1d2f-3c4e-4f60-9bac-1d2e3f4a5b6c"

describe("group pictures", () => {
  it("are set by a group's admins only, never in a project chat, and never together with a symbol", () => {
    expect(styleRefusal(null)?.status).toBe(403)
    expect(styleRefusal({ role: "member", chat: { projectId: null } })?.status).toBe(403)
    expect(styleRefusal({ role: "admin", chat: { projectId: OTHER } })?.status).toBe(409)
    expect(styleRefusal({ role: "admin", chat: { projectId: null } })).toBeNull()
    expect(groupChatUpdateBodySchema.safeParse({ avatar_file_id: FILE }).success).toBe(true)
    expect(groupChatUpdateBodySchema.safeParse({ avatar_file_id: null }).success).toBe(true)
    expect(groupChatUpdateBodySchema.safeParse({ icon: "flower", avatar_file_id: FILE }).success).toBe(false)
  })

  it("are served to members of the group only, and only the group's current picture", () => {
    const member = { role: "member", chat: { projectId: null } }
    expect(mayServePicture(member, FILE, FILE)).toBe(true)
    expect(mayServePicture(null, FILE, FILE)).toBe(false)
    expect(mayServePicture(member, FILE, OTHER)).toBe(false)
    expect(mayServePicture(member, null, FILE)).toBe(false)
  })
})
