import { logger } from "./logger"

const LOGGED_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"])

/** The LiveKit address clients dial. Null leaves the client on its build-time default. */
export function livekitPublicUrl(value: string | undefined): string | null {
  const url = value?.trim()
  if (!url) return null
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  if (parsed && (parsed.protocol === "ws:" || parsed.protocol === "wss:") && parsed.hostname) return url
  // Only the scheme and host are logged, the value may carry credentials
  const protocol = parsed?.protocol ?? ""
  logger.warn("LIVEKIT_PUBLIC_URL needs the ws or wss scheme and a host, so it is ignored", {
    scheme: LOGGED_SCHEMES.has(protocol) ? protocol.replace(/:$/, "") : null,
    host: parsed?.hostname || null,
  })
  return null
}
