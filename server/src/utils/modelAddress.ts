import { BlockList, isIP } from "node:net"

const subnets = (list: [string, number, "ipv4" | "ipv6"][]) => {
  const blocked = new BlockList()
  for (const [net, prefix, family] of list) blocked.addSubnet(net, prefix, family)
  return blocked
}

/** Never reachable: link-local, this network, multicast, reserved, the cloud metadata address and the IPv6 ranges that translate to IPv4 */
const ALWAYS = subnets([
  ["169.254.0.0", 16, "ipv4"],
  ["0.0.0.0", 8, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["::", 128, "ipv6"],
  ["fd00:ec2::254", 128, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
])

/** Reachable only when the workspace allows its own network */
const PRIVATE = subnets([
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
])

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata"])

/** An IPv4-mapped IPv6 address is judged as the IPv4 address inside it, which BlockList does itself */
export function addressAllowed(ip: string, opts: { local: boolean }): boolean {
  const family = isIP(ip)
  if (!family || ip.includes("%")) return false
  const type = family === 4 ? "ipv4" : "ipv6"
  if (ALWAYS.check(ip, type)) return false
  return opts.local || !PRIVATE.check(ip, type)
}

type ModelUrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

/** Checks what can be told from the address alone. Hostnames are checked again at each request, once resolved */
export function checkModelUrl(raw: string, opts: { local: boolean }): ModelUrlCheck {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: "That isn't a web address" }
  }
  if (url.protocol !== "https:" && !(opts.local && url.protocol === "http:")) {
    return { ok: false, reason: "The address needs to start with https://" }
  }
  if (url.username || url.password) return { ok: false, reason: "The address can't hold a user name or password" }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  if (METADATA_HOSTS.has(host)) return { ok: false, reason: "That address isn't allowed" }
  if (isIP(host) && !addressAllowed(host, opts)) return { ok: false, reason: "That address isn't allowed" }
  return { ok: true, url }
}
