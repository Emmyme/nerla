import fastify from "fastify"
import { describe, expect, it } from "vitest"
import { errorHandler } from "./errorHandler"

async function answerTo(thrown: unknown) {
  const app = fastify()
  app.setErrorHandler(errorHandler)
  app.get("/", async () => {
    throw thrown
  })
  const res = await app.inject({ method: "GET", url: "/" })
  return [res.statusCode, res.json()]
}

describe("errorHandler", () => {
  it("answers { error } with the client error's text and hides a server fault's", async () => {
    expect(await answerTo(Object.assign(new Error("Title is required"), { statusCode: 400 }))).toEqual([
      400,
      { error: "Title is required" },
    ])
    expect(await answerTo(new Error('relation "tasks" does not exist'))).toEqual([500, { error: "Internal Server Error" }])
    expect(await answerTo({ statusCode: 429, error: "Too many login attempts" })).toEqual([429, { error: "Too many login attempts" }])
  })
})
