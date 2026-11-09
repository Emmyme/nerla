import sharp from "sharp"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const catPath = join(root, "branding", "cat-logo.png")

async function buildAppIcon(size, { background = { r: 0, g: 0, b: 0, alpha: 0 }, scale = 0.94 } = {}) {
  const catWidth = Math.round(scale * size)
  const cat = await sharp(catPath).resize({ width: catWidth }).toBuffer()
  const { height: catHeight } = await sharp(cat).metadata()
  const left = Math.round((size - catWidth) / 2)
  const top = Math.round((size - catHeight) / 2)

  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: cat, top, left }])
    .png()
    .toBuffer()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputs = [
    [1024, join(root, "branding", "app-icon-1024.png")],
    [64, join(root, "website", "public", "favicon.png")],
    [180, join(root, "website", "public", "apple-touch-icon.png"), { background: "#F8F8FA", scale: 0.78 }],
  ]
  for (const [size, file, options] of outputs) {
    await sharp(await buildAppIcon(size, options)).toFile(file)
    console.log(`wrote ${file}`)
  }
  const sidebarLogo = join(root, "website", "src", "assets", "cat-logo.png")
  await sharp(catPath).resize({ height: 128 }).png().toFile(sidebarLogo)
  console.log(`wrote ${sidebarLogo}`)
}
