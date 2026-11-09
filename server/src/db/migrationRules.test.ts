import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { migrationProblems } from "./migrationRules"

const NO_TX = "-- nerla:no-transaction\n"

describe("migration rules", () => {
  it.each<[string, string | null]>([
    ["drop table x", "drops a table"],
    ["-- nerla:allow drop-table: unused since 2025\ndrop table x", null],
    ["alter table x drop column y", "drops a column"],
    ["alter table x alter column y type text", "changes a column type"],
    ["alter table x rename to y", "renames"],
    ["create index i on x (y)", "builds an index without CONCURRENTLY"],
    ["create index concurrently i on x (y)", "needs -- nerla:no-transaction"],
    [`-- first\n${NO_TX}drop index concurrently if exists i;\ncreate index concurrently i on x (y)`, "needs -- nerla:no-transaction"],
    [`${NO_TX}create index concurrently if not exists i on x (y)`, "drop index concurrently if exists"],
    [`${NO_TX}drop index concurrently if exists i;\n--> statement-breakpoint\ncreate index concurrently i on x (y)`, null],
    ["alter table x add constraint f foreign key (a) references y (b)", "NOT VALID"],
    ["alter table x add constraint f foreign key (a) references y (b) not valid", null],
    ["alter table x alter column y set not null", "set not null"],
    ["-- drop table x\ninsert into t values ('drop table y')", null],
  ])("%s", (sql, fragment) => {
    const problems = migrationProblems("0001_x.sql", sql)
    if (fragment === null) expect(problems).toEqual([])
    else expect(problems.join("\n")).toContain(fragment)
  })

  const dir = join(__dirname, "../../drizzle")

  it("skips the baseline by name", () => {
    expect(migrationProblems("0000_baseline.sql", "drop table x")).toEqual([])
  })

  it("passes every shipped migration", () => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      expect(migrationProblems(file, readFileSync(join(dir, file), "utf8")), file).toEqual([])
    }
  })
})
