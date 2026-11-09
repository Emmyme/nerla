import { describe, expect, it } from "vitest"
import { addressAllowed, checkModelUrl } from "./modelAddress"

describe("checkModelUrl", () => {
  it("wants https unless the workspace allows its own network", () => {
    expect(checkModelUrl("http://example.com/v1", { local: false }).ok).toBe(false)
    expect(checkModelUrl("http://example.com/v1", { local: true }).ok).toBe(true)
    expect(checkModelUrl("https://example.com/v1", { local: false }).ok).toBe(true)
  })

  it("refuses a user or password in the address", () => {
    expect(checkModelUrl("https://user:pw@example.com", { local: false }).ok).toBe(false)
  })

  it("refuses metadata hosts and addresses even with local on", () => {
    expect(checkModelUrl("https://metadata.google.internal", { local: true }).ok).toBe(false)
    expect(checkModelUrl("http://169.254.169.254/latest", { local: true }).ok).toBe(false)
    expect(checkModelUrl("http://127.0.0.1:11434", { local: false }).ok).toBe(false)
    expect(checkModelUrl("http://127.0.0.1:11434", { local: true }).ok).toBe(true)
  })
})

describe("addressAllowed", () => {
  it("never allows link-local addresses", () => {
    expect(addressAllowed("169.254.169.254", { local: true })).toBe(false)
    expect(addressAllowed("fe80::1", { local: true })).toBe(false)
  })

  it("never allows NAT64, 6to4 or site-local addresses", () => {
    expect(addressAllowed("64:ff9b::a9fe:a9fe", { local: true })).toBe(false)
    expect(addressAllowed("2002:a9fe:a9fe::1", { local: true })).toBe(false)
    expect(addressAllowed("fec0::1", { local: true })).toBe(false)
  })

  it("allows private ranges only with local on", () => {
    expect(addressAllowed("10.0.0.5", { local: false })).toBe(false)
    expect(addressAllowed("10.0.0.5", { local: true })).toBe(true)
  })

  it("judges an IPv4-mapped address as the IPv4 address", () => {
    expect(addressAllowed("::ffff:127.0.0.1", { local: false })).toBe(false)
    expect(addressAllowed("::ffff:127.0.0.1", { local: true })).toBe(true)
  })

  it("allows a public address", () => {
    expect(addressAllowed("93.184.216.34", { local: false })).toBe(true)
  })
})
