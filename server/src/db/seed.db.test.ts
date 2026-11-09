import { and, eq, isNull } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { seed, seedShowcase } from "../../scripts/seed"
import { aiHeld, db, notifications, users } from "."

describe("seed", () => {
  it("fills the default workspaces, then the showcase in their place", async () => {
    const plain = await seed({ reset: false, storage: false })
    expect(plain.counts).toMatchObject({ users: 4, projects: 4, tasks: 13 })

    const { counts, showcase } = await seedShowcase({ reset: true, storage: false })
    expect(counts).toMatchObject({ organizations: 1, users: 6, projects: 5, tasks: 42, group_chats: 8, messages: 47, file_attachments: 4 })
    expect(counts.calendar_events).toBe(26)
    expect(counts.time_entries).toBeGreaterThanOrEqual(3)

    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.email, showcase.admin.email))
    const unread = await db
      .select({ kind: notifications.kind })
      .from(notifications)
      .where(and(eq(notifications.userId, admin.id), isNull(notifications.readAt)))
    expect(new Set(unread.map((row) => row.kind))).toEqual(new Set(["mentioned", "task_assigned", "event_changed"]))
    const cards = await db.select({ status: aiHeld.status }).from(aiHeld).where(eq(aiHeld.userId, admin.id))
    expect(cards).toEqual([{ status: "waiting" }])
    // Both seeds write hundreds of rows through the app's services
  }, 120_000)
})
