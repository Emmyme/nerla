import { randomBytes } from "node:crypto"
import postgres from "postgres"
import { afterAll, beforeAll, inject } from "vitest"
import { databaseUrl, TEMPLATE } from "./dbGlobalSetup"

const failure = inject("testDatabaseError")
if (failure) throw Object.assign(new Error(failure.message), { cause: new Error(failure.reason) })

const base = inject("testDatabaseUrl")
const name = `nerla_test_${process.env.VITEST_POOL_ID}_${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString("hex")}`
// Set before the test file imports `db`, which reads them once. Its client connects on the first query, after beforeAll
process.env.DATABASE_URL = databaseUrl(base, name)
process.env.DB_SSL = "false"

const admin = postgres(base, { max: 1, connect_timeout: 3, onnotice: () => {}, connection: { TimeZone: "UTC" } })

beforeAll(async () => {
  await admin`create database ${admin(name)} template ${admin(TEMPLATE)}`
})

afterAll(async () => {
  const { db } = await import("../db")
  await db.$client.end({ timeout: 5 })
  await admin`drop database if exists ${admin(name)} with (force)`
  await admin.end()
})
