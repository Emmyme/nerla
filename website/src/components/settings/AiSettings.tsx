import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "react-router"
import { toast } from "sonner"
import { HeldCard } from "@/components/ai/HeldCard"
import { useDiscardGuard } from "@/components/calendar/DiscardDialog"
import { RadioList } from "@/components/ui/radio-list"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Skeleton } from "@/components/ui/skeleton"
import { aiAPI, type AiHeld, type AiHeldAnswer, type AiStrictness, type AiUsage, type PersonalAi } from "@/lib/api/ai"
import { reloadAiAccess, setAiAccess, useAiAccess } from "@/lib/aiAccess"
import { failureOf } from "@/lib/aiStore"
import { onAiHeldEvent, onSocketReconnect } from "@/lib/socket"
import { messageOf } from "@/lib/taskStore"
import { useBusyLoad } from "@/lib/useBusyRetry"
import { AiActivity } from "./AiActivity"
import { AiMemory } from "./AiMemory"
import { ConnectionForm } from "./AiConnectionFields"
import { AiTokens } from "./AiTokens"
import { LoadError, LoadingRows } from "./LoadState"
import { SettingsSection } from "./SettingsSection"
import { useLeaveGuard } from "./useLeaveGuard"
import { STRICTNESS, tokens } from "./WorkspaceAiSettings"

type Tab = "model" | "memory" | "tokens" | "pending" | "activity"

const TABS: { value: Tab; label: string }[] = [
  { value: "model", label: "Your model" },
  { value: "memory", label: "Memory" },
  { value: "tokens", label: "Access tokens" },
  { value: "pending", label: "Pending" },
  { value: "activity", label: "Your activity" },
]

const LEVELS: AiStrictness[] = ["every", "tainted", "sensitive"]
const LOAD_FAILED = "Couldn't load your AI settings. Check your connection and try again."
const HELD_FAILED = "Couldn't load what waits for your Allow. Check your connection and try again."
const SAVE_FAILED = "Couldn't save that change. Try again."

const isTab = (value: string | null): value is Tab => TABS.some((tab) => tab.value === value)

/** The user's model, their tokens for outside agents, what waits for their Allow and what was done for them */
export default function AiSettings() {
  const { me, loaded } = useAiAccess()
  const [params, setParams] = useSearchParams()
  const asked = params.get("tab")
  const tab: Tab = isTab(asked) ? asked : "model"
  const [dirty, setDirty] = useState(false)
  // Leaving the page and leaving the tab both ask before unsaved changes go
  const leaveDialog = useLeaveGuard(dirty)
  const [guard, tabDialog] = useDiscardGuard(useCallback(() => dirty, [dirty]))

  const choose = (next: Tab) =>
    guard(() => {
      setDirty(false)
      setParams(
        (current) => {
          if (next === "model") current.delete("tab")
          else current.set("tab", next)
          return current
        },
        { replace: true },
      )
    })

  if (!me) {
    return loaded ? (
      <LoadError message={LOAD_FAILED} onRetry={() => void reloadAiAccess()} />
    ) : (
      <LoadingRows label="Loading your AI settings" busy={false}>
        <Skeleton className="h-[2rem] w-[20rem] max-w-full rounded-lg" />
        <Skeleton className="h-[2.75rem] rounded-lg" />
      </LoadingRows>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
        <SegmentedControl label="AI settings" value={tab} onChange={choose} options={TABS} className="[&_button]:whitespace-nowrap" />
      </div>
      <div className="flex flex-col">
        {tab === "model" && <ModelTab me={me} onDirty={setDirty} />}
        {tab === "memory" && <AiMemory aiName={me.name} onDirty={setDirty} />}
        {tab === "tokens" && <AiTokens mcpEnabled={me.mcpEnabled} />}
        {tab === "pending" && <Pending aiName={me.name} />}
        {tab === "activity" && (
          <SettingsSection
            title="Your activity"
            description="What the AI and your agents did for you, with the result. Never what was written."
          >
            <AiActivity scope="mine" aiName={me.name} />
          </SettingsSection>
        )}
      </div>
      {leaveDialog}
      {tabDialog}
    </div>
  )
}

function ModelTab({ me, onDirty }: { me: PersonalAi; onDirty: (dirty: boolean) => void }) {
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const ownAddress = me.allowUrl
  const floor = LEVELS.indexOf(me.workspaceStrictness)
  // A level saved before the workspace grew stricter counts as the workspace's
  const level = me.strictness && LEVELS.indexOf(me.strictness) < floor ? me.strictness : me.workspaceStrictness
  const options = STRICTNESS.filter((option) => LEVELS.indexOf(option.value) <= floor).map((option) =>
    option.value === me.workspaceStrictness ? { ...option, description: `${option.description} The workspace's level.` } : option,
  )

  useEffect(() => {
    let live = true
    aiAPI.usage().then(
      (next) => live && setUsage(next),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])

  const save = async (patch: Parameters<typeof aiAPI.saveMe>[0]) => setAiAccess(await aiAPI.saveMe(patch))

  const chooseLevel = (next: AiStrictness) => {
    const before = me
    // The workspace's own level is stored as no choice, so it follows the workspace from then on
    const strictness = next === me.workspaceStrictness ? null : next
    setAiAccess({ ...me, strictness })
    save({ strictness }).catch((err) => {
      setAiAccess(before)
      toast.error(messageOf(err, SAVE_FAILED))
    })
  }

  return (
    <div className="flex flex-col">
      {(me.allowKey || ownAddress) && (
        <SettingsSection
          title="Your model"
          description={
            ownAddress
              ? "Your own model, or your own key for the workspace's. Either is used only in your own chat with the AI. Your own address always needs https."
              : "Your own key for the workspace's model, used only in your own chat with the AI. It doesn't count toward the workspace's budget."
          }
        >
          <ConnectionForm
            key={`${me.baseUrl}:${me.model}:${me.keyLast4}`}
            saved={{ baseUrl: me.baseUrl, model: me.model, keyLast4: me.keyLast4 }}
            address={ownAddress}
            onSave={save}
            test={aiAPI.testMe}
            onDirty={onDirty}
          />
        </SettingsSection>
      )}
      <SettingsSection
        title="When the AI asks first"
        description="For the AI teammate and your agents. You can be stricter than the workspace, never less strict."
      >
        <RadioList name="personal-strictness" value={level} options={options} onChange={chooseLevel} />
      </SettingsSection>
      {usage && (
        <SettingsSection
          title="This month"
          description={
            usage.personBudget !== null
              ? `${tokens(usage.used)} of your ${tokens(usage.personBudget)}.${usage.reached ? " Your budget for this month is used up." : ""}`
              : `${tokens(usage.used)} on the workspace's model.`
          }
        >
          {usage.personalUsed > 0 && (
            <p className="text-ui text-muted-foreground">{tokens(usage.personalUsed)} on your own key or model.</p>
          )}
        </SettingsSection>
      )}
    </div>
  )
}

const answeredText = (answer: AiHeldAnswer) => {
  if (answer.status === "denied") return "Denied"
  const ran = answer.results?.filter((result) => result.result.ok).length ?? 0
  const all = answer.results?.length ?? 0
  return ran === all ? (all === 1 ? "Done" : `${all} changes made`) : `${ran} of ${all} changes made`
}

/** Everything that waits for the user's Allow, kept current by the socket */
function Pending({ aiName }: { aiName: string }) {
  const { data: held, setData: setHeld, loadError, busy, reload, retry } = useBusyLoad(aiAPI.held, HELD_FAILED)

  useEffect(() => {
    const offEvents = onAiHeldEvent((event) => {
      if (event.type === "ai-held") setHeld((current) => current && [event.held, ...current.filter((card) => card.id !== event.held.id)])
      else setHeld((current) => current && current.filter((card) => card.id !== event.id))
    })
    const offReconnect = onSocketReconnect(reload)
    return () => {
      offEvents()
      offReconnect()
    }
  }, [reload, setHeld])

  const answer = async (card: AiHeld, decision: "allow" | "deny", chosen: string[]) => {
    const result = await aiAPI.answerHeld(card.id, decision, decision === "allow" ? chosen : undefined)
    setHeld((current) => current && current.filter((other) => other.id !== card.id))
    const reason = failureOf(result)
    if (reason) toast.error(reason)
    else if (result.status === "failed") toast.error("This didn't go through. Nothing more will run from it.")
    else toast.success(answeredText(result))
  }

  return (
    <SettingsSection
      title="Pending"
      meta={held?.length || undefined}
      description="Changes that wait for your Allow. Each one times out after 10 minutes."
    >
      {loadError ? (
        <LoadError message={loadError} onRetry={retry} />
      ) : !held ? (
        <LoadingRows label="Loading what waits for your Allow" busy={busy}>
          <Skeleton className="h-[6rem] rounded-lg" />
        </LoadingRows>
      ) : held.length === 0 ? (
        <p className="text-body text-muted-foreground">Nothing waits for your Allow.</p>
      ) : (
        <ul aria-label="Pending" className="flex flex-col gap-3">
          {held.map((card) => (
            <li key={card.id}>
              <HeldCard held={card} aiName={aiName} onAnswer={(decision, chosen) => answer(card, decision, chosen)} />
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  )
}
