import { mkdirSync, mkdtempSync } from "fs"
import { chmod, mkdir, readdir, rm, utimes, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import { afterAll, expect, it } from "vitest"
import { storageContract } from "./contract"
import { localDriver, removeTempFiles } from "./local"

// The store sits one level down, so a key that escapes it still lands in the test's own temp folder
const space = mkdtempSync(join(tmpdir(), "nerla-local-storage-"))
const root = join(space, "files")
mkdirSync(root)
const driver = localDriver({ root })
afterAll(() => rm(space, { recursive: true, force: true }))

storageContract("local", () => driver)

const absolute = `${space.split("\\").join("/")}/outside/absolute.txt`
it.each(["../outside.txt", "a/../../outside.txt", absolute, "a\\b.txt", "a:b.txt"])("the key %s is refused", async (key) => {
  await expect(driver.put(key, Readable.from([Buffer.from("x")]), "text/plain")).rejects.toThrow("not a safe path")
  await expect(driver.get(key)).rejects.toThrow("not a safe path")
})

it("a put that fails halfway leaves no file and no temp file", async () => {
  async function* breaks() {
    yield Buffer.alloc(64 * 1024)
    throw new Error("The upload was cut off.")
  }
  await expect(driver.put("halfway/file.txt", Readable.from(breaks()), "text/plain")).rejects.toThrow("cut off")
  expect(await readdir(join(root, "halfway"))).toEqual([])
})

it("the start clean-up keeps a fresh temp file and removes an hour-old one", async () => {
  const folder = join(root, "cleanup")
  await mkdir(folder)
  await writeFile(join(folder, ".fresh.txt.0123456789ab.tmp"), "")
  await writeFile(join(folder, ".old.txt.0123456789ab.tmp"), "")
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(join(folder, ".old.txt.0123456789ab.tmp"), twoHoursAgo, twoHoursAgo)
  await removeTempFiles({ root })
  expect(await readdir(folder)).toEqual([".fresh.txt.0123456789ab.tmp"])
})

// Windows has no read-only folders in this sense, and root writes anywhere
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a folder the server can't write to fails the check", async () => {
  const locked = join(space, "locked")
  await mkdir(locked)
  await chmod(locked, 0o555)
  try {
    await expect(localDriver({ root: locked }).check()).rejects.toThrow("can't write")
  } finally {
    await chmod(locked, 0o755)
  }
})
