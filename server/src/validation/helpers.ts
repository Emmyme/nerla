import { z } from "zod"
import type { FastifyReply } from "fastify"

/** The parsed input, or undefined after a 400 with the validation details has been sent */
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | undefined {
  const result = schema.safeParse(input)
  if (!result.success) {
    reply.status(400).send({
      error: "Invalid input",
      details: result.error.flatten(),
    })
    return undefined
  }
  return result.data
}

export const parseBody = parse
export const parseQuery = parse
export const parseParams = parse
