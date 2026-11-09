import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// The named type steps from globals.css, so text-ui is a size and never collides with a text color
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["micro", "caption", "ui", "body", "lead", "title", "page"] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** A small control keeps its look on phones and gets a 2.75rem touch area around it */
export const TAP =
  "max-lg:relative max-lg:after:absolute max-lg:after:left-1/2 max-lg:after:top-1/2 max-lg:after:h-11 max-lg:after:w-[max(100%,2.75rem)] max-lg:after:-translate-x-1/2 max-lg:after:-translate-y-1/2 max-lg:after:content-['']"

/** A click on a toast is not a click outside the dialog that is open beneath it */
export function keepToasts(event: Event) {
  if (event.target instanceof Element && event.target.closest("[data-sonner-toast]")) event.preventDefault()
}

/** The root font size in pixels, for turning rem values into pixels */
export const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
