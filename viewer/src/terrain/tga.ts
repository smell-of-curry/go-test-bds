/**
 * Minimal TGA decode for Bedrock terrain tiles that ship as `.tga` only
 * (leaves, grass_side, cactus, fern, …).
 *
 * Supports uncompressed (type 2) and RLE (type 10) true-colour 24/32-bit.
 *
 * @param buf - Raw TGA bytes.
 * @returns ImageData-compatible RGBA buffer + size, or null if unsupported.
 */
export function decodeTga(
  buf: ArrayBuffer,
): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  const u8 = new Uint8Array(buf);
  if (u8.length < 18) return null;
  const idLen = u8[0]!;
  const cmapType = u8[1]!;
  const imageType = u8[2]!;
  if (cmapType !== 0) return null;
  if (imageType !== 2 && imageType !== 10) return null;
  const width = u8[12]! | (u8[13]! << 8);
  const height = u8[14]! | (u8[15]! << 8);
  const bpp = u8[16]!;
  const desc = u8[17]!;
  if (width <= 0 || height <= 0) return null;
  if (bpp !== 24 && bpp !== 32) return null;
  const topOrigin = (desc & 0x20) !== 0;
  const bytesPerPixel = bpp / 8;
  let offset = 18 + idLen;
  const pixelCount = width * height;
  const raw = new Uint8Array(pixelCount * bytesPerPixel);

  if (imageType === 2) {
    const needed = offset + raw.length;
    if (u8.length < needed) return null;
    raw.set(u8.subarray(offset, offset + raw.length));
  } else {
    let written = 0;
    while (written < pixelCount) {
      if (offset >= u8.length) return null;
      const packet = u8[offset++]!;
      const count = (packet & 0x7f) + 1;
      if (written + count > pixelCount) return null;
      if (packet & 0x80) {
        if (offset + bytesPerPixel > u8.length) return null;
        const px = u8.subarray(offset, offset + bytesPerPixel);
        offset += bytesPerPixel;
        for (let i = 0; i < count; i++) {
          raw.set(px, (written + i) * bytesPerPixel);
        }
        written += count;
      } else {
        const nbytes = count * bytesPerPixel;
        if (offset + nbytes > u8.length) return null;
        raw.set(u8.subarray(offset, offset + nbytes), written * bytesPerPixel);
        offset += nbytes;
        written += count;
      }
    }
  }

  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let y = 0; y < height; y++) {
    const srcY = topOrigin ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const si = (srcY * width + x) * bytesPerPixel;
      const di = (y * width + x) * 4;
      rgba[di] = raw[si + 2]!;
      rgba[di + 1] = raw[si + 1]!;
      rgba[di + 2] = raw[si]!;
      rgba[di + 3] = bytesPerPixel === 4 ? raw[si + 3]! : 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Decode TGA bytes into an ImageBitmap.
 *
 * @param buf - Raw TGA file.
 * @returns ImageBitmap or null when the format is unsupported.
 */
export async function bitmapFromTga(
  buf: ArrayBuffer,
): Promise<ImageBitmap | null> {
  const decoded = decodeTga(buf);
  if (!decoded) return null;
  const canvas = new OffscreenCanvas(decoded.width, decoded.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const rgba = new Uint8ClampedArray(decoded.rgba);
  ctx.putImageData(new ImageData(rgba, decoded.width, decoded.height), 0, 0);
  return createImageBitmap(canvas);
}
