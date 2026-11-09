import { readFileSync } from "fs"
import { resolve } from "path"
import type { LocalSettings } from "./services/storage/local"
import type { S3Settings } from "./services/storage/s3"
import { resolveTrustProxy } from "./utils/trustProxy"
import { errorText } from "./utils/errorText"

export type ConfigProblem = { variable: string; level: "fatal" | "warning"; message: string }

const SECRET_NAMES = [
  "JWT_SECRET",
  "DATABASE_URL",
  "DB_PASSWORD",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "AI_MASTER_KEY",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "EMAIL_PASS",
] as const

const VALID_NODE_ENVS = ["development", "test", "production"]
const KNOWN_BAD_JWT_SECRETS = ["change-me-in-production", "secret", "jwt_secret", "your_super_secret_jwt_key_change_this_in_production"]
const WEAK_DB_PASSWORDS = ["postgres", "nerla", "nerla_password", "password", "changeme"]
const GENERATE = "Run ./setup.sh to generate it, or set it in .env."

const fatal = (variable: string, message: string): ConfigProblem => ({ variable, level: "fatal", message })
const warning = (variable: string, message: string): ConfigProblem => ({ variable, level: "warning", message })

/** Fills each `NAME` from the file `NAME_FILE` names. Sets `env` in place and never puts a value in a message */
export function resolveSecretFiles(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ConfigProblem[] {
  const problems: ConfigProblem[] = []
  for (const name of SECRET_NAMES) {
    const path = env[`${name}_FILE`]?.trim()
    if (!path) continue
    if (env[name]?.trim()) {
      problems.push(fatal(name, `${name} is set both directly and through ${name}_FILE. Keep only one of them.`))
      continue
    }
    let content: string
    try {
      content = read(path)
    } catch {
      problems.push(
        fatal(name, `${name}_FILE points to ${path}, which can't be read. Check that the file exists and the server may read it.`),
      )
      continue
    }
    const value = content.replace(/\r?\n$/, "")
    if (!value.trim()) {
      problems.push(fatal(name, `${name}_FILE points to ${path}, which is empty. Put the value in the file, or remove ${name}_FILE.`))
      continue
    }
    env[name] = value
  }
  return problems
}

const isWebAddress = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/** The file storage settings, or what keeps them from working. The local disk needs no S3 setting */
export function storageConfig(env: NodeJS.ProcessEnv): S3Settings | LocalSettings | ConfigProblem[] {
  const get = (...names: string[]) => names.map((name) => env[name]?.trim()).find(Boolean)
  const driver = get("STORAGE_DRIVER") ?? "s3"
  if (driver === "local") return { root: resolve(get("STORAGE_PATH") ?? "/data/files") }
  if (driver !== "s3") return [warning("STORAGE_DRIVER", "STORAGE_DRIVER must be s3 or local. Fix it in .env, or remove it to use s3.")]

  const problems: ConfigProblem[] = []
  const endpoint = get("S3_ENDPOINT")
  const region = get("S3_REGION")
  const bucket = get("S3_BUCKET")
  const accessKey = get("S3_ACCESS_KEY")
  const secretKey = get("S3_SECRET_KEY")
  const pathStyle = get("S3_FORCE_PATH_STYLE") ?? "true"
  if (!endpoint || !isWebAddress(endpoint)) {
    problems.push(
      warning(
        "S3_ENDPOINT",
        "S3_ENDPOINT must be the web address of the file storage, such as https://s3.eu-north-1.amazonaws.com. Set it in .env.",
      ),
    )
  }
  if (!region) {
    problems.push(
      warning("S3_REGION", "S3_REGION is not set. Set it in .env to the file storage's region, such as eu-north-1, or auto for R2."),
    )
  }
  if (!bucket) problems.push(warning("S3_BUCKET", "S3_BUCKET is not set. Set it in .env to the bucket Nerla keeps files in."))
  if (pathStyle !== "true" && pathStyle !== "false") {
    problems.push(warning("S3_FORCE_PATH_STYLE", "S3_FORCE_PATH_STYLE must be true or false. Fix it in .env, or remove it to use true."))
  }
  if (
    !accessKey ||
    accessKey === "GK..." ||
    accessKey.includes("nerla-key") ||
    !secretKey ||
    secretKey === "..." ||
    secretKey.length < 10
  ) {
    problems.push(
      warning(
        "S3_ACCESS_KEY",
        "File storage keys are missing or still placeholders, so files can't be stored. Run ./setup.sh to generate them, or set S3_ACCESS_KEY and S3_SECRET_KEY in .env.",
      ),
    )
  }
  if (problems.length > 0 || !endpoint || !region || !bucket || !accessKey || !secretKey) return problems
  return { endpoint, region, bucket, accessKey, secretKey, forcePathStyle: pathStyle === "true" }
}

function passwordInUrl(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined
  } catch {
    return undefined
  }
}

/** Every problem with the config as it stands. Pure, so the setup check can run it too */
export function checkConfig(env: NodeJS.ProcessEnv): ConfigProblem[] {
  const problems: ConfigProblem[] = []
  const get = (name: string) => env[name]?.trim() || undefined
  const nodeEnv = get("NODE_ENV")
  const production = nodeEnv === "production"

  if (!nodeEnv || !VALID_NODE_ENVS.includes(nodeEnv)) {
    problems.push(
      fatal(
        "NODE_ENV",
        `NODE_ENV must be one of ${VALID_NODE_ENVS.join(", ")}. Set it in .env, an unset value would turn off protections.`,
      ),
    )
  }

  const jwt = get("JWT_SECRET")
  if (!jwt || jwt.length < 32 || KNOWN_BAD_JWT_SECRETS.includes(jwt)) {
    problems.push(fatal("JWT_SECRET", `JWT_SECRET is missing, shorter than 32 characters, or a known default. ${GENERATE}`))
  }

  const databaseUrl = get("DATABASE_URL")
  if (!databaseUrl) {
    const missing = ["DB_USER", "DB_PASSWORD", "DB_NAME"].filter((name) => !get(name))
    if (missing.length > 0) {
      problems.push(
        fatal("DATABASE_URL", `The database is not set up, ${missing.join(", ")} missing. Set DATABASE_URL, or those variables, in .env.`),
      )
    }
  }

  if (production) {
    const livekit = get("LIVEKIT_API_SECRET")
    if (!livekit || livekit.length < 16 || livekit === "your_livekit_secret_change_this") {
      problems.push(
        fatal("LIVEKIT_API_SECRET", `LIVEKIT_API_SECRET is missing, shorter than 16 characters, or a known default. ${GENERATE}`),
      )
    }
    const dbPassword = get("DB_PASSWORD") ?? (databaseUrl ? passwordInUrl(databaseUrl) : undefined)
    if (dbPassword && WEAK_DB_PASSWORDS.includes(dbPassword)) {
      problems.push(fatal("DB_PASSWORD", `The database password is a known weak default. ${GENERATE}`))
    }
    if (get("RATE_LIMIT_MAX")) {
      problems.push(
        fatal(
          "RATE_LIMIT_MAX",
          "RATE_LIMIT_MAX is only for the end-to-end tests and must not be set in production, it raises the request limit. Remove it from .env.",
        ),
      )
    }
    if (get("EXPOSE_RESET_TOKEN") === "true") {
      problems.push(
        fatal(
          "EXPOSE_RESET_TOKEN",
          "EXPOSE_RESET_TOKEN must not be true in production, it returns password reset tokens over the API. Remove it from .env.",
        ),
      )
    }
  }

  const aiKey = get("AI_MASTER_KEY")
  if (!aiKey) {
    problems.push(warning("AI_MASTER_KEY", `AI model keys can't be saved until it is set. ${GENERATE}`))
  } else if (!/^[0-9a-fA-F]{64}$/.test(aiKey)) {
    problems.push(fatal("AI_MASTER_KEY", `AI_MASTER_KEY must be 64 hex characters. ${GENERATE}`))
  }

  const maxUpload = get("MAX_UPLOAD_MB")
  if (maxUpload !== undefined && !(Number.isFinite(Number(maxUpload)) && Number(maxUpload) > 0)) {
    problems.push(fatal("MAX_UPLOAD_MB", "MAX_UPLOAD_MB must be a number above 0. Fix it in .env, or remove it to use the default of 200."))
  }

  const storage = storageConfig(env)
  if (Array.isArray(storage)) problems.push(...storage)

  if (!get("EMAIL_USER") || !get("EMAIL_PASS")) {
    problems.push(
      warning(
        "EMAIL_USER",
        "Email is not set up, so invite and reset links are only written to the server log. Set EMAIL_USER and EMAIL_PASS in .env to send them.",
      ),
    )
  }

  try {
    resolveTrustProxy(get("TRUST_PROXY"))
  } catch (error) {
    problems.push(fatal("TRUST_PROXY", errorText(error)))
  }

  if (production) {
    if (!get("CLIENT_URL")) {
      problems.push(
        warning("CLIENT_URL", "CLIENT_URL is not set, so links in emails point at localhost. Set it in .env to the address people use."),
      )
    }
    if (!get("TRUST_PROXY")) {
      problems.push(
        warning(
          "TRUST_PROXY",
          "TRUST_PROXY is not set, so every visitor behind a proxy looks like one address. Set it in .env if Nerla sits behind a proxy.",
        ),
      )
    }
  }

  return problems
}

/** Loads .env from the working directory without overwriting set variables. No .env is fine */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

/** Loads .env, reads the secret files, checks the config and exits on a fatal problem. Warnings print once */
export function applyConfig(env: NodeJS.ProcessEnv): void {
  loadEnvFile()
  const fileProblems = resolveSecretFiles(env)
  const problems = [
    ...fileProblems,
    ...checkConfig(env).filter((problem) => !fileProblems.some((found) => found.variable === problem.variable)),
  ]

  for (const problem of problems.filter((found) => found.level === "warning")) console.warn(`Warning: ${problem.message}`)
  const fatals = problems.filter((found) => found.level === "fatal")
  if (fatals.length > 0) {
    for (const problem of fatals) console.error(`FATAL: ${problem.message}`)
    process.exit(1)
  }
}
