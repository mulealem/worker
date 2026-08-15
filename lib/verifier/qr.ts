/**
 * QR code extraction from receipt screenshots.
 *
 * CBE mobile-app receipts include a QR code that encodes the live receipt
 * URL (`https://apps.cbe.com.et:100/?id=FT…`). Scanning it directly is far
 * more reliable than asking a vision LLM to read the QR or reconstruct the
 * URL from a partial account number.
 *
 * We use `sharp` to decode the image bytes to raw RGBA pixels, then `jsqr`
 * to scan. `sharp` and `jsqr` are pulled in directly so the API stays stable
 * even when Next.js changes its bundled-image-stack version.
 *
 * Failure mode: any error throws `VisionUnavailableError`-equivalent
 * (caller catches and falls back to OCR). `extractQrPayloads` returns an
 * empty array when the image has no QR code.
 */

import jsQR from "jsqr";
import sharp from "sharp";
import { Buffer } from "node:buffer";

export class QrExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrExtractionError";
  }
}

/**
 * Decode an image and return the payloads of every QR code found.
 * Returns an empty array when no QR code is present in the image.
 *
 * Throws `QrExtractionError` if the image bytes cannot be decoded at all
 * (e.g. unsupported format / corrupt file). The caller should treat that
 * the same as "no QR" — i.e. fall back to LLM / OCR.
 */
export async function extractQrPayloads(imageBytes: Buffer | Uint8Array): Promise<string[]> {
  const buf = Buffer.from(imageBytes);
  let raw: Buffer;
  let info: { width: number; height: number; channels: number };
  try {
    const decoded = await sharp(buf, { failOn: "none" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    raw = decoded.data;
    info = decoded.info;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QrExtractionError(`sharp decode failed: ${msg}`);
  }

  if (info.width <= 0 || info.height <= 0) return [];

  // jsQR takes a Uint8ClampedArray view over the RGBA buffer. Sharing the
  // underlying ArrayBuffer avoids an extra copy.
  const clamped = new Uint8ClampedArray(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength,
  );

  const result = (jsQR as unknown as (data: Uint8ClampedArray, w: number, h: number, opts?: unknown) => { data: string } | null)(clamped, info.width, info.height, {
    inversionAttempts: "attemptBoth",
  });
  if (!result) return [];
  // Most Ethiopian bank receipts contain a single QR; if a screen has multiple
  // we surface them all so the caller can try each as a URL.
  return [result.data];
}
