import "./loadConfig"
import { logger } from "./utils/logger"
import { fileCleanupJob } from "./services/fileCleanup"
import { pruneGuestSessions } from "./services/guestSessions"
import { notificationCleanupJob } from "./services/notificationCleanup"
import { runTimeJobs } from "./services/timeJobs"
import { pruneRevokedTokens } from "./services/tokenBlacklist"
import { startWorker, stopWorker } from "./jobs/queue"
import { rescheduleCallGraces, stopRoomTimers } from "./services/presence"
import { defineSchedule, startSchedules, stopSchedules } from "./jobs/schedules"
import { ensureBucketExists } from "./services/storage"
import { db } from "./db"
import { migrate, MigrationError } from "./db/migrate"
import { endStaleAi } from "./services/aiTeammate"
import { buildApp } from "./app"
import { live } from "./live/live"
import { DAY_MS } from "./utils/eventTime"

const PORT = parseInt(process.env.PORT || "5000")
const HOUR_MS = 60 * 60 * 1000
const STOP_JOBS_MS = 20_000
const SHUTDOWN_MS = 25_000

// Benign client-disconnect errors must not crash the process.
const BENIGN_NET_ERRORS = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"])

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err && err.code && BENIGN_NET_ERRORS.has(err.code)) {
    logger.warn(`Ignoring benign network error (client disconnect): ${err.code}`)
    return
  }
  logger.error("Uncaught exception - exiting:", err)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason)
})

async function start() {
  try {
    if (process.env.DB_SSL === "false") {
      logger.warn(
        "DB_SSL is disabled - database connections are unencrypted. " +
          "This is acceptable for bundled local Postgres but MUST be changed if the database is on a separate host.",
      )
    }

    try {
      await migrate(db.$client, { log: (line) => logger.info(line) })
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error
      logger.error(`FATAL: ${error.message}`)
      process.exit(1)
    }

    await ensureBucketExists()

    const app = await buildApp()

    await app.listen({ port: PORT, host: "0.0.0.0" })
    defineSchedule("file-cleanup", DAY_MS, fileCleanupJob)
    defineSchedule("notification-cleanup", DAY_MS, notificationCleanupJob)
    defineSchedule("time-jobs", 15 * 60 * 1000, runTimeJobs)
    defineSchedule("revoked-tokens", HOUR_MS, pruneRevokedTokens)
    defineSchedule("guest-sessions", 60_000, pruneGuestSessions)
    defineSchedule("ai-stale", 60_000, endStaleAi)
    startSchedules()
    startWorker()
    rescheduleCallGraces().catch((error) => logger.error("Could not reschedule the call grace pushes", error))

    logger.info(`Server running on port ${PORT}`)

    let stopping: string | null = null
    const shutdown = async (signal: string) => {
      if (stopping) return
      const step = (name: string) => {
        stopping = name
        logger.info(`Shutdown: ${name}`)
      }
      logger.info(`Received ${signal}, shutting down`)
      const force = setTimeout(() => {
        logger.error(`Shutdown still waiting after ${SHUTDOWN_MS / 1000} seconds on: ${stopping}. Exiting anyway`)
        process.exit(1)
      }, SHUTDOWN_MS)
      force.unref()
      try {
        step("stopping requests")
        stopSchedules()
        stopRoomTimers()
        await app.close()
        step("stopping background jobs")
        await stopWorker(STOP_JOBS_MS)
        step("closing the live layer")
        await live.close()
        // Last, since a job still running past the wait keeps using the database until the exit
        step("closing the database")
        await db.$client.end({ timeout: 5 })
        logger.info("Shutdown finished")
        process.exit(0)
      } catch (error) {
        logger.error(`Shutdown failed while ${stopping}`, error)
        process.exit(1)
      }
    }

    process.on("SIGINT", () => void shutdown("SIGINT"))
    process.on("SIGTERM", () => void shutdown("SIGTERM"))
  } catch (error) {
    logger.error("Failed to start server:", error)
    process.exit(1)
  }
}

start()
