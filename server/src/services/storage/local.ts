/** Files in a folder on the server's own disk. Every write lands whole or not at all */
import { randomBytes } from "crypto"
import { createWriteStream } from "fs"
import { mkdir, open, readdir, rename, rm, stat, statfs, writeFile } from "fs/promises"
import { basename, dirname, join, relative, resolve } from "path"
import type { Readable } from "stream"
import { pipeline } from "stream/promises"
import { StorageMissing, type StorageDriver } from "./driver"
import { errorText } from "../../utils/errorText"

export type LocalSettings = { root: string }

export const DISK_FULL = "The file storage disk is full. Free some space or move files to S3 with ./nerla move-files."
const LOW_SPACE = "The file storage disk has less than 1 GB free."
const TEMP = /^\..+\.[0-9a-f]{12}\.tmp$/
// A write still running touches its temp file, so one this old belongs to no process, even during a rolling update
const STALE_MS = 60 * 60 * 1000

const codeOf = (caught: unknown) => (caught as NodeJS.ErrnoException | null)?.code
// nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- path is always a pathOf result or the root
const tempBeside = (path: string) => join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`)

// A part that starts with a dot also covers .., and keeps a key from ever looking like a temp file
function pathOf(root: string, key: string): string {
  const parts = key.split("/")
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- the check below rejects any key that leaves the root
  const path = resolve(root, key)
  if (/[\\:\0]/.test(key) || parts.some((part) => !part || part.startsWith(".")) || relative(root, path).startsWith("..")) {
    throw new Error(`The file key ${key} is not a safe path inside the file storage folder.`)
  }
  return path
}

/** Removes the temp files that writes cut off by a crash left behind, once they are an hour old. Never throws */
export async function removeTempFiles({ root }: LocalSettings): Promise<void> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    const stale = Date.now() - STALE_MS
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- names come from listing the root itself
    const found = entries.filter((entry) => entry.isFile() && TEMP.test(entry.name)).map((entry) => join(entry.parentPath, entry.name))
    // A temp file renamed since the listing is gone, and is skipped
    const ages = await Promise.all(
      found.map((path) =>
        stat(path).then(
          ({ mtimeMs }) => mtimeMs,
          () => Infinity,
        ),
      ),
    )
    const temps = found.filter((_path, index) => ages[index] < stale)
    await Promise.all(temps.map((path) => rm(path, { force: true })))
    if (temps.length > 0) console.log(`Removed ${temps.length} unfinished file writes from ${root}: ${temps.join(", ")}`)
  } catch (caught) {
    if (codeOf(caught) !== "ENOENT") console.warn(`Could not clear unfinished file writes from ${root}: ${String(caught)}`)
  }
}

function folderReason(root: string, caught: unknown): string {
  const code = codeOf(caught)
  if (code === "ENOENT") return `The file storage folder ${root} does not exist. Create it, or point STORAGE_PATH at a folder that does.`
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return `The server can't write to the file storage folder ${root}. Give the user the server runs as write access to it.`
  }
  if (code === "ENOSPC") return DISK_FULL
  return `The file storage folder ${root} can't be used (${errorText(caught)}). Check STORAGE_PATH.`
}

export function localDriver({ root }: LocalSettings): StorageDriver {
  const open404 = (key: string) =>
    open(pathOf(root, key), "r").catch((caught: unknown) => {
      throw codeOf(caught) === "ENOENT" || codeOf(caught) === "ENOTDIR" ? new StorageMissing(key) : caught
    })

  // Into a temp file beside the target, flushed to disk before the rename, so a reader never sees half a file
  async function put(key: string, stream: Readable) {
    const target = pathOf(root, key)
    const temp = tempBeside(target)
    try {
      await mkdir(dirname(target), { recursive: true })
      await pipeline(stream, createWriteStream(temp, { flags: "wx", flush: true }))
      await rename(temp, target)
      // Without it a crash can lose the rename. Windows can't open a folder for this
      if (process.platform !== "win32") {
        const folder = await open(dirname(target), "r")
        await folder.sync().finally(() => folder.close())
      }
    } catch (caught) {
      stream.destroy()
      await rm(temp, { force: true }).catch(() => {})
      throw codeOf(caught) === "ENOSPC" ? Object.assign(new Error(DISK_FULL), { code: "ENOSPC" }) : caught
    }
  }

  return {
    put,

    async get(key) {
      return (await open404(key)).createReadStream()
    },

    async copy(from, to) {
      // Before the source is opened, so a refused key leaves no file handle open
      pathOf(root, to)
      await put(to, (await open404(from)).createReadStream())
    },

    async delete(key) {
      await rm(pathOf(root, key), { force: true })
    },

    async check() {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- a fixed name inside the root
      const probe = tempBeside(join(root, "check"))
      try {
        await writeFile(probe, "", { flag: "wx" })
        await rm(probe)
      } catch (caught) {
        throw new Error(folderReason(root, caught))
      }
      const { bavail, bsize } = await statfs(root)
      if (bavail * bsize < 1024 ** 3) return { warning: LOW_SPACE }
    },
  }
}
