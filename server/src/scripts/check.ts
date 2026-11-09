import { loadEnvFile, resolveSecretFiles } from "../config"
import type { SetupItem } from "../services/setupCheck"
import { errorText } from "../utils/errorText"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

function line(item: SetupItem): string {
  const fix = item.fix ? ` ${item.fix.text}${item.fix.href ? ` See ${item.fix.href}` : ""}` : ""
  return `${item.status.padEnd(8)}${item.title}  ${item.detail}${fix}`
}

async function main(): Promise<number> {
  // The same order as the server's own start, so NAME_FILE secrets count here too
  loadEnvFile()
  const secretFileProblems = resolveSecretFiles(process.env)
  // Loaded after the settings, since the database, mail and storage clients read them as they load
  const { runSetupChecks } = await import("../services/setupCheck")
  try {
    const items = await runSetupChecks({}, { secretFileProblems })
    for (const item of items) console.log(line(item))
    const problems = items.filter((item) => item.status === "problem").length
    const warnings = items.filter((item) => item.status === "warning").length
    console.log("")
    console.log(
      problems + warnings === 0 ? "Everything is in order." : `${plural(problems, "problem")} and ${plural(warnings, "warning")} found.`,
    )
    return problems > 0 ? 1 : 0
  } finally {
    // The database client keeps the process alive until it ends
    await import("../db").then(({ db }) => db.$client.end()).catch(() => {})
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`The setup check could not run: ${errorText(error)}`)
    process.exit(2)
  },
)
