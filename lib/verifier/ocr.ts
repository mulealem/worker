/**
 * OCR via tesseract.js (pure JavaScript — no system Tesseract install needed).
 *
 * `verifyFromImage` in `./verify.ts` first scans the receipt for a QR code
 * (CBE always includes one). If no QR resolves to a known bank URL, this
 * module runs as the fallback: tesseract reads the text, and we look for a
 * known-bank URL inside it. Dashen / Awash / BoA / Zemen always end up here
 * because their receipt URLs are opaque session tokens that can't be
 * reconstructed from any visible ID.
 *
 * The first call still has a multi-second cold-start as the WASM and
 * eng.traineddata assets are loaded from disk.
 */

import { createWorker, type Worker } from "tesseract.js";
import { findBankUrl } from "./detector.js";
import type { Provider } from "./types.js";
import { log } from "..\/log.js";
const logv = log.child({ module: "ocr" });

let _workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!_workerPromise) {
    _workerPromise = (async () => {
      const worker = await createWorker("eng");
      return worker;
    })();
  }
  return _workerPromise;
}

// Hard cap on a single OCR call. tesseract.js's `worker.recognize()` is not
// cancellable from the outside (it owns the WASM heap), so we race it against
// a timeout AND terminate the underlying worker on timeout — otherwise the
// stuck WASM job would persist into subsequent calls and amplify the problem.
// Keep this comfortably below the dashboard's sandbox route timeout
// (15 000 ms in `app/api/sandbox/verify/route.ts`).
const OCR_TIMEOUT_MS = 25_000;

export async function extractText(imageBytes: Buffer | Uint8Array): Promise<string | null> {
  const startedAt = Date.now();
  logv.info(`tesseract.extractText start bytes=${imageBytes.length}`);
  const worker = await getWorker();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      worker.recognize(Buffer.from(imageBytes)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OCR timed out after ${OCR_TIMEOUT_MS}ms`)),
          OCR_TIMEOUT_MS,
        );
      }),
    ]);
    const { data } = result;
    logv.info(
      `[verifier] tesseract.extractText done elapsedMs=${Date.now() - startedAt} ` +
        `textLen=${data.text.length} confidence=${data.confidence ?? "<n/a>"}`,
    );
    return data.text;
  } catch (err) {
    logv.error(
      `[verifier] tesseract.extractText FAILED elapsedMs=${Date.now() - startedAt} ` +
        `err=${err instanceof Error ? err.message : String(err)} — terminating worker so future calls get a fresh heap`,
    );
    // Drop the cached worker so the next call rebuilds it; the in-flight WASM
    // call is abandoned (Node will GC it once its refs drop).
    _workerPromise = null;
    try {
      await worker.terminate();
    } catch {
      // already torn down or in an invalid state; nothing to do.
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Heuristically identify a bank provider from OCR'd screenshot text.
 * Returns a Provider key, or null if the text doesn't look like a known bank.
 *
 * Note: only CBE and Telebirr have screenshot parsers; Dashen/Awash/BOA/Zemen
 * screenshots are still useful because OCR can find a URL inside the image
 * (handled in `verify.ts` via `findBankUrl`).
 */
export function detectProviderFromText(text: string): Provider | null {
  const t = text.toLowerCase();

  if (t.includes("telebirr")) return "telebirr";
  if (t.includes("transaction number") && t.includes("transaction time")) return "telebirr";
  if (t.includes("transaction to") && t.includes("transaction type")) return "telebirr";

  return null;
}

/**
 * Convenience: run OCR, return text + a candidate URL found inside it.
 * Used by `verify.ts` to short-circuit to the URL flow for non-CBE/Telebirr
 * banks (Dashen, Awash, BOA, Zemen).
 */
export async function ocrAndFindUrl(
  imageBytes: Buffer | Uint8Array,
): Promise<{ text: string | null; urlHit: ReturnType<typeof findBankUrl> }> {
  const text = await extractText(imageBytes);
  if (text == null) {
    return { text: null, urlHit: null };
  }
  const urlHit = findBankUrl(text);
  return { text, urlHit };
}
