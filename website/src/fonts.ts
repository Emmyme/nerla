// Fonts are bundled rather than fetched, so they work offline and satisfy the
// desktop CSP (font-src 'self').

// Figtree  -> --font-body and --font-display
import "@fontsource/figtree/400.css"
import "@fontsource/figtree/500.css"
import "@fontsource/figtree/600.css"
import "@fontsource/figtree/700.css"
import "@fontsource/figtree/800.css"

// Atkinson Hyperlegible  -> --font-body and --font-display with easier reading on.
// The browser fetches its files only once text uses the family.
import "@fontsource/atkinson-hyperlegible/400.css"
import "@fontsource/atkinson-hyperlegible/700.css"

// JetBrains Mono  -> --font-mono
import "@fontsource/jetbrains-mono/400.css"
import "@fontsource/jetbrains-mono/500.css"
