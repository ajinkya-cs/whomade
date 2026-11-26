import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array; // RGBA
}

/** Decodes PNG or JPEG to RGBA. Returns undefined for other formats or broken files. */
export function decode(bytes: Uint8Array, format: string): Pixels | undefined {
  try {
    if (format === 'png') {
      const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return { width: png.width, height: png.height, data: png.data };
    }
    if (format === 'jpeg') {
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 1024 });
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch {
    // Corrupt or unsupported encoding (e.g. arithmetic-coded JPEG).
  }
  return undefined;
}
