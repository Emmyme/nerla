/** Bytes to base64 and back, for Yjs states and positions */
export const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))

export const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

/** A blob as a base64 data URL */
export const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
