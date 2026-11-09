import { getApiBaseUrl } from "@/lib/serverUrl"

export type AgentClient = "claude-code" | "cursor" | "vscode" | "hermes" | "openclaw" | "other"

/** A new token's name for each agent, so the done-by mark names it without anyone typing. Any other agent is named by the user */
export const AGENT_NAMES: Record<AgentClient, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  other: "",
}

const SERVER_NAME = "nerla"
/** Shown in place of a real token where none is at hand */
export const TOKEN_PLACEHOLDER = "<your token>"

export const mcpAddress = (): string => `${getApiBaseUrl().replace(/\/api$/, "")}/mcp`

const headers = (token: string) => ({ Authorization: `Bearer ${token}` })

export const claudeCodeCommand = (address: string, token: string): string =>
  `claude mcp add --transport http ${SERVER_NAME} ${address} --header "Authorization: Bearer ${token}"`

/** The server entry most MCP clients read from their JSON settings */
export const configJson = (address: string, token: string): string =>
  JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "http", url: address, headers: headers(token) } } }, null, 2)

const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

/** Cursor's install link opens Cursor and adds the server after the user confirms */
export const cursorInstallUrl = (address: string, token: string): string =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(base64(JSON.stringify({ url: address, headers: headers(token) })))}`

/** VS Code's install link opens VS Code and adds the server after the user confirms */
export const vscodeInstallUrl = (address: string, token: string): string =>
  `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: "http", url: address, headers: headers(token) }))}`

/** Hermes Agent reads MCP servers from ~/.hermes/config.yaml */
export const hermesConfig = (address: string, token: string): string =>
  [`mcp_servers:`, `  ${SERVER_NAME}:`, `    url: "${address}"`, `    headers:`, `      Authorization: "Bearer ${token}"`].join("\n")

/** OpenClaw saves a server from one JSON object on the command line */
export const openclawCommand = (address: string, token: string): string =>
  `openclaw mcp set ${SERVER_NAME} '${JSON.stringify({ url: address, transport: "streamable-http", headers: headers(token) })}'`
