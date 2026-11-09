import { expect, it } from "vitest"
import { storageRefusal } from "./storage"
import { DISK_FULL } from "./storage/local"

it.each([
  ["ENOSPC", 507, DISK_FULL],
  ["EACCES", 503, "can't write to the file storage folder"],
])("a %s error from the store answers %i", (code, status, error) => {
  const refusal = storageRefusal(Object.assign(new Error(code), { code }))
  expect(refusal?.status).toBe(status)
  expect(refusal?.error).toContain(error)
})
