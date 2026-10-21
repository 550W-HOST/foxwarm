import sharp from 'sharp';

let fixtures: Promise<{ overBytes: Buffer; overPixels: Buffer }> | undefined;

/** Genuine PNGs: an uncompressed normal-resolution image and a compressible large raster. */
export function oversizedVisionImages(): Promise<{ overBytes: Buffer; overPixels: Buffer }> {
  fixtures ||= (async () => {
    const overBytes = await sharp({
      create: { width: 4096, height: 3072, channels: 3, background: 'red' },
    }).png({ compressionLevel: 0 }).toBuffer();
    const overPixels = await sharp({
      create: { width: 8193, height: 8193, channels: 3, background: 'blue' },
      limitInputPixels: false,
    }).png().toBuffer();
    return { overBytes, overPixels };
  })();
  return fixtures;
}
