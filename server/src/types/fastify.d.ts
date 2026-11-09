import "@fastify/jwt"
import type { OrgContext } from "../utils/tenancy"
import type { Via } from "../utils/aiTypes"

declare module "fastify" {
  interface FastifyRequest {
    /** Set by orgMiddleware, so only routes behind it read this */
    org: OrgContext
    /** Set by authMiddleware for a request made with an act token. Read it through `viaOf` */
    via?: Via
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      id: string
      email: string
      role: string
      tv: number
    }
    user: {
      id: string
      email: string
      role: string
      tv: number
    }
  }
}
