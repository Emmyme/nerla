import { and, eq, inArray } from "drizzle-orm"
import { db, organizationMembers, users } from "../db"
import { parseMentions } from "../utils/mentions"
import { presenceName } from "../utils/presence"

/** The current names of the users the texts mention who are still in the workspace, in one query */
export async function mentionNames(organizationId: string, texts: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(texts.flatMap((text) => (text ? parseMentions(text) : [])))]
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .innerJoin(organizationMembers, and(eq(organizationMembers.userId, users.id), eq(organizationMembers.organizationId, organizationId)))
    .where(inArray(users.id, ids))
  return new Map(rows.map((row) => [row.id.toLowerCase(), presenceName(row.firstName, row.lastName)]))
}
