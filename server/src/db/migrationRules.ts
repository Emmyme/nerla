const BASELINE = "0000_baseline.sql"
const NO_TRANSACTION = "-- nerla:no-transaction"
const ALLOW = /^\s*-- nerla:allow ([a-z-]+):/gim

/** Comments and string literals removed, so a keyword inside either never trips a rule */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
}

const unquote = (name: string) => name.replace(/"/g, "").toLowerCase()

export function migrationProblems(name: string, text: string): string[] {
  if (name === BASELINE) return []
  const allowed = new Set([...text.matchAll(ALLOW)].map((m) => m[1].toLowerCase()))
  const sql = code(text)
  const problems: string[] = []
  const flag = (rule: string, message: string) => {
    if (!allowed.has(rule)) problems.push(`${name} ${message} (rule ${rule}). Allow it with -- nerla:allow ${rule}: <why> if it is safe.`)
  }

  if (/\bdrop\s+table\b/i.test(sql))
    flag("drop-table", "drops a table, which loses data on an install that upgrades. Drop it in a later release")
  if (/\bdrop\s+column\b/i.test(sql))
    flag("drop-column", "drops a column, which loses data on an install that upgrades. Drop it in a later release")
  if (/\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/i.test(sql)) {
    flag("alter-type", "changes a column type, which rewrites and locks the table. Add a new column and copy the data instead")
  }
  if (/\brename\s+(to|column|constraint)\b/i.test(sql)) {
    flag("rename", "renames something, which breaks the previous version while it still runs. Add the new name and drop the old one later")
  }
  if (/\bcreate\s+(unique\s+)?index\s+(?!concurrently\b)/i.test(sql)) {
    flag("index", "builds an index without CONCURRENTLY, which locks writes to the table. Use create index concurrently")
  }

  const concurrent = [...sql.matchAll(/\bcreate\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi)]
  if (concurrent.length > 0 && text.split("\n", 1)[0].trim() !== NO_TRANSACTION) {
    flag("concurrent-transaction", "builds an index concurrently, which needs -- nerla:no-transaction as the first line")
  }
  for (const match of concurrent) {
    const index = unquote(match[1])
    const drop = [...sql.matchAll(/\bdrop\s+index\s+concurrently\s+if\s+exists\s+([\w."]+)/gi)].find(
      (m) => unquote(m[1]) === index && m.index < match.index,
    )
    if (!drop) {
      flag(
        "concurrent-retry",
        `builds index ${index} concurrently without drop index concurrently if exists ${index} before it, so a failed build would leave an invalid index behind`,
      )
    }
  }

  for (const statement of sql.split(";")) {
    if (/\badd\s+constraint\b[\s\S]*\bforeign\s+key\b/i.test(statement) && !/\bnot\s+valid\b/i.test(statement)) {
      flag("foreign-key", "adds a foreign key without NOT VALID, which locks both tables. Add it NOT VALID and validate it after")
    }
  }

  if (/\bset\s+not\s+null\b/i.test(sql) && !/\bvalidate\s+constraint\b/i.test(sql)) {
    flag(
      "not-null",
      "uses set not null without a validated check constraint first, which scans and locks the table. Add a NOT VALID check, validate it, then set not null",
    )
  }
  return problems
}
