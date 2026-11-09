/** Where the website is served, without a trailing slash */
export const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:3001").replace(/\/+$/, "")

/** The bundled desktop app's own origins, on macOS and Linux, then on Windows (WebView2) */
export const DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
