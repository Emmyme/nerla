/** ./nerla move-files copies every stored file to another store and checks each copy. It never switches the store itself */
import { randomBytes } from "crypto"
import { notLike } from "drizzle-orm"
import { Readable } from "stream"
import { parseArgs } from "util"
import { loadEnvFile, resolveSecretFiles, storageConfig } from "../config"
import { driverFor } from "../services/storage"
import { StorageMissing, type StorageDriver } from "../services/storage/driver"
import type { LocalSettings } from "../services/storage/local"
import type { S3Settings } from "../services/storage/s3"
import { errorText } from "../utils/errorText"

export type MoveOptions = {
  source: StorageDriver
  target: StorageDriver
  deleteSource?: boolean
  /** Stops after this many files, as a run cut off halfway would */
  limit?: number
  log?: (line: string) => void
}
export type Failure = { key: string; name: string; reason: string }

const orMissing = <T>(caught: unknown, missing: T): T => {
  if (caught instanceof StorageMissing) return missing
  throw caught
}

async function sizeIn(driver: StorageDriver, key: string): Promise<number> {
  let size = 0
  for await (const chunk of await driver.get(key)) size += (chunk as Buffer).length
  return size
}

// Two settings can name one store, and then a skipped key would be the only copy that --delete-source removes
async function sameStore(source: StorageDriver, target: StorageDriver): Promise<boolean> {
  const probe = `nerla-move-check-${randomBytes(6).toString("hex")}`
  await target.put(probe, Readable.from([Buffer.from("x")]), "text/plain")
  try {
    const body = await source.get(probe).catch((caught) => orMissing(caught, null))
    body?.destroy()
    return body !== null
  } finally {
    await target.delete(probe)
  }
}

/** Walks the stored files the database knows. A key already in the target with the right size is skipped, so a second run resumes */
export async function moveFiles({ source, target, deleteSource = false, limit = Infinity, log = console.log }: MoveOptions) {
  const { db, fileAttachments } = await import("../db")
  const stored = async () => {
    // tenancy: every workspace's files move together. A doc: path is a paper or board, which lives in the database
    const attachments = await db
      .select({
        key: fileAttachments.filePath,
        size: fileAttachments.fileSize,
        name: fileAttachments.fileName,
        type: fileAttachments.mimeType,
      })
      .from(fileAttachments)
      .where(notLike(fileAttachments.filePath, "doc:%"))
    return [...new Map(attachments.map((row) => [row.key, row])).values()]
  }
  const files = (await stored()).sort((a, b) => (a.key < b.key ? -1 : 1))
  const run = files.slice(0, limit)
  if (deleteSource && (await sameStore(source, target))) {
    throw new Error("The new store is the same as the current one, so --delete-source would delete the only copy. Nothing was moved.")
  }

  let verified: typeof files = []
  const failed: Failure[] = []
  let copied = 0
  let skipped = 0
  for (const [index, file] of run.entries()) {
    const step = `${index + 1} of ${files.length}`
    try {
      if ((await sizeIn(target, file.key).catch((caught) => orMissing(caught, -1))) === file.size) {
        skipped++
        verified.push(file)
        log(`${step}  already moved  ${file.name}`)
        continue
      }
      const body = await source.get(file.key).catch((caught) => {
        throw caught instanceof StorageMissing
          ? new Error("It is not in the current store, so it can't be copied. Put it back from a backup, or delete the file in Nerla.")
          : caught
      })
      await target.put(file.key, body, file.type || "application/octet-stream")
      const size = await sizeIn(target, file.key)
      if (size !== file.size) throw new Error(`The copy has ${size} bytes, but Nerla recorded ${file.size}. Run the command again.`)
      copied++
      verified.push(file)
      log(`${step}  copied  ${file.name}`)
    } catch (caught) {
      failed.push({ key: file.key, name: file.name, reason: errorText(caught) })
      log(`${step}  failed  ${file.name} (${file.key}): ${errorText(caught)}`)
    }
  }

  // A file deleted in Nerla during the move is gone from the current store, so its copy goes too
  const kept = new Set((await stored()).map((file) => file.key))
  for (const file of verified.filter((file) => !kept.has(file.key))) {
    await target
      .delete(file.key)
      .catch((caught) => log(`${file.name} was deleted in Nerla, but its copy in the new store could not be: ${errorText(caught)}`))
  }
  verified = verified.filter((file) => kept.has(file.key))

  let deleted = 0
  if (deleteSource && (failed.length > 0 || run.length < files.length)) {
    log("Nothing was deleted from the current store, since not every file was moved and checked.")
  } else if (deleteSource) {
    for (const file of verified) {
      try {
        await source.delete(file.key)
        deleted++
      } catch (caught) {
        const reason = `It was moved, but deleting it from the current store failed: ${errorText(caught)}`
        failed.push({ key: file.key, name: file.name, reason })
      }
    }
  }
  return { total: files.length, copied, skipped, failed, deleted }
}

type Settings = S3Settings | LocalSettings

const MOVE_TO = "MOVE_TO_"

const describe = (settings: Settings) =>
  "root" in settings ? `the folder ${settings.root}` : `the bucket ${settings.bucket} at ${settings.endpoint}`
const sameSettings = (a: Settings, b: Settings) =>
  "root" in a || "root" in b
    ? "root" in a && "root" in b && a.root === b.root
    : a.endpoint.replace(/\/+$/, "") === b.endpoint.replace(/\/+$/, "") && a.bucket === b.bucket
// The target's messages name its settings, which carry MOVE_TO_ in .env
const forTarget = (message: string) =>
  message.replace("Run ./setup.sh to generate them, or set", "Set").replace(/\b(S3_[A-Z_]+)\b/g, "MOVE_TO_$1")
const fail = (...lines: string[]) => {
  for (const line of lines) console.error(line)
  return 1
}

/**
 * When the source is local disk, the S3_ lines still name the bundled store setup made, so a move back to it reuses them.
 * Any other S3 target never borrows them
 */
export function reusesS3Lines(env: NodeJS.ProcessEnv, from: Settings): boolean {
  const endpoint = env.MOVE_TO_S3_ENDPOINT?.trim()
  return "root" in from && (!endpoint || endpoint === env.S3_ENDPOINT?.trim())
}

/**
 * Settings the target reads: each MOVE_TO_ name without its prefix. Local disk is always the server's own folder, the files
 * volume in Docker, as anywhere else would be lost when the container is made again
 */
function targetEnv(env: NodeJS.ProcessEnv, to: string, reuse: boolean): NodeJS.ProcessEnv {
  const entries = Object.entries(env)
  return {
    ...(reuse ? Object.fromEntries(entries.filter(([name]) => name.startsWith("S3_"))) : {}),
    ...Object.fromEntries(entries.filter(([name]) => name.startsWith(MOVE_TO)).map(([name, value]) => [name.slice(MOVE_TO.length), value])),
    STORAGE_PATH: env.STORAGE_PATH,
    STORAGE_DRIVER: to,
  }
}

function switchLines(settings: Settings, reuse: boolean, env: NodeJS.ProcessEnv): string[] {
  if ("root" in settings) return ["STORAGE_DRIVER=local"]
  const lines: [string, string][] = [
    ["S3_ENDPOINT", settings.endpoint],
    ["S3_REGION", settings.region],
    ["S3_BUCKET", settings.bucket],
    ["S3_ACCESS_KEY", "<the value of MOVE_TO_S3_ACCESS_KEY>"],
    ["S3_SECRET_KEY", "<the value of MOVE_TO_S3_SECRET_KEY>"],
    ["S3_FORCE_PATH_STYLE", String(settings.forcePathStyle)],
  ]
  // A reused S3_ line without its MOVE_TO_ one already holds the value
  const changed = reuse ? lines.filter(([name]) => env[`MOVE_TO_${name}`]?.trim()) : lines
  return ["STORAGE_DRIVER=s3", ...changed.map(([name, value]) => `${name}=${value}`)]
}

async function main(args: string[]): Promise<number> {
  loadEnvFile()
  const secretProblems = resolveSecretFiles(process.env)
  if (secretProblems.length > 0) return fail(...secretProblems.map((problem) => problem.message))

  let options
  try {
    options = parseArgs({ args, options: { to: { type: "string" }, "delete-source": { type: "boolean" } } }).values
  } catch (caught) {
    return fail(`${errorText(caught)}. Run ./nerla move-files --to local or ./nerla move-files --to s3, with --delete-source if you want.`)
  }
  const { to, "delete-source": deleteSource } = options
  if (to !== "local" && to !== "s3") {
    return fail("Say where the files go: ./nerla move-files --to local, or ./nerla move-files --to s3.")
  }

  if (process.env.MOVE_TO_STORAGE_PATH?.trim()) {
    return fail("Files moved to local disk always go in Nerla's files volume. Remove the MOVE_TO_STORAGE_PATH line from .env.")
  }
  const from = storageConfig(process.env)
  if (Array.isArray(from)) {
    return fail("The current file storage is not set up, so there is nothing to move from.", ...from.map((problem) => problem.message))
  }
  const reuse = reusesS3Lines(process.env, from)
  const into = storageConfig(targetEnv(process.env, to, reuse))
  if (Array.isArray(into)) {
    const names = into.flatMap((problem) =>
      problem.variable === "S3_ACCESS_KEY" ? ["S3_ACCESS_KEY", "S3_SECRET_KEY"] : [problem.variable],
    )
    return fail(
      `The new store is not set up yet. Add these lines to .env with your values, then run ./nerla move-files --to ${to} again:`,
      ...names.map((name) => `  MOVE_TO_${name}=`),
      ...(names.includes("S3_ENDPOINT") ? ["For the bundled storage, that is MOVE_TO_S3_ENDPOINT=http://garage:3900."] : []),
      "",
      ...into.map((problem) => forTarget(problem.message)),
    )
  }
  if (sameSettings(from, into)) {
    return fail(
      `Nerla already keeps its files in ${describe(from)}, so there is nothing to move.`,
      ...("root" in from ? [] : ["Point the MOVE_TO_S3_ lines in .env at the store the files should go to."]),
    )
  }
  const source = driverFor(from)
  const target = driverFor(into)
  try {
    await target.check()
  } catch (caught) {
    return fail(`The new store, ${describe(into)}, can't be used. ${forTarget(errorText(caught))}`, "Nothing was moved.")
  }

  console.log(`Moving files from ${describe(from)} to ${describe(into)}. Nerla keeps using the current store meanwhile.`)
  const result = await moveFiles({ source, target, deleteSource })
  console.log("")
  console.log(`${result.copied} copied and ${result.skipped} already moved, of ${result.total} files.`)
  if (result.failed.length > 0) {
    fail(
      `${result.failed.length} files could not be moved:`,
      ...result.failed.map((failure) => `  ${failure.name} (${failure.key}): ${failure.reason}`),
    )
  }
  // Deletes only start once every copy checked out, so a failure after one is a file left behind in the old store
  if (result.deleted > 0) {
    console.log(`${result.deleted} files were deleted from the current store. Nerla still reads it, so switch now.`)
    if (result.failed.length > 0) console.log("Every file is in the new store. The ones listed above are also still in the old one.")
  } else if (result.failed.length > 0) {
    console.error("Fix what is listed above, then run the same command again. Files already moved are skipped.")
    return 1
  } else {
    console.log("Every file is in the new store, and each copy checked out.")
    console.log(
      "Files uploaded from now on land in the current store only, so run this again right before you switch. It copies only what is new.",
    )
  }
  console.log("")
  console.log("To switch, set these lines in .env:")
  for (const line of switchLines(into, reuse, process.env)) console.log(`  ${line}`)
  console.log("Then run ./nerla restart server.")
  return result.failed.length > 0 ? 1 : 0
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`The files could not be moved: ${errorText(error)}`)
      process.exit(2)
    },
  )
}
