/** Column helpers shared by the schema files */
import { uuid, customType } from "drizzle-orm/pg-core"
import { organizations } from "./users"

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })

export const orgColumn = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" })
