import type { FastifyInstance } from "fastify"
import { handleMcp } from "../services/mcp"

/** Not for browsers, so CORS stays shut here, preflight included */
const config: Record<string, unknown> = { cors: false }

async function mcpRoutes(fastify: FastifyInstance) {
  fastify.route({ method: ["POST", "GET", "DELETE"], url: "/", config, handler: handleMcp })
  fastify.options("/", { config }, (_request, reply) => reply.code(405).send())
}

export default mcpRoutes
