import { useEffect, useRef } from "react"
import { usePreviewTracks } from "@livekit/components-react"
import { Track, VideoPresets, type LocalVideoTrack } from "livekit-client"
import { Button } from "@/components/ui/button"
import { LoadingSpinner } from "@/components/ui/spinner"
import { UserAvatar } from "@/components/ui/user-avatar"
import type { JoinChoices } from "./devices"
import { guestAvatar } from "./avatar"
import { PreviewVideo } from "./Prejoin"

export function GuestLobby({
  title,
  name = "",
  choices,
  onCancel,
}: {
  title?: string
  name?: string
  choices?: JoinChoices
  onCancel: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  const cameraOn = choices?.videoEnabled ?? false
  const tracks = usePreviewTracks({
    audio: false,
    video: cameraOn ? { deviceId: choices?.videoDeviceId, resolution: VideoPresets.h720.resolution } : false,
  })
  const videoTrack = cameraOn ? (tracks?.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined) : undefined

  return (
    <main className="flex min-h-window items-center justify-center bg-background p-4 sm:p-6">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-xl border border-border bg-card p-4 sm:p-6">
        <div className="relative aspect-video overflow-hidden rounded-lg bg-app-sunk">
          {videoTrack ? (
            <PreviewVideo track={videoTrack} />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <UserAvatar user={guestAvatar(name)} size="md" className="size-16 text-title" />
            </div>
          )}
        </div>
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 text-center">
          <LoadingSpinner size="lg" aria-hidden="true" />
          <div>
            <h1 ref={heading} tabIndex={-1} className="text-title font-semibold text-foreground outline-none">
              Waiting for someone to let you in
            </h1>
            <p className="mt-1 text-body text-muted-foreground">{title ?? "You'll join as soon as someone in the meeting lets you in."}</p>
          </div>
        </div>
        <Button variant="outline" onClick={onCancel} className="w-full">
          Cancel
        </Button>
      </div>
    </main>
  )
}
