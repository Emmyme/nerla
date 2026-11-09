import { useState, type CSSProperties, type ReactNode } from "react"
import { Toaster } from "sonner"
import { DarkModeProvider, useDarkMode } from "@/contexts/DarkModeContext"
import { AuthProvider } from "@/providers/AuthProvider"
import { IncomingCalls } from "@/components/call/IncomingCalls"
import { CheckCircle, IconContext, Info, Spinner, Warning } from "@/components/icons"
import { useToastsReachable } from "@/lib/toastFocus"

interface ProvidersProps {
  children: ReactNode
}

const toastSurface = {
  "--normal-bg": "var(--color-surface)",
  "--normal-border": "var(--color-border)",
  "--normal-text": "var(--color-text)",
  "--border-radius": "0.75rem",
  fontFamily: "inherit",
} as CSSProperties

// Toasts sit below the incoming call cards, which share the top right corner
function ThemedToaster({ below }: { below: number }) {
  const { resolvedMode } = useDarkMode()
  useToastsReachable()
  const top = `calc(var(--titlebar-h) + ${below > 0 ? below + 1.5 : 1}rem)`
  return (
    <Toaster
      theme={resolvedMode}
      position="top-right"
      offset={{ top, right: "1rem" }}
      mobileOffset={{ top, left: "1rem", right: "1rem" }}
      style={toastSurface}
      toastOptions={{ classNames: { description: "text-muted-foreground!" } }}
      icons={{
        success: <CheckCircle size={16} className="text-app-status-done" />,
        error: <Warning size={16} className="text-app-berry-text" />,
        info: <Info size={16} className="text-muted-foreground" />,
        warning: <Warning size={16} className="text-muted-foreground" />,
        loading: <Spinner size={16} className="animate-spin text-muted-foreground" />,
      }}
    />
  )
}

export default function Providers({ children }: ProvidersProps) {
  const [callsHeight, setCallsHeight] = useState(0)
  return (
    <IconContext.Provider value={{ weight: "regular" }}>
      <DarkModeProvider>
        <AuthProvider>
          {children}
          <IncomingCalls onHeight={setCallsHeight} />
          <ThemedToaster below={callsHeight} />
        </AuthProvider>
      </DarkModeProvider>
    </IconContext.Provider>
  )
}
