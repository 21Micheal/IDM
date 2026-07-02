/**
 * Generate favicon assets from the Flaxem logo.
 *
 * Emits crisp, size-specific PNGs into `public/` (sharp downscales far better
 * than a browser scaling a single 180px image down to 16/32px). Re-run whenever
 * the source logo changes:  npm run favicons
 */
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.join(root, "src/assets/images/fselogo.png");
const outDir = path.join(root, "public");

const targets = [
  { file: "favicon-16x16.png", size: 16 },
  { file: "favicon-32x32.png", size: 32 },
  { file: "favicon.png", size: 48 }, // generic fallback for older/unknown sizes
  { file: "apple-touch-icon.png", size: 180 }, // iOS home-screen / bookmark
];

for (const { file, size } of targets) {
  await sharp(source)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(outDir, file));
  console.log(`✓ public/${file} (${size}×${size})`);
}
