import { FastifyError, FastifyReply, FastifyRequest } from "fastify"
import { logger } from "../utils/logger"

function isClientError(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500
}

/** 5xx responses never forward `error.message`, which can leak schema details. */
export const errorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500

  logger.error(error.message, {
    err: error,
    stack: error.stack,
    reqId: request.id,
    method: request.method,
    url: request.url.split("?")[0],
  })

  if (reply.sent) {
    return
  }

  // A rate limit's errorResponseBuilder throws a plain `{ statusCode, error }` object, so its text sits in `error`
  const ownText = (error as { error?: unknown }).error
  const clientText = error.message || (typeof ownText === "string" ? ownText : "") || "Request failed"

  reply.status(statusCode).send({ error: isClientError(statusCode) ? clientText : "Internal Server Error" })
}
