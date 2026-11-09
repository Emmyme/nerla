import { Database } from "@hocuspocus/extension-database"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { createDoc } from "./docs"
import { collab } from "./collab"
import { makeUser, makeWorkspace } from "../test/factories"

describe("storing a paper", () => {
  it("keeps the edits of two copies that went apart", async () => {
    const { orgId } = await makeWorkspace()
    const userId = await makeUser(orgId)
    const fileId = await createDoc({ userId, organizationId: orgId, isOrgAdmin: false }, "paper", { projectId: null, folderId: null })
    const database = collab().configuration.extensions.find((extension) => extension instanceof Database) as Database
    const documentName = `doc:${fileId}`
    const context = { organizationId: orgId, userId }
    // Two servers each load the paper, then each store their own edit
    const load = async () => {
      const document = new Y.Doc()
      await database.onLoadDocument({ documentName, document, context } as never)
      return document
    }
    const a = await load()
    const b = await load()
    a.getText("t").insert(0, "from a ")
    b.getText("t").insert(0, "from b ")
    await database.onStoreDocument({ documentName, document: a, lastContext: context } as never)
    await database.onStoreDocument({ documentName, document: b, lastContext: context } as never)
    const text = (await load()).getText("t").toString()
    expect(text).toContain("from a ")
    expect(text).toContain("from b ")
  })
})
