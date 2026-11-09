import { useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AI_TOKEN_AREAS, aiAPI, type AiToken } from "@/lib/api/ai"
import { formatRelative, formatShortDate, parseServerDate } from "@/lib/dates"
import { useBusyLoad } from "@/lib/useBusyRetry"
import { ConfirmDialog } from "./ConfirmDialog"
import { ConnectAgent } from "./ConnectAgent"
import type { AgentClient } from "./connectConfigs"
import { LoadError, LoadingRows } from "./LoadState"
import { AREA_LABELS, NewTokenDialog } from "./NewTokenDialog"
import { SettingsSection } from "./SettingsSection"

const LOAD_FAILED = "Couldn't load the access tokens. Check your connection and try again."
const REVOKE_FAILED = "Couldn't revoke the token. Try again."

type Listed = AiToken & { owner?: { id: string; name: string } }

/** "Read and write: Tasks, Chat. Read: Files" */
function areasText(token: Pick<AiToken, "scopes" | "readOnly">): string {
  const named = (level: "read" | "write") =>
    AI_TOKEN_AREAS.filter((area) => (token.readOnly ? token.scopes[area] && level === "read" : token.scopes[area] === level)).map(
      (area) => AREA_LABELS[area],
    )
  const write = named("write")
  const read = named("read")
  return [write.length ? `Read and write: ${write.join(", ")}` : null, read.length ? `Read: ${read.join(", ")}` : null]
    .filter(Boolean)
    .join(". ")
}

function stateOf(token: AiToken, now = Date.now()): { text: string; live: boolean } {
  if (token.revokedAt) return { text: "Revoked", live: false }
  const ends = parseServerDate(token.expiresAt)
  if (ends && ends.getTime() <= now) return { text: "Expired", live: false }
  return { text: ends ? `Expires ${formatShortDate(ends)}` : "Never expires", live: true }
}

function TokenList({ tokens, onRevoked, empty }: { tokens: Listed[]; onRevoked: (token: AiToken) => void; empty: string }) {
  const [revoking, setRevoking] = useState<Listed | null>(null)
  const list = useRef<HTMLUListElement>(null)

  const revoke = async (token: Listed) => {
    onRevoked(await aiAPI.revokeToken(token.id))
    toast.success(`${token.name} was revoked`)
  }

  if (tokens.length === 0) return <p className="text-body text-muted-foreground">{empty}</p>
  return (
    <>
      <ul ref={list} tabIndex={-1} aria-label="Access tokens" className="flex flex-col divide-y divide-border focus:outline-none">
        {tokens.map((token) => {
          const state = stateOf(token)
          const used = token.lastUsedAt ? `Last used ${formatRelative(token.lastUsedAt)}` : "Never used"
          return (
            <li key={token.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-body font-medium text-foreground">{token.name}</span>
                  <span className="shrink-0 text-caption text-muted-foreground tabular-nums">••••{token.last4}</span>
                </p>
                {token.owner && <p className="truncate text-ui text-foreground">{token.owner.name}</p>}
                <p className="text-caption leading-[1.45] text-muted-foreground">
                  {[token.readOnly ? "Read only" : null, areasText(token)].filter(Boolean).join(". ")}
                </p>
                <p className="text-caption text-muted-foreground">
                  <span className={state.live ? undefined : "font-medium text-foreground"}>{state.text}</span> · {used}
                </p>
              </div>
              {state.live && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-revoke={token.id}
                  className="shrink-0 text-app-berry-text"
                  aria-label={`Revoke ${token.name}${token.owner ? `, ${token.owner.name}'s token` : ""}`}
                  onClick={() => setRevoking(token)}
                >
                  Revoke
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      <ConfirmDialog
        open={!!revoking}
        title="Revoke token"
        confirmLabel="Revoke"
        busyLabel="Revoking"
        failed={REVOKE_FAILED}
        onConfirm={() => (revoking ? revoke(revoking) : Promise.resolve())}
        onClose={() => setRevoking(null)}
        fallbackFocus={() => list.current}
      >
        Revoke <span className="font-semibold text-foreground">{revoking?.name}</span>? Any agent using it is refused at once. This can't be
        undone.
      </ConfirmDialog>
    </>
  )
}

const replaceToken = (tokens: Listed[] | null, next: AiToken) =>
  tokens && tokens.map((token) => (token.id === next.id ? { ...token, ...next } : token))

/** The user's own tokens for outside agents, and where they connect */
export function AiTokens({ mcpEnabled }: { mcpEnabled: boolean }) {
  const { data: tokens, setData: setTokens, loadError, busy, retry } = useBusyLoad<Listed[]>(aiAPI.tokens, LOAD_FAILED)
  const [making, setMaking] = useState(false)
  const [client, setClient] = useState<AgentClient>("claude-code")

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="Access tokens"
        description="An agent with one of your tokens acts as you and sees only what you can see. When a change needs your Allow, it waits in Pending."
        action={
          <Button type="button" onClick={() => setMaking(true)}>
            New token
          </Button>
        }
      >
        {!mcpEnabled && (
          <p className="rounded-lg bg-app-sunk px-3.5 py-2.5 text-ui text-muted-foreground">
            MCP access is off for this workspace, so tokens don't work until an admin turns it on.
          </p>
        )}
        {loadError ? (
          <LoadError message={loadError} onRetry={retry} />
        ) : !tokens ? (
          <LoadingRows label="Loading your access tokens" busy={busy}>
            <Skeleton className="h-[2.75rem] rounded-lg" />
            <Skeleton className="h-[2.75rem] rounded-lg" />
          </LoadingRows>
        ) : (
          <TokenList tokens={tokens} empty="No tokens yet." onRevoked={(next) => setTokens((current) => replaceToken(current, next))} />
        )}
      </SettingsSection>
      <SettingsSection
        title="Connect an agent"
        description="Pick your agent for its setup. A new token comes with these filled in, and one-click links for Cursor and VS Code."
      >
        <ConnectAgent client={client} onClientChange={setClient} />
      </SettingsSection>
      <NewTokenDialog
        open={making}
        agent={client}
        onClose={() => setMaking(false)}
        onCreated={(token) => setTokens((current) => [token, ...(current ?? [])])}
      />
    </div>
  )
}

/** Every token in the workspace, for an admin who can revoke any of them but never see their values */
export function AllTokens() {
  const { data: tokens, setData: setTokens, loadError, busy, retry } = useBusyLoad<Listed[]>(aiAPI.allTokens, LOAD_FAILED)
  return (
    <SettingsSection
      title="All tokens"
      meta={tokens?.length}
      description="Everyone's tokens for outside agents. Revoking one stops it at once."
    >
      {loadError ? (
        <LoadError message={loadError} onRetry={retry} />
      ) : !tokens ? (
        <LoadingRows label="Loading the workspace's tokens" busy={busy}>
          <Skeleton className="h-[2.75rem] rounded-lg" />
          <Skeleton className="h-[2.75rem] rounded-lg" />
        </LoadingRows>
      ) : (
        <TokenList
          tokens={tokens}
          empty="No one has made a token yet."
          onRevoked={(next) => setTokens((current) => replaceToken(current, next))}
        />
      )}
    </SettingsSection>
  )
}
