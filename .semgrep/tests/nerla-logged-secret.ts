export function signIn(fastify: Server, user: { id: string; password: string }, token: string) {
  // ruleid: nerla-logged-secret
  logger.info("Signed in", { userId: user.id, password: user.password })
  // ruleid: nerla-logged-secret
  fastify.log.warn({ token }, "Token refreshed")
  // ruleid: nerla-logged-secret
  console.log("Reset", { user: { id: user.id, resetToken: token } })
  // ruleid: nerla-logged-secret
  logger.error("Storage failed", { clientSecret: process.env.S3_SECRET })
  // ok: nerla-logged-secret
  logger.info("Signed in", { userId: user.id })
  // ok: nerla-logged-secret
  logger.warn("AI fold failed", { tokens: 1200 })
  // ok: nerla-logged-secret
  fastify.log.error(new Error("Reset password failed"), "Reset password error")
}
