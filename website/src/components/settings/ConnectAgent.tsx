import { useId, useState } from "react"
import { toast } from "sonner"
import { Check, Copy } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { useCopied } from "@/lib/useCopied"
import { copyToClipboard } from "./InviteDialog"
import {
  claudeCodeCommand,
  configJson,
  cursorInstallUrl,
  hermesConfig,
  mcpAddress,
  openclawCommand,
  TOKEN_PLACEHOLDER,
  vscodeInstallUrl,
  type AgentClient,
} from "./connectConfigs"

const CLIENTS: { value: AgentClient; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
  { value: "hermes", label: "Hermes Agent" },
  { value: "openclaw", label: "OpenClaw" },
  { value: "other", label: "Other" },
]

const COPY_FAILED = "Couldn't copy it. Select it and copy it yourself."

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, markCopied] = useCopied()

  const copy = async () => {
    if (await copyToClipboard(text)) return markCopied()
    toast.error(COPY_FAILED)
  }

  return (
    <div className="flex flex-col gap-2">
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-[14rem] overflow-auto rounded-md bg-app-sunk px-3 py-2 font-mono text-caption leading-[1.5] wrap-anywhere whitespace-pre-wrap text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
      >
        {text}
      </pre>
      <div>
        <Button type="button" variant="outline" onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" className="size-[1rem]" /> : <Copy aria-hidden="true" className="size-[1rem]" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

/** The Agent dropdown, shared by the setup and the new token form */
export function AgentPicker({ value, onChange }: { value: AgentClient; onChange: (client: AgentClient) => void }) {
  const pickerId = useId()
  return (
    <div className="flex flex-col gap-1.5 sm:max-w-[16rem]">
      <span id={pickerId} className={FIELD_LABEL}>
        Agent
      </span>
      <Select value={value} onValueChange={(next) => onChange(next as AgentClient)}>
        <SelectTrigger aria-labelledby={pickerId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CLIENTS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * Ready-made setup for the common MCP clients. With a token it fills it in and offers install links,
 * without one it shows where the token goes. `client` starts the pick, and with `onClientChange` the caller holds it
 */
export function ConnectAgent({
  token,
  client: given,
  onClientChange,
}: {
  token?: string
  client?: AgentClient
  onClientChange?: (client: AgentClient) => void
}) {
  const [own, setOwn] = useState<AgentClient>(given ?? "claude-code")
  const client = onClientChange && given ? given : own
  const setClient = (next: AgentClient) => (onClientChange ? onClientChange(next) : setOwn(next))
  const address = mcpAddress()
  const value = token ?? TOKEN_PLACEHOLDER

  const install =
    token && client === "cursor"
      ? { href: cursorInstallUrl(address, token), label: "Add to Cursor" }
      : token && client === "vscode"
        ? { href: vscodeInstallUrl(address, token), label: "Add to VS Code" }
        : null

  return (
    <div className="flex flex-col gap-3">
      <AgentPicker value={client} onChange={setClient} />
      {client === "claude-code" && (
        <>
          <p className="text-ui text-muted-foreground">Run this in a terminal, then ask Claude about your Nerla tasks.</p>
          <CopyBlock text={claudeCodeCommand(address, value)} label="Claude Code command" />
        </>
      )}
      {(client === "cursor" || client === "vscode") && (
        <>
          <p className="text-ui text-muted-foreground">
            {install
              ? `${install.label} opens ${client === "cursor" ? "Cursor" : "VS Code"} and asks you to confirm. Or paste this into its MCP settings.`
              : `Make a token to get a one-click link. Or paste this into ${client === "cursor" ? "Cursor's" : "VS Code's"} MCP settings.`}
          </p>
          {install && (
            <div>
              <Button asChild>
                <a href={install.href}>{install.label}</a>
              </Button>
            </div>
          )}
          <CopyBlock text={configJson(address, value)} label="MCP settings" />
        </>
      )}
      {client === "hermes" && (
        <>
          <p className="text-ui text-muted-foreground">Add this to ~/.hermes/config.yaml, then run /reload-mcp in Hermes.</p>
          <CopyBlock text={hermesConfig(address, value)} label="Hermes Agent settings" />
        </>
      )}
      {client === "openclaw" && (
        <>
          <p className="text-ui text-muted-foreground">Run this where OpenClaw runs. It picks Nerla up on its next turn.</p>
          <CopyBlock text={openclawCommand(address, value)} label="OpenClaw command" />
        </>
      )}
      {client === "other" && (
        <>
          <p className="text-ui text-muted-foreground">
            Any MCP client that speaks Streamable HTTP and can send a header works. Browser clients that send an Origin are refused, so the
            MCP inspector needs its proxy mode.
          </p>
          <CopyBlock text={configJson(address, value)} label="MCP settings" />
        </>
      )}
    </div>
  )
}
