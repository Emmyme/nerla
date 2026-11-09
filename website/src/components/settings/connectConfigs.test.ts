import { describe, expect, it } from "vitest"
import { claudeCodeCommand, configJson, cursorInstallUrl, hermesConfig, openclawCommand, vscodeInstallUrl } from "./connectConfigs"

const ADDRESS = "https://nerla.example.com/mcp"
const TOKEN = "nerla_pat_abc"

describe("agent connect configs", () => {
  it("builds the Claude Code command with the token as a bearer header", () => {
    expect(claudeCodeCommand(ADDRESS, TOKEN)).toBe(
      'claude mcp add --transport http nerla https://nerla.example.com/mcp --header "Authorization: Bearer nerla_pat_abc"',
    )
  })

  it("puts the address and token in the JSON config and both install links", () => {
    const server = { url: ADDRESS, headers: { Authorization: `Bearer ${TOKEN}` } }
    expect(JSON.parse(configJson(ADDRESS, TOKEN)).mcpServers.nerla).toEqual({ type: "http", ...server })

    const cursor = new URL(cursorInstallUrl(ADDRESS, TOKEN))
    expect(cursor.searchParams.get("name")).toBe("nerla")
    expect(JSON.parse(atob(cursor.searchParams.get("config")!))).toEqual(server)

    const vscode = vscodeInstallUrl(ADDRESS, TOKEN)
    expect(vscode.startsWith("vscode:mcp/install?")).toBe(true)
    expect(JSON.parse(decodeURIComponent(vscode.slice("vscode:mcp/install?".length)))).toEqual({ name: "nerla", type: "http", ...server })
  })

  it("builds the Hermes YAML and the OpenClaw command", () => {
    expect(hermesConfig(ADDRESS, TOKEN)).toBe(
      'mcp_servers:\n  nerla:\n    url: "https://nerla.example.com/mcp"\n    headers:\n      Authorization: "Bearer nerla_pat_abc"',
    )
    const json = openclawCommand(ADDRESS, TOKEN).match(/^openclaw mcp set nerla '(.*)'$/)?.[1]
    expect(JSON.parse(json!)).toEqual({ url: ADDRESS, transport: "streamable-http", headers: { Authorization: `Bearer ${TOKEN}` } })
  })
})
