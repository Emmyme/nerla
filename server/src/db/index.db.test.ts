import postgres from "postgres"
import { beforeAll, expect, it } from "vitest"
import { db } from "."

beforeAll(async () => {
  // A server whose default zone is not UTC, as an external install's may be. The app's client connects after this
  const url = process.env.DATABASE_URL!
  const owner = postgres(url, { max: 1, onnotice: () => {}, connection: { TimeZone: "UTC" } })
  await owner`alter database ${owner(new URL(url).pathname.slice(1))} set timezone to 'Europe/Stockholm'`
  await owner.end()
})

it("the app's client reads and writes times in UTC", async () => {
  const [{ zone }] = await db.$client<{ zone: string }[]>`select current_setting('TimeZone') as zone`
  expect(zone).toBe("UTC")
})
