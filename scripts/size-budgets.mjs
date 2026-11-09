// node scripts/size-budgets.mjs website <dist dir> | server-image <image>
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

// Each limit is the measured size plus 10%, rounded up. kB is 1000 bytes and MB is 1,000,000 bytes.
// The image size is the uncompressed one `docker image inspect` reports on the CI runners' overlay2 store.
export const BUDGETS = {
  websiteFirstLoadKb: 549, // measured 498,407 bytes gzipped
  serverImageMb: 439, // measured 399 MB
}

const raise = "raise the budget in scripts/size-budgets.mjs and say why in the commit."

export function checkWebsite(dist, budgets = BUDGETS) {
  const html = readFileSync(join(dist, "index.html"), "utf8")
  const gz = (file) => gzipSync(readFileSync(join(dist, file))).length
  const first = [...html.matchAll(/<(?:script\b[^>]*\bsrc|link\b[^>]*\brel="modulepreload"[^>]*\bhref)="([^"]+)"/g)]
    .map((m) => m[1].replace(/^\//, ""))
    .filter((s) => !/^https?:/.test(s))
  const firstBytes = first.reduce((sum, file) => sum + gz(file), 0)
  const errors =
    firstBytes > budgets.websiteFirstLoadKb * 1000
      ? [
          `The website's first load is ${Math.round(firstBytes / 1000)} kB gzipped, over its ${budgets.websiteFirstLoadKb} kB budget. Make something load later, or ${raise}`,
        ]
      : []
  return { firstBytes, errors }
}

export function checkImage(bytes, budgets = BUDGETS) {
  const mb = Math.round(bytes / 1e6)
  const errors =
    bytes > budgets.serverImageMb * 1e6
      ? [`The server image is ${mb} MB, over its ${budgets.serverImageMb} MB budget. Leave something out of the image, or ${raise}`]
      : []
  return { bytes, errors }
}

if (process.argv[1]?.endsWith("size-budgets.mjs")) {
  const [kind, target] = process.argv.slice(2)
  let result
  if (kind === "website" && target) result = checkWebsite(target)
  else if (kind === "server-image" && target)
    result = checkImage(Number(execFileSync("docker", ["image", "inspect", "--format", "{{.Size}}", target], { encoding: "utf8" })))
  else {
    console.error("Usage: node scripts/size-budgets.mjs website <dist dir> | server-image <image>")
    process.exit(2)
  }
  console.log(JSON.stringify({ kind, ...result, errors: undefined }))
  for (const e of result.errors) console.error(e)
  process.exit(result.errors.length ? 1 : 0)
}
