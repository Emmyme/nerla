import type { FastifyRequest } from "fastify"
import type { Via } from "./aiTypes"

/** Who the request was done through, set only by an act token. The one way to ask, so marks and the no-loop rule agree */
export const viaOf = (request: FastifyRequest): Via | null => request.via ?? null
