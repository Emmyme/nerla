import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { createHash } from "node:crypto"
import { cpSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, URL } from "node:url"
import type { Plugin } from "vite"

// Date tests check the split between UTC and local days, so they run in one fixed zone on every machine
if (process.env.VITEST) process.env.TZ = "Europe/Stockholm"

// The licences of the shipped dependencies ask that their notices travel with every build, web and desktop.
// `yarn notices` writes the file, and the build warns when yarn.lock has changed since
const notices: Plugin = {
  name: "nerla-third-party-notices",
  apply: "build",
  generateBundle() {
    const source = readFileSync(fileURLToPath(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url)), "utf8")
    const lock = readFileSync(fileURLToPath(new URL("../yarn.lock", import.meta.url)), "utf8").replace(/\r\n/g, "\n")
    const hash = createHash("sha256").update(lock).digest("hex").slice(0, 16)
    if (!source.includes(`yarn.lock ${hash}`)) this.warn("THIRD_PARTY_NOTICES.md is older than yarn.lock. Run `yarn notices`.")
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source })
  },
}

// Every font a board can ask for, CJK and pasted-in families included, comes from the app's own origin, or for the
// desktop app from the user's Nerla server, so no build ever reaches a font CDN. Liberation stays out for its GPL
// licence, as no board picks it. Excalidraw's last resort, esm.sh, points at the same place, so an unserved font fails there
const EXCALIDRAW_CDN = "https://esm.sh/"
// Shared with scripts/third-party-notices.mjs, so the notices list only the fonts that ship
const EXCALIDRAW_LEFT_OUT: string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("./excalidraw-fonts-left-out.json", import.meta.url)), "utf8"),
)
const EXCALIDRAW_MISSING = '${window.EXCALIDRAW_ASSET_PATH || window.location.origin + "/excalidraw-assets/"}missing/'
const localFonts = (code: string) => code.replaceAll(EXCALIDRAW_CDN, () => EXCALIDRAW_MISSING)
let desktopFonts: string | null = null
const excalidrawFonts: Plugin = {
  name: "nerla-excalidraw-fonts",
  apply: () => !process.env.VITEST,
  // The dev server bundles Excalidraw ahead of time, past the transform below
  config: () => ({
    optimizeDeps: {
      esbuildOptions: {
        plugins: [
          {
            name: "nerla-excalidraw-local-fonts",
            setup(build) {
              build.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/].*\.js$/ }, (args) => {
                const code = readFileSync(args.path, "utf8")
                return code.includes(EXCALIDRAW_CDN) ? { contents: localFonts(code), loader: "js" } : undefined
              })
            },
          },
        ],
      },
    },
  }),
  // Tauri sets TAURI_ENV_PLATFORM for the website build it runs before bundling the installer
  configResolved({ command, root, build }) {
    if (command === "build" && process.env.TAURI_ENV_PLATFORM) desktopFonts = resolve(root, build.outDir, "excalidraw-assets")
  },
  buildStart() {
    const source = join(dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")), "fonts")
    const target = fileURLToPath(new URL("./public/excalidraw-assets/fonts", import.meta.url))
    rmSync(target, { recursive: true, force: true })
    cpSync(source, target, { recursive: true, filter: (path) => !EXCALIDRAW_LEFT_OUT.some((family) => path === join(source, family)) })
  },
  writeBundle() {
    if (desktopFonts) rmSync(desktopFonts, { recursive: true, force: true })
  },
  transform(code, id) {
    if (!id.includes("@excalidraw") || !code.includes(EXCALIDRAW_CDN)) return null
    return { code: localFonts(code), map: null }
  },
}

const config = {
  plugins: [react(), notices, excalidrawFonts],
  resolve: {
    alias: {
      // The "@/*" path alias from tsconfig
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 3001,
  },
  test: {
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // One pre-bundled file instead of the icon barrel's thousands of modules in every test file
    deps: { optimizer: { web: { enabled: true, include: ["@phosphor-icons/react"] } } },
    // Node 25+ ships its own global localStorage, which hides the jsdom one. Vitest reads pool options from the root
    // only, and the .test.ts files that ask for jsdom need the flag too
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--no-experimental-webstorage"] } },
    // Components get a DOM, and everything else skips the cost of building one per file
    projects: [
      { extends: true, test: { name: "node", include: ["src/**/*.test.ts"], environment: "node" } },
      { extends: true, test: { name: "dom", include: ["src/**/*.test.tsx"], environment: "jsdom" } },
    ],
  },
  build: {
    outDir: "dist",
  },
}

export default defineConfig(config)
