import type { FastifyBaseLogger, FastifyReply } from "fastify"

type Refusal = abstract new (code: never, message: string) => Error & { readonly code: number }

/** Sends what the work returns, a `Refusal` as its own status, and anything else as a 500 */
export const answerer =
  (log: FastifyBaseLogger, Refusal: Refusal) => async (reply: FastifyReply, failure: string, work: () => Promise<unknown>) => {
    try {
      return reply.send(await work())
    } catch (error) {
      if (error instanceof Refusal) return reply.code(error.code).send({ error: error.message })
      log.error(error, failure)
      return reply.code(500).send({ error: failure })
    }
  }

/** The refusal for a change in a project the caller only reads, the website matches its text */
export const READ_ONLY = { error: "Join this project to make changes" }

/** The body of a 429 from a route's own rate limit, shaped like every other refusal so the client shows the message */
export const tooManyRequests = (message: string) => () => ({ statusCode: 429, error: message })

/** A date in ISO form, or null when there is none or it does not parse */
export const toISOStringOrNull = (value: string | null | undefined): string | null => {
  const date = value ? new Date(value) : null
  return date && !isNaN(date.getTime()) ? date.toISOString() : null
}
