/** The checks that keep the seed away from data it must not touch. Nothing here reaches the database */

export class SeedRefusal extends Error {}

/** `showcase` seeds the showcase workspace in place of the default content */
export type SeedOptions = { reset: boolean; storage: boolean; showcase?: boolean }

const SEED_ENVS = ["development", "test"]

export function refuseOutsideDev(nodeEnv: string | undefined): void {
  if (nodeEnv && SEED_ENVS.includes(nodeEnv)) return
  const now = nodeEnv ? `it is "${nodeEnv}"` : "it is not set"
  throw new SeedRefusal(
    `The seed only runs with NODE_ENV set to development or test, and ${now}. ` +
      "It replaces data, so it never runs in production. Set NODE_ENV=development to seed a development database.",
  )
}

export function refuseExistingUsers(database: string, users: number, options: SeedOptions): void {
  if (users === 0 || options.reset) return
  throw new SeedRefusal(
    `The database ${database} already has ${users} account${users === 1 ? "" : "s"}, and the seed would clash with them. ` +
      "Pass --reset to empty the seeded tables first. That deletes everything in them.",
  )
}

export function refuseStorage(reason: string | undefined): never {
  throw new SeedRefusal(
    `The sample file could not be stored: ${reason ?? "The file storage did not answer."} ` +
      "Start the file storage, or pass --no-storage to seed without the file.",
  )
}

const FLAGS = ["--reset", "--no-storage", "--showcase"]

export function parseArgs(args: string[]): SeedOptions {
  const unknown = args.find((arg) => !FLAGS.includes(arg))
  if (unknown) {
    throw new SeedRefusal(
      `Unknown option "${unknown}". Use --reset to empty the seeded tables first, --no-storage to seed without the file, ` +
        "or --showcase to seed the showcase workspace in place of the default one.",
    )
  }
  return { reset: args.includes("--reset"), storage: !args.includes("--no-storage"), showcase: args.includes("--showcase") }
}
