export type JoinChoices = {
  audioEnabled: boolean
  videoEnabled: boolean
  audioDeviceId?: string
  videoDeviceId?: string
}

const STORAGE_KEY = "nerla-call-devices"

const PROBLEMS: Record<string, string> = {
  NotAllowedError: "Your camera and microphone are blocked. Allow them in your browser, or join without them.",
  NotFoundError: "No camera or microphone found. You can still join and listen.",
  NotReadableError: "Your camera or microphone is in use by another app.",
}

export function deviceProblem(error: unknown): string | null {
  if (error == null) return null
  const name = typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : ""
  return PROBLEMS[name] ?? "Something went wrong with your camera or microphone."
}

/** The browser or the user said no to the device, as opposed to it missing or failing */
export function isBlocked(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: unknown }).name === "NotAllowedError"
}

export function loadChoices(): JoinChoices {
  const choices: JoinChoices = { audioEnabled: true, videoEnabled: true }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return choices
    const saved = JSON.parse(raw) as Partial<Record<keyof JoinChoices, unknown>>
    if (typeof saved.audioEnabled === "boolean") choices.audioEnabled = saved.audioEnabled
    if (typeof saved.videoEnabled === "boolean") choices.videoEnabled = saved.videoEnabled
    if (typeof saved.audioDeviceId === "string" && saved.audioDeviceId) choices.audioDeviceId = saved.audioDeviceId
    if (typeof saved.videoDeviceId === "string" && saved.videoDeviceId) choices.videoDeviceId = saved.videoDeviceId
  } catch {
    return { audioEnabled: true, videoEnabled: true }
  }
  return choices
}

export function saveChoices(c: JoinChoices): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  } catch {
    // Storage can be blocked, the choices then last for this visit only
  }
}

/** What a rejoin uses: the join choices, any device switched since, and the mic and camera as they were at the end */
export function rejoinChoices(joined: JoinChoices, media?: Pick<JoinChoices, "audioEnabled" | "videoEnabled">): JoinChoices {
  const saved = loadChoices()
  const next: JoinChoices = { ...joined, ...media }
  if (saved.audioDeviceId) next.audioDeviceId = saved.audioDeviceId
  if (saved.videoDeviceId) next.videoDeviceId = saved.videoDeviceId
  return next
}
