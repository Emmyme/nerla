/**
 * Where the e2e stack lives. Never the dev stack's 5000, 3001, the nerla database or the nerla-files bucket.
 * prepare.ts writes what it set up to RUN_FILE, and the Playwright config and fixtures read only that.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

export const REPO = resolve(__dirname, "..")
export const WEBSITE_DIR = resolve(REPO, "website")
export const SERVER_DIR = resolve(REPO, "server")

export const SERVER_PORT = 5100
export const WEB_PORT = 4173
export const API_URL = `http://localhost:${SERVER_PORT}`
export const WEB_URL = `http://localhost:${WEB_PORT}`

export const DATABASE = "nerla_e2e"
export const BUCKET = "nerla-e2e"
export const GARAGE_KEY = "nerla-e2e-key"
export const WEBSITE_OUT = "dist-e2e"

export const RUN_DIR = resolve(__dirname, ".run")
export const RUN_FILE = resolve(RUN_DIR, "stack.json")
export const AUTH_DIR = resolve(__dirname, ".auth")

export type Run = {
  /** Every variable the e2e server reads, set explicitly so none comes from a .env */
  server: Record<string, string>
  mailpitUrl: string
}

export function readRun(): Run {
  if (!existsSync(RUN_FILE)) {
    throw new Error(
      `The e2e stack is not prepared, ${RUN_FILE} is missing. Run yarn test:e2e from the repo root, it prepares the stack first.`,
    )
  }
  return JSON.parse(readFileSync(RUN_FILE, "utf8")) as Run
}

/** The vite CLI, run with node directly so no shell or yarn shim sits in between */
export const VITE_BIN = resolve(dirname(require.resolve("vite/package.json", { paths: [WEBSITE_DIR] })), "bin", "vite.js")
