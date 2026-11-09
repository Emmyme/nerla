import type { SVGProps } from "react"

/** A grinning face for the reactions. Phosphor has none, so it is drawn here on Phosphor's 256 grid, with the eyes and
 * grin cut out like the other icons */
export function GrinFace({ className, weight: _weight, ...props }: SVGProps<SVGSVGElement> & { weight?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M24 128a104 104 0 1 0 208 0a104 104 0 1 0-208 0Z M78 104a14 14 0 1 0 28 0a14 14 0 1 0-28 0Z M150 104a14 14 0 1 0 28 0a14 14 0 1 0-28 0Z M76 140h104a52 52 0 0 1-104 0Z"
      />
    </svg>
  )
}
