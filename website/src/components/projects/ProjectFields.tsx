import type { Ref } from "react"
import { FieldError } from "@/components/ui/field-error"
import { SymbolPicker } from "@/components/ui/identity-tile"
import type { SymbolKey } from "@/components/ui/symbols"
import { Input } from "@/components/ui/input"
import { formatProjectKey } from "./projectKey"
import { SwatchPicker } from "./SwatchPicker"

const TEXTAREA =
  "w-full resize-none rounded-md border-[0.0625rem] border-input bg-card px-3.5 py-2 text-body leading-[1.55] transition-colors duration-150 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:ring-offset-[0.125rem] focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"

type FieldProps<T> = {
  id: string
  value: T
  onChange: (value: T) => void
}

export function NameField({
  id,
  value,
  onChange,
  error,
  inputRef,
  autoFocus = false,
}: FieldProps<string> & { error: string | null; inputRef: Ref<HTMLInputElement>; autoFocus?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="form-label mb-0">
        Name
      </label>
      <Input
        ref={inputRef}
        id={id}
        autoFocus={autoFocus}
        required
        autoComplete="off"
        maxLength={255}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Project name"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <FieldError id={`${id}-error`} className="mt-0">
          {error}
        </FieldError>
      )}
    </div>
  )
}

export function KeyField({
  id,
  value,
  onChange,
  error,
  hint,
  inputRef,
}: FieldProps<string> & { error: string | null; hint: string; inputRef: Ref<HTMLInputElement> }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="form-label mb-0">
        Key
      </label>
      <div className="flex flex-col gap-x-3 gap-y-1.5 sm:flex-row sm:items-center">
        <Input
          ref={inputRef}
          id={id}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={5}
          value={value}
          onChange={(e) => onChange(formatProjectKey(e.target.value))}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
          className="w-[8rem] shrink-0 font-medium tracking-[0.04em] tabular-nums"
        />
        <p id={`${id}-hint`} className="text-caption leading-[1.45] text-muted-foreground">
          {hint}
        </p>
      </div>
      {error && (
        <FieldError id={`${id}-error`} className="mt-0">
          {error}
        </FieldError>
      )}
    </div>
  )
}

export function ColorField({ id, value, onChange }: FieldProps<string | null>) {
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="form-label mb-0">
        Color
      </span>
      <SwatchPicker value={value} onChange={onChange} labelledBy={id} />
    </div>
  )
}

export function SymbolField({ id, value, onChange }: FieldProps<SymbolKey | null>) {
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="form-label mb-0">
        Symbol
      </span>
      <SymbolPicker value={value} onChange={onChange} labelledBy={id} />
    </div>
  )
}

export function DescriptionField({ id, value, onChange }: FieldProps<string>) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="form-label mb-0">
        Description
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What the project is about"
        rows={3}
        maxLength={10000}
        className={TEXTAREA}
      />
    </div>
  )
}
