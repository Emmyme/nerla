/**
 * Fills a development or test database with two workspaces, "Nerla" and "Other", for trying the app and for the e2e
 * tests. With --showcase it fills one rich workspace, "Nerla", in their place for screenshots. Importing it
 * does nothing. The database and storage load only when a seed runs.
 *
 * Run from server/: yarn db:seed [--reset] [--no-storage] [--showcase]
 */
import { loadEnvFile } from "../../src/config"
import { SEED_ACCOUNTS, SEED_PASSWORD } from "./accounts"
import { refuseOutsideDev, SeedRefusal, parseArgs, type SeedOptions } from "./guard"
import type { SeedSummary, ShowcaseSummary } from "./run"

export { SEED_ACCOUNTS, SEED_PASSWORD, type SeedAccount, type SeedWorkspace } from "./accounts"
export { SeedRefusal, type SeedOptions } from "./guard"
export type { SeedSummary, ShowcaseSummary } from "./run"

export async function seed(options: SeedOptions): Promise<SeedSummary> {
  refuseOutsideDev(process.env.NODE_ENV)
  const { runSeed } = await import("./run")
  return runSeed(options)
}

export async function seedShowcase(options: SeedOptions): Promise<ShowcaseSummary> {
  refuseOutsideDev(process.env.NODE_ENV)
  const { runShowcase } = await import("./run")
  return runShowcase(options)
}

function printShowcase({ database, counts, showcase }: ShowcaseSummary, reset: boolean) {
  console.log(`Seeded the showcase workspace ${showcase.workspace} into ${database}${reset ? " after emptying the seeded tables" : ""}.`)
  console.table(counts)
  console.log(`Sign in for screenshots as ${showcase.admin.email} (${showcase.admin.name}, admin of ${showcase.workspace}).`)
  console.log(`Every showcase account has the password ${SEED_PASSWORD}.`)
}

async function main() {
  loadEnvFile()
  let opened = false
  try {
    const options = parseArgs(process.argv.slice(2))
    // Checked before the database loads, so a refusal here never opens a connection
    refuseOutsideDev(process.env.NODE_ENV)
    opened = true
    if (options.showcase) {
      printShowcase(await seedShowcase(options), options.reset)
      return
    }
    const summary = await seed(options)
    console.log(`Seeded ${summary.database}${options.reset ? " after emptying the seeded tables" : ""}.`)
    console.table(summary.counts)
    console.log(`Accounts, each with the password ${SEED_ACCOUNTS[0].password}:`)
    for (const account of SEED_ACCOUNTS) console.log(`  ${account.email} (${account.name}), ${account.role} of ${account.workspace}`)
    if (!options.storage) console.log("No file was stored, since --no-storage was passed.")
  } catch (error) {
    process.exitCode = 1
    if (error instanceof SeedRefusal) console.error(`Refusing to seed. ${error.message}`)
    else console.error("The seed failed:", error)
  } finally {
    if (opened) await (await import("./run")).closeDb()
  }
}

if (require.main === module) void main()
