import { eq } from "drizzle-orm"
import { db, users } from "../db"
import { zoneOr } from "../utils/freeSlots"

/** The user's own time zone, or UTC when none is set or it is not a real zone */
export async function personZone(userId: string): Promise<string> {
  const [row] = await db.select({ timeZone: users.timeZone }).from(users).where(eq(users.id, userId))
  return zoneOr(row?.timeZone, "UTC")
}
