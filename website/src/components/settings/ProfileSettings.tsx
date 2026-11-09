import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react"
import { toast } from "sonner"
import { uploadFailure } from "@/components/files/uploadErrors"
import { THEMES } from "@/components/shell/UserMenu"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { UserAvatar } from "@/components/ui/user-avatar"
import { useDarkMode } from "@/contexts/DarkModeContext"
import { FIELD_LABEL } from "@/components/ui/field-label"
import { authAPI, usersAPI } from "@/lib/api/users"
import { filesAPI } from "@/lib/api/files"
import { formatLongDate, parseServerDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { useAvatarSrc } from "@/lib/useAvatarSrc"
import { useAuth, useUser } from "@/providers/AuthProvider"
import { AboutSection } from "./AboutSection"
import { SettingsSection } from "./SettingsSection"
import { useLeaveGuard } from "./useLeaveGuard"
import { useSettingsOrg } from "./useSettingsOrg"

const MAX_PHOTO = 5 * 1024 * 1024
const NAME_MAX = 255
const PHOTO_FAILED = "Couldn't update your photo. Try again."
const NAME_FAILED = "Couldn't save your name. Try again."
const RESET_FAILED = "Couldn't send the reset link. Try again."

const THEME_OPTIONS = THEMES.map(({ value, label, Icon }) => ({ value, label, icon: <Icon aria-hidden="true" className="size-[1rem]" /> }))

type Me = NonNullable<ReturnType<typeof useUser>["user"]>

export default function ProfileSettings() {
  const { user } = useUser()
  const { org, loading, error } = useSettingsOrg()
  const [nameDirty, setNameDirty] = useState(false)
  const [aboutDirty, setAboutDirty] = useState(false)
  // One guard for the page, as the router keeps only one blocker
  const discardDialog = useLeaveGuard(nameDirty || aboutDirty)
  if (!user) return null
  return (
    <div className="flex flex-col gap-6">
      {!loading && !error && !org && (
        <p className="rounded-lg bg-app-sunk px-3.5 py-2.5 text-ui text-muted-foreground">
          You're not part of a workspace yet. Ask an admin to invite you.
        </p>
      )}
      <div className="flex flex-col">
        <PhotoSection user={user} />
        <NameSection key={user.id} user={user} onDirty={setNameDirty} />
        <AboutSection key={`about-${user.id}`} onDirty={setAboutDirty} />
        <AccountSection user={user} />
        <AppearanceSection />
        <PasswordSection email={user.emailAddresses[0]?.emailAddress ?? ""} />
      </div>
      {discardDialog}
    </div>
  )
}

function PhotoSection({ user }: { user: Me }) {
  const { refreshUser } = useAuth()
  const input = useRef<HTMLInputElement>(null)
  const upload = useRef<HTMLButtonElement>(null)
  const src = useAvatarSrc(user.imageUrl)
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  const change = async (avatarFileId: string | null, done: string) => {
    await usersAPI.updateProfile({ avatarFileId })
    await refreshUser()
    toast.success(done)
  }

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) return setError("Choose an image file.")
    if (file.size > MAX_PHOTO) return setError("Choose an image of 5 MB or less.")
    setError(null)
    setBusy("upload")
    let uploaded: { id: string }
    try {
      uploaded = await filesAPI.uploadFile(file, { purpose: "avatar" })
    } catch (err) {
      toast.error(await uploadFailure(err, file, undefined, PHOTO_FAILED))
      setBusy(null)
      return
    }
    try {
      await change(uploaded.id, "Photo updated")
    } catch (err) {
      toast.error(messageOf(err, PHOTO_FAILED))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setError(null)
    setBusy("remove")
    try {
      await change(null, "Photo removed")
      upload.current?.focus()
    } catch (err) {
      toast.error(messageOf(err, PHOTO_FAILED))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsSection title="Photo">
      <div className="flex flex-wrap items-center gap-4">
        <UserAvatar
          user={{ id: user.id, first_name: user.firstName, last_name: user.lastName }}
          src={src}
          size="2xl"
          className="max-lg:size-[4rem]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept="image/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => void pick(event)}
          />
          <Button
            ref={upload}
            type="button"
            variant="outline"
            aria-disabled={!!busy || undefined}
            aria-busy={busy === "upload" || undefined}
            aria-describedby={error ? errorId : undefined}
            onClick={() => !busy && input.current?.click()}
          >
            {busy === "upload" ? "Uploading" : "Upload photo"}
          </Button>
          {user.imageUrl && (
            <Button
              type="button"
              variant="ghost"
              aria-disabled={!!busy || undefined}
              aria-busy={busy === "remove" || undefined}
              onClick={() => !busy && void remove()}
            >
              {busy === "remove" ? "Removing" : "Remove"}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <FieldError id={errorId} className="mt-0">
          {error}
        </FieldError>
      )}
    </SettingsSection>
  )
}

function NameSection({ user, onDirty }: { user: Me; onDirty: (dirty: boolean) => void }) {
  const { refreshUser } = useAuth()
  const [first, setFirst] = useState(user.firstName ?? "")
  const [last, setLast] = useState(user.lastName ?? "")
  const [saving, setSaving] = useState(false)
  const ids = useId()
  const firstField = useRef<HTMLInputElement>(null)

  const firstError = first.trim() ? null : "Enter your first name."
  const dirty = first.trim() !== (user.firstName ?? "") || last.trim() !== (user.lastName ?? "")
  const valid = !firstError && first.trim().length <= NAME_MAX && last.trim().length <= NAME_MAX
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || !valid || saving) return
    setSaving(true)
    try {
      await usersAPI.updateProfile({ firstName: first.trim(), lastName: last.trim() })
      await refreshUser()
      setFirst(first.trim())
      setLast(last.trim())
      // The Save button disables once the name is saved, so focus goes back to the field
      if (!(document.activeElement instanceof HTMLInputElement)) firstField.current?.focus()
      toast.success("Name saved")
    } catch (err) {
      toast.error(messageOf(err, NAME_FAILED))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      title="Name"
      footer={
        <Button
          type="submit"
          form={`${ids}-form`}
          variant={dirty || saving ? "default" : "secondary"}
          disabled={!dirty || !valid || saving}
        >
          {saving ? "Saving" : "Save"}
        </Button>
      }
    >
      <form id={`${ids}-form`} onSubmit={save} noValidate className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-first`} className={FIELD_LABEL}>
            First name
          </label>
          <Input
            ref={firstField}
            id={`${ids}-first`}
            value={first}
            maxLength={NAME_MAX}
            autoComplete="given-name"
            onChange={(event) => setFirst(event.target.value)}
            aria-invalid={dirty && firstError ? true : undefined}
            aria-describedby={dirty && firstError ? `${ids}-first-error` : undefined}
          />
          {dirty && firstError && (
            <FieldError role="status" id={`${ids}-first-error`} className="mt-0">
              {firstError}
            </FieldError>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-last`} className={FIELD_LABEL}>
            Last name
          </label>
          <Input
            id={`${ids}-last`}
            value={last}
            maxLength={NAME_MAX}
            autoComplete="family-name"
            onChange={(event) => setLast(event.target.value)}
          />
        </div>
      </form>
    </SettingsSection>
  )
}

function AccountSection({ user }: { user: Me }) {
  const email = user.emailAddresses[0]?.emailAddress
  const since = formatLongDate(parseServerDate(user.createdAt))
  return (
    <SettingsSection title="Account">
      <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-ui leading-[1.45]">
        {email && (
          <>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="min-w-0 font-medium wrap-anywhere text-foreground">{email}</dd>
          </>
        )}
        {since && (
          <>
            <dt className="text-muted-foreground">Member since</dt>
            <dd className="font-medium text-foreground">{since}</dd>
          </>
        )}
      </dl>
    </SettingsSection>
  )
}

function AppearanceSection() {
  const { themeMode, setThemeMode } = useDarkMode()
  return (
    <SettingsSection title="Appearance" description="System follows your device's setting.">
      <SegmentedControl label="Theme" value={themeMode} onChange={setThemeMode} options={THEME_OPTIONS} className="self-start" />
    </SettingsSection>
  )
}

function PasswordSection({ email }: { email: string }) {
  const [sending, setSending] = useState(false)

  const send = async () => {
    if (!email || sending) return
    setSending(true)
    try {
      await authAPI.forgotPassword(email)
      toast.success(`A reset link is on its way to ${email}`)
    } catch (err) {
      toast.error(messageOf(err, RESET_FAILED))
    } finally {
      setSending(false)
    }
  }

  return (
    <SettingsSection title="Password">
      <div className="flex flex-col items-start gap-2">
        <Button type="button" variant="secondary" disabled={!email || sending} aria-busy={sending || undefined} onClick={() => void send()}>
          {sending ? "Sending" : "Send me a password reset link"}
        </Button>
        <p className="text-caption text-muted-foreground">
          No email after a few minutes? An admin can see in the setup check if it failed, or find the link in the server log if email isn't
          set up.
        </p>
      </div>
    </SettingsSection>
  )
}
