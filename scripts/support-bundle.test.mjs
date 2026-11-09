import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = join(dirname(fileURLToPath(import.meta.url)), "support-bundle.mjs")

const PEM = ["MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq7BFUpkGp3", "ZzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQr=="]

const SECRETS = {
  jwt: "jwt-secret-4f9a1c2e8b7d",
  db: "db-password-91be77",
  rpc: "0f3c9a7e5b1d2c4e6f8a0b1c3d5e7f9a",
  admin: "garage-admin-token-77aa",
  inlineToml: "inlinetabletoken1",
  lkKey: "APIlivekitkey123",
  lkSecret: "livekit-secret-5e6f7a8b9c",
  turn: "turncredential123",
  hookPass: "hk9x7q2wz",
  caddyDns: "cfapitoken12345",
  caddyHash: "$2a$14$bcrypthashvalue",
  smtp: "smtp-pass-from-file",
  nested: "nestedsecretvalue1",
  linked: "linkedsecretvalue2",
  pem0: PEM[0],
  pem1: PEM[1],
  spaced: "spacedpass99",
  yamlStyle: "yamlstylesecret77",
  hashInQuotes: "Tr0ub4dor #3xyz",
  hashTail: "#3xyz",
  slashPass: "slash/pw1234",
  reset: "resettoken0123456789",
  bearer: "opaqueBearerToken0042",
  urlPass: "urlpassword42",
  atPass: "ssw0rd!",
  jwtBare: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX2hlcmU",
  pat: "nerla_pat_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  shareLink: "Zm9vYmFyYmF6cXV4c2VjcmV0bGluaw",
  guestSession: "guestsession0123456",
  sharePage: "sharepagetoken0123",
  cookie: "sessioncookie999",
  escaped: "escapedpw4242",
  inspect: "inspecttoken777",
  jsonValue: "jsonplainvalue77",
  jsonArray: "arraycookie88",
  basicAuth: "dXNlcjpwYXNzd29yZA==",
  escQuote: 'esc"quotedsecret',
  escQuoteJson: 'esc\\"quotedsecret',
  vapid1: "LINEONEaaaaaaaa",
  vapid2: "LINETWObbbbbbbb",
  swallowed: "afterunclosed123",
  caddyHeader: "dXNlcjpjYWRkeWhlYWRlcnB3",
  caddyB64Hash: "JDJhJDE0JGJhc2U2NGVuY29kZWRiY3J5cHRoYXNo",
  noUser: "emptyuserpw77",
  tail1: "tailsecret999",
  tail2: "tailsecret888",
  s3Key: "GKs3accesskey0123",
  s3Secret: "s3secretkeyvalue456",
  jwtBase64: Buffer.from("jwt-secret-4f9a1c2e8b7d").toString("base64"),
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function files(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function runScript(install, bundle) {
  return spawnSync(process.execPath, [script, install, bundle], { encoding: "utf8" })
}

test("a support bundle holds no secret value and keeps the safe ones", () => {
  const root = mkdtempSync(join(tmpdir(), "nerla-bundle-"))
  try {
    const install = join(root, "install")
    write(
      join(install, ".env"),
      [
        "# a comment that names " + SECRETS.jwt,
        "NODE_ENV=production",
        "SITE_ADDRESS=chat.example.com",
        "SERVER_PORT=5000",
        "STORAGE_DRIVER=s3",
        "TLS_MODE=internal",
        "CLIENT_URL=https://chat.example.com/app",
        "DB_USER=nerlaplainuser",
        `JWT_SECRET="${SECRETS.jwt}"`,
        `DB_PASSWORD=${SECRETS.db} # inline`,
        `EMAIL_PASS = ${SECRETS.spaced}`,
        `WEBHOOK_SECRET: ${SECRETS.yamlStyle}`,
        `SMTP_PASSWORD="${SECRETS.hashInQuotes}"`,
        `DATABASE_URL=postgres://nerla:${SECRETS.slashPass}@db:5432/nerla`, // trufflehog:ignore
        `PUSH_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----`,
        ...PEM,
        `-----END PRIVATE KEY-----"`,
        "SMTP_PASSWORD_FILE=/run/secrets/smtp",
        `LIVEKIT_API_KEY=${SECRETS.lkKey}`,
        `LIVEKIT_API_SECRET=${SECRETS.lkSecret}`,
        `S3_ACCESS_KEY=${SECRETS.s3Key}`,
        `S3_SECRET_KEY=${SECRETS.s3Secret}`,
        "ACME_EMAIL=",
        "not a setting " + SECRETS.db,
        String.raw`ENCRYPTION_KEY="esc\"quotedsecret"`,
        `VAPID_PRIVATE_KEY="${SECRETS.vapid1}\\n${SECRETS.vapid2}"`,
        // A quote left open takes in every line after it, so this one goes last
        `WELCOME_TEXT="Hello`,
        `ADMIN_PASSWORD=${SECRETS.swallowed}`,
      ].join("\n"),
    )
    write(
      join(install, "garage.toml"),
      [
        'rpc_bind_addr = "0.0.0.0:3901"',
        `rpc_secret = "${SECRETS.rpc}"`,
        "[admin]",
        `admin_token = "${SECRETS.admin}"`,
        `metrics_token = "${SECRETS.admin}x"`,
        `admin = { token = "${SECRETS.inlineToml}" }`,
        `a broken line ${SECRETS.rpc}`,
      ].join("\n"),
    )
    write(
      join(install, "livekit.yaml"),
      [
        "port: 7880",
        "keys:",
        `  ${SECRETS.lkKey}: ${SECRETS.lkSecret}`,
        "rtc:",
        "  tcp_port: 7881",
        "  turn_servers:",
        "    - host: turn.example.com",
        "      username: turnuser",
        `      credential: ${SECRETS.turn}`,
        "webhook:",
        `  url: https://hookuser:${SECRETS.hookPass}@hooks.example.com/x`,
      ].join("\n"),
    )
    write(
      join(install, "proxy", "Caddyfile"),
      [
        "{$SITE_ADDRESS} {",
        `\tbasic_auth { admin ${SECRETS.caddyHash} }`,
        "\tbasicauth {",
        `\t\tadmin ${SECRETS.caddyB64Hash}`,
        "\t}",
        "\treverse_proxy app:5000 {",
        `\t\theader_up Authorization "Basic ${SECRETS.caddyHeader}"`,
        "\t}",
        "\ttls {",
        `\t\tdns cloudflare ${SECRETS.caddyDns}`,
        "\t}",
        "}",
      ].join("\n"),
    )
    write(join(install, "secrets", "smtp"), SECRETS.smtp + "\n")
    write(join(install, "secrets", "nested", "deep"), SECRETS.nested)
    write(join(install, "outside-secret"), SECRETS.linked)
    try {
      symlinkSync(join("..", "outside-secret"), join(install, "secrets", "linked"))
    } catch {
      // Windows without developer mode can't make links, so the file stands in for one
      write(join(install, "secrets", "linked"), SECRETS.linked)
    }
    write(join(install, "backups", "2026-11-01", "postgres.dump"), "backup data")

    const bundle = join(root, "nerla-support-test")
    write(
      join(bundle, "logs", "server.log"),
      [
        `server  | Password reset link: https://chat.example.com/reset-password?token=${SECRETS.reset}&next=/`,
        `server  | GET /api/me Authorization: Bearer ${SECRETS.bearer}`,
        `server  | socket joined with Bearer ${SECRETS.bearer}`,
        `server  | connecting to postgres://nerla:${SECRETS.urlPass}@postgres:5432/nerla`, // trufflehog:ignore
        `server  | connecting to postgres://nerla:p@${SECRETS.atPass}@db/x`, // trufflehog:ignore
        `server  | db postgres://nerla:${SECRETS.slashPass}@db:5432/nerla`, // trufflehog:ignore
        `server  | invalid session ${SECRETS.jwtBare}`,
        `server  | mcp ${SECRETS.pat} rejected`,
        `server  | {"level":30,"req":{"method":"GET","url":"/api/public/links/${SECRETS.shareLink}/files/abc/download"}}`,
        `server  | {"req":{"url":"/api/meetings/guest-status/${SECRETS.guestSession}"}}`,
        `web     | GET https://chat.example.com/s/${SECRETS.sharePage}`,
        `server  | {"headers":{"set-cookie":["nerla_session=${SECRETS.cookie}; HttpOnly"]}}`,
        `server  | {"body":"{\\"password\\":\\"${SECRETS.escaped}\\"}"}`,
        `server  | warn: { token: '${SECRETS.inspect}' }`,
        `server  | {"apiKey":"${SECRETS.jsonValue}","cookies":["${SECRETS.jsonArray}"]}`,
        `server  | GET /api/files Authorization: Basic ${SECRETS.basicAuth}`,
        `server  | retry with ${SECRETS.slashPass}`,
        `server  | escaped quote ${SECRETS.escQuote} and as JSON {"msg":"${SECRETS.escQuoteJson}"}`,
        `server  | key part ${SECRETS.vapid1}`,
        `server  | key part ${SECRETS.vapid2}`,
        `server  | admin ${SECRETS.swallowed}`,
        `server  | redis redis://:${SECRETS.noUser}@redis:6379`,
        `server  | adjacent password=[removed]${SECRETS.tail1} and token=[set]${SECRETS.tail2}`,
        `server  | as base64 ${SECRETS.jwtBase64}`,
        // No pattern catches a bare value, so only the final scan can
        `server  | signing with ${SECRETS.jwt}`,
        `server  | email login ${SECRETS.spaced} and ${SECRETS.yamlStyle}`,
        `server  | connecting with ${SECRETS.hashInQuotes}`,
        `server  | key line ${PEM[1]}`,
        `server  | from files ${SECRETS.nested} ${SECRETS.linked}`,
        "server  | serving https://chat.example.com/app as nerlaplainuser",
      ].join("\n"),
    )

    const run = runScript(install, bundle)
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /JWT_SECRET/)
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(SECRETS.jwt))

    // Packed and unpacked as ./nerla support-bundle does, with relative paths so no tar reads C: as a host
    assert.equal(spawnSync("tar", ["czf", "bundle.tar.gz", "nerla-support-test"], { cwd: root }).status, 0)
    mkdirSync(join(root, "out"))
    assert.equal(spawnSync("tar", ["xzf", "bundle.tar.gz", "-C", "out"], { cwd: root }).status, 0)

    const unpacked = files(join(root, "out"))
    const all = unpacked.map((path) => path + "\n" + readFileSync(path, "utf8")).join("\n")
    for (const [name, value] of Object.entries(SECRETS)) assert.ok(!all.includes(value), `${name} is in the bundle`)
    assert.ok(!all.includes("backup data"), "backups are in the bundle")

    const env = readFileSync(join(root, "out", "nerla-support-test", "env.txt"), "utf8")
    for (const line of [
      "NODE_ENV=production",
      "SITE_ADDRESS=chat.example.com",
      "SERVER_PORT=5000",
      "STORAGE_DRIVER=s3",
      "TLS_MODE=internal",
      "JWT_SECRET=[set]",
      "PUSH_PRIVATE_KEY=[set]",
      "ACME_EMAIL=[empty]",
    ]) {
      assert.ok(env.includes(line), `env.txt lacks ${line}`)
    }
    assert.match(all, /rpc_bind_addr = "0\.0\.0\.0:3901"/)
    assert.match(all, /rpc_secret = \[removed\]/)
    assert.match(all, /tcp_port: 7881/)
    assert.match(all, /reset-password\?token=\[removed\]&next=\//)
    assert.match(all, /\/api\/public\/links\/\[removed\]\/files\/abc\/download/)
    const secretNames = readFileSync(join(root, "out", "nerla-support-test", "secrets.txt"), "utf8")
    for (const name of ["secrets/smtp", "secrets/nested/deep", "secrets/linked"])
      assert.ok(secretNames.includes(name), `secrets.txt lacks ${name}`)
    // Only secret-named values go in the last net, so plain settings stay readable in the logs
    assert.match(all, /serving https:\/\/chat\.example\.com\/app as nerlaplainuser/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Windows has no file modes and needs developer mode for links, and root reads everything
test(
  "a file it can't read, or a broken link, stops the bundle with a plain message",
  {
    skip: process.platform === "win32" || process.getuid() === 0,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "nerla-bundle-"))
    try {
      const install = join(root, "install")
      write(join(install, ".env"), "NODE_ENV=production\n")
      write(join(install, "garage.toml"), 'rpc_secret = "x"\n')
      chmodSync(join(install, "garage.toml"), 0o000)
      mkdirSync(join(root, "bundle"))
      let run = runScript(install, join(root, "bundle"))
      assert.equal(run.status, 3)
      assert.match(run.stderr, /Nerla can't read garage\.toml\. Run \.\/nerla support-bundle with sudo, the way you ran setup\./)

      chmodSync(join(install, "garage.toml"), 0o600)
      mkdirSync(join(install, "secrets"))
      symlinkSync(join(root, "nowhere"), join(install, "secrets", "gone"))
      run = runScript(install, join(root, "bundle"))
      assert.equal(run.status, 3)
      assert.match(run.stderr, /secrets\/gone links to a file that doesn't exist\. Fix the link or remove it/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test("long log lines can't stall the bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "nerla-bundle-"))
  try {
    const n = 60000
    // Inputs that would make a naive regex backtrack: a JSON array that never closes, a long word full of names, and a run of a://b:
    const lines = ['{"tokens":[' + '"a"  '.repeat(n / 5), "token".repeat(n / 5), "a://b:".repeat(n / 6), "x".repeat(200000)]
    write(join(root, "bundle", "logs", "server.log"), lines.join("\n"))
    mkdirSync(join(root, "install"))
    const started = Date.now()
    const run = runScript(join(root, "install"), join(root, "bundle"))
    assert.equal(run.status, 0, run.stderr)
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
    const out = readFileSync(join(root, "bundle", "logs", "server.log"), "utf8").split("\n")
    // The last 256 characters of the cut word go too, in case they began a secret
    assert.equal(out.at(-1), "x".repeat(65536 - 256) + " [line cut at 64 KB]")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
