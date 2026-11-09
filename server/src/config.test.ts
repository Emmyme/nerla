import { describe, expect, it } from "vitest"
import { checkConfig, resolveSecretFiles } from "./config"

const SECRET = "a".repeat(40)

describe("config", () => {
  it("a secret can come from a file", () => {
    const env: NodeJS.ProcessEnv = { JWT_SECRET_FILE: "/run/secrets/jwt" }
    const problems = resolveSecretFiles(env, (path) => (path === "/run/secrets/jwt" ? `${SECRET}\n` : ""))
    expect(problems).toEqual([])
    expect(env.JWT_SECRET).toBe(SECRET)
  })

  it.each([
    ["set both", { JWT_SECRET: SECRET, JWT_SECRET_FILE: "/run/secrets/jwt" }, () => SECRET, "set both"],
    [
      "can't be read",
      { JWT_SECRET_FILE: "/run/secrets/jwt" },
      () => {
        throw new Error("ENOENT")
      },
      "can't be read",
    ],
    ["is empty", { JWT_SECRET_FILE: "/run/secrets/jwt" }, () => "\n", "is empty"],
  ])("a secret file that can't be used stops the start: %s", (_name, env, read, text) => {
    const problems = resolveSecretFiles(env, read)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ variable: "JWT_SECRET", level: "fatal" })
    expect(problems[0].message).toContain("JWT_SECRET")
    expect(problems[0].message).toContain(text)
    if (text !== "set both") expect(problems[0].message).toContain("/run/secrets/jwt")
    expect(problems[0].message).not.toContain(SECRET)
  })

  const production: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    JWT_SECRET: SECRET,
    DATABASE_URL: "postgresql://nerla:Zx81kqPw93@db:5432/nerla", // trufflehog:ignore
    LIVEKIT_API_SECRET: "b".repeat(32),
    AI_MASTER_KEY: "ab".repeat(32),
    S3_ENDPOINT: "https://s3.eu-north-1.amazonaws.com",
    S3_REGION: "eu-north-1",
    S3_BUCKET: "nerla-files",
    S3_ACCESS_KEY: "GKabcdef0123456789",
    S3_SECRET_KEY: "c".repeat(64),
    EMAIL_USER: "me@example.com",
    EMAIL_PASS: "mail-password",
    CLIENT_URL: "https://nerla.example.com",
    TRUST_PROXY: "true",
  }
  const without = (...names: string[]): NodeJS.ProcessEnv => {
    const env = { ...production }
    for (const name of names) delete env[name]
    return env
  }

  it.each<[string, NodeJS.ProcessEnv, [string, string][]]>([
    ["a complete production env", production, []],
    ["NODE_ENV missing", without("NODE_ENV"), [["NODE_ENV", "fatal"]]],
    ["NODE_ENV invalid", { ...production, NODE_ENV: "staging" }, [["NODE_ENV", "fatal"]]],
    ["JWT_SECRET missing", without("JWT_SECRET"), [["JWT_SECRET", "fatal"]]],
    ["JWT_SECRET short", { ...production, JWT_SECRET: "short" }, [["JWT_SECRET", "fatal"]]],
    ["JWT_SECRET known bad", { ...production, JWT_SECRET: "change-me-in-production" }, [["JWT_SECRET", "fatal"]]],
    [
      "JWT_SECRET example placeholder",
      { ...production, JWT_SECRET: "your_super_secret_jwt_key_change_this_in_production" },
      [["JWT_SECRET", "fatal"]],
    ],
    ["no database config", without("DATABASE_URL"), [["DATABASE_URL", "fatal"]]],
    ["database from parts", { ...without("DATABASE_URL"), DB_USER: "nerla", DB_PASSWORD: "Zx81kqPw93", DB_NAME: "nerla" }, []],
    ["weak DB_PASSWORD", { ...without("DATABASE_URL"), DB_USER: "u", DB_PASSWORD: "postgres", DB_NAME: "n" }, [["DB_PASSWORD", "fatal"]]],
    ["weak password in DATABASE_URL", { ...production, DATABASE_URL: "postgresql://u:changeme@db/n" }, [["DB_PASSWORD", "fatal"]]], // trufflehog:ignore
    ["LIVEKIT_API_SECRET missing in production", without("LIVEKIT_API_SECRET"), [["LIVEKIT_API_SECRET", "fatal"]]],
    ["LIVEKIT_API_SECRET short in production", { ...production, LIVEKIT_API_SECRET: "tiny" }, [["LIVEKIT_API_SECRET", "fatal"]]],
    ["EXPOSE_RESET_TOKEN in production", { ...production, EXPOSE_RESET_TOKEN: "true" }, [["EXPOSE_RESET_TOKEN", "fatal"]]],
    ["RATE_LIMIT_MAX in production", { ...production, RATE_LIMIT_MAX: "1000" }, [["RATE_LIMIT_MAX", "fatal"]]],
    ["AI_MASTER_KEY malformed", { ...production, AI_MASTER_KEY: "abc" }, [["AI_MASTER_KEY", "fatal"]]],
    ["MAX_UPLOAD_MB not positive", { ...production, MAX_UPLOAD_MB: "0" }, [["MAX_UPLOAD_MB", "fatal"]]],
    ["AI_MASTER_KEY missing", without("AI_MASTER_KEY"), [["AI_MASTER_KEY", "warning"]]],
    ["no storage keys", without("S3_ACCESS_KEY", "S3_SECRET_KEY"), [["S3_ACCESS_KEY", "warning"]]],
    ["placeholder storage keys", { ...production, S3_ACCESS_KEY: "GK..." }, [["S3_ACCESS_KEY", "warning"]]],
    ["STORAGE_DRIVER unknown", { ...production, STORAGE_DRIVER: "ftp" }, [["STORAGE_DRIVER", "warning"]]],
    [
      "STORAGE_DRIVER local needs no S3 setting",
      { ...without("S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"), STORAGE_DRIVER: "local" },
      [],
    ],
    ["S3_ENDPOINT not a web address", { ...production, S3_ENDPOINT: "garage:3900" }, [["S3_ENDPOINT", "warning"]]],
    ["S3_REGION missing", without("S3_REGION"), [["S3_REGION", "warning"]]],
    ["S3_BUCKET missing", without("S3_BUCKET"), [["S3_BUCKET", "warning"]]],
    ["S3_FORCE_PATH_STYLE not true or false", { ...production, S3_FORCE_PATH_STYLE: "yes" }, [["S3_FORCE_PATH_STYLE", "warning"]]],
    ["email not set up", without("EMAIL_PASS"), [["EMAIL_USER", "warning"]]],
    ["CLIENT_URL unset in production", without("CLIENT_URL"), [["CLIENT_URL", "warning"]]],
    ["TRUST_PROXY unset in production", without("TRUST_PROXY"), [["TRUST_PROXY", "warning"]]],
    [
      "development needs only the basics",
      { NODE_ENV: "development", JWT_SECRET: SECRET, DATABASE_URL: "postgresql://nerla:nerla@localhost/nerla" },
      [
        ["AI_MASTER_KEY", "warning"],
        ["S3_ENDPOINT", "warning"],
        ["S3_REGION", "warning"],
        ["S3_BUCKET", "warning"],
        ["S3_ACCESS_KEY", "warning"],
        ["EMAIL_USER", "warning"],
      ],
    ],
  ])("the start check: %s", (_name, env, expected) => {
    expect(checkConfig(env).map((problem) => [problem.variable, problem.level])).toEqual(expected)
  })
})
