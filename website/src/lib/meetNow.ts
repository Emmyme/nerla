import { toast } from "sonner"
import { meetingsAPI } from "@/lib/api/meetings"
import { openMeetingWindow } from "@/lib/meetingWindow"
import { messageOf } from "@/lib/taskStore"

const MEET_FAILED = "Couldn't start the meeting. Try again."

/** Meet now: a fresh room, its guest link copied to share, and the meeting window opened */
export async function meetNow(): Promise<void> {
  try {
    const { roomName, joinUrl } = await meetingsAPI.instant()
    try {
      await navigator.clipboard.writeText(joinUrl)
      toast.success("Meeting link copied", { description: joinUrl })
    } catch {
      toast.success("Meeting started", { description: joinUrl })
    }
    void openMeetingWindow(roomName)
  } catch (err) {
    toast.error(messageOf(err, MEET_FAILED))
  }
}

/** New meeting opens the calendar's editor with Video call on */
export const NEW_MEETING_PATH = "/calendar?new=meeting"
