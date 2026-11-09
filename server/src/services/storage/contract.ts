import { randomUUID } from "crypto"
import { Readable } from "stream"
import { describe, expect, it } from "vitest"
import { StorageMissing, type StorageDriver } from "./driver"

const text = async (stream: Readable) => Buffer.concat(await stream.toArray()).toString()
const putText = (driver: StorageDriver, key: string, body: string) => driver.put(key, Readable.from([Buffer.from(body)]), "text/plain")

// Larger than one 5 MB upload part, so a store that uploads in parts has sent one before the stream breaks
async function* breaksHalfway() {
  for (let i = 0; i < 6; i++) yield Buffer.alloc(1024 * 1024, i)
  throw new Error("The upload was cut off.")
}

/** What every file store must do. A driver's test file calls this with a way to make the driver */
export function storageContract(name: string, makeDriver: () => StorageDriver | Promise<StorageDriver>) {
  describe(`the ${name} storage contract`, () => {
    it.each<[string, (driver: StorageDriver, key: string) => Promise<void>]>([
      [
        "put then get",
        async (driver, key) => {
          await putText(driver, key, "hello")
          expect(await text(await driver.get(key))).toBe("hello")
        },
      ],
      [
        "copy",
        async (driver, key) => {
          await putText(driver, key, "copied")
          await driver.copy(key, `${key}.copy`)
          expect(await text(await driver.get(`${key}.copy`))).toBe("copied")
          expect(await text(await driver.get(key))).toBe("copied")
        },
      ],
      [
        "delete twice",
        async (driver, key) => {
          await putText(driver, key, "gone")
          await driver.delete(key)
          await driver.delete(key)
          await expect(driver.get(key)).rejects.toBeInstanceOf(StorageMissing)
        },
      ],
      ["a missing get", async (driver, key) => expect(driver.get(key)).rejects.toBeInstanceOf(StorageMissing)],
      [
        "a put that fails halfway leaves nothing",
        async (driver, key) => {
          await expect(driver.put(key, Readable.from(breaksHalfway()), "application/octet-stream")).rejects.toThrow()
          await expect(driver.get(key)).rejects.toBeInstanceOf(StorageMissing)
        },
      ],
    ])("%s", async (_name, run) => {
      const driver = await makeDriver()
      const key = `contract/${randomUUID()}/file.txt`
      try {
        await run(driver, key)
      } finally {
        await Promise.all([driver.delete(key), driver.delete(`${key}.copy`)])
      }
    })
  })
}
