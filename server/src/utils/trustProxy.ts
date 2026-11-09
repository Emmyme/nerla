import { BlockList, isIP } from "node:net"
import type { FastifyServerOptions } from "fastify"

// The bundled web proxy reaches the server over the compose network, so the nearest proxy is always on one of these
const localNetworks = new BlockList()
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
] as const)
  localNetworks.addSubnet(network, prefix)
localNetworks.addSubnet("fc00::", 7, "ipv6")
localNetworks.addSubnet("fe80::", 10, "ipv6")
localNetworks.addAddress("::1", "ipv6")

// Node leaves a destroyed socket without an address
const isLocal = (address?: string) => !!address && localNetworks.check(address, address.includes(":") ? "ipv6" : "ipv4")

// What proxy-addr takes: a named range, an address, or an address with a prefix length or a netmask
const RANGES = new Set(["loopback", "linklocal", "uniquelocal"])
function isProxyAddress(part: string) {
  if (RANGES.has(part)) return true
  const [address, range, extra] = part.split("/")
  const family = isIP(address)
  if (!family || extra !== undefined) return false
  return range === undefined || isIP(range) === family || (/^\d+$/.test(range) && Number(range) <= (family === 4 ? 32 : 128))
}

/**
 * TRUST_PROXY=1 trusts exactly one proxy hop, which is what the bundled web proxy needs.
 * Trusting the whole chain would let clients spoof their address. A hop count alone can't tell a proxy from a client
 * that reached the server directly, so the nearest hop must also be on a local network
 */
export function resolveTrustProxy(value = process.env.TRUST_PROXY?.trim()): FastifyServerOptions["trustProxy"] {
  if (!value || value === "false") return false
  const hops = value === "true" ? 1 : /^\d+$/.test(value) ? Number(value) : 0
  if (hops >= 1) return (address: string, hop: number) => hop < hops && (hop > 0 || isLocal(address))
  if (value.split(",").every((part) => isProxyAddress(part.trim()))) return value
  throw new Error(
    `TRUST_PROXY is "${value}", which Nerla can't read. Set it to false, to the number of proxies in front of Nerla (1 or more), or to the proxy addresses, separated by commas.`,
  )
}
