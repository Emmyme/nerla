import { and, eq, sql } from "drizzle-orm"
import { projects, type Tx } from "../db"
import { liveProject } from "../utils/trash"

export const PROJECT_GONE = new Error("The project is gone or in the trash")

/** The project's next task number. The update locks the project row until the transaction ends */
export async function allocateTaskNumber(tx: Tx, projectId: string): Promise<number> {
  const [project] = await tx
    .update(projects)
    .set({ taskCounter: sql`${projects.taskCounter} + 1` })
    .where(and(eq(projects.id, projectId), liveProject))
    .returning({ taskCounter: projects.taskCounter })
  if (!project) throw PROJECT_GONE
  return project.taskCounter
}
