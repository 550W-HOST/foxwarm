// Real 8x8 animated GIFs from sharp: one with 2 frames and one with 121 frames, one past the
// 120-frame bound of the artifact raster metadata. Prints {"images": [base64, base64]}.
import sharp from 'sharp'
const images = []
for (const pages of [2, 121]) {
  const bytes = Buffer.alloc(8 * 8 * pages * 3)
  for (let frame = 0; frame < pages; frame++) for (let pixel = 0; pixel < 64; pixel++) bytes.fill(frame & (1 << (pixel % 7)) ? 255 : 0, (frame * 64 + pixel) * 3, (frame * 64 + pixel + 1) * 3)
  const image = await sharp(bytes, { raw: { width: 8, height: 8 * pages, channels: 3, pageHeight: 8 } }).gif({ colours: 2, interFrameMaxError: 0, interPaletteMaxError: 0 }).toBuffer()
  if ((await sharp(image, { animated: true }).metadata()).pages !== pages) throw new Error('Fixture did not produce the requested animation')
  images.push(image.toString('base64'))
}
console.log(JSON.stringify({ images }))
