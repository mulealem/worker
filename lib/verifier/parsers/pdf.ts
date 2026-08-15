/**
 * Shared PDF text extraction. Wraps pdf-parse v2's `PDFParse` class API.
 * Used by CBE, Dashen, Zemen, CBE Birr, and M-Pesa parsers.
 */

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { log } from "../../log.js";

const logv = log.child({ module: "parser.pdf" });

interface PdfParseClass {
  new (opts: { data: Buffer | Uint8Array }): {
    getText(): Promise<{ text: string }>;
    destroy(): Promise<void>;
  };
}

const requirePdf = createRequire(import.meta.url);

function loadPdfParseClass(): PdfParseClass {
  // pdf-parse v2 ships ESM with named exports and CJS as a fallback. Use
  // createRequire so the CJS shim is loaded reliably under Next.js's bundler.
  const mod = requirePdf("pdf-parse") as
    | { PDFParse?: PdfParseClass }
    | { default?: { PDFParse?: PdfParseClass } };
  const cls =
    (mod as { PDFParse?: PdfParseClass }).PDFParse ??
    (mod as { default?: { PDFParse?: PdfParseClass } }).default?.PDFParse;
  if (!cls) {
    throw new Error(
      "pdf-parse v2 PDFParse class not found. Update lib/verifier/parsers/pdf.ts to match your installed version.",
    );
  }
  return cls;
}

let PdfParseClass: PdfParseClass | null = null;

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const startedAt = Date.now();
  logv.info(`extractPdfText start bytes=${buffer.length}`);
  if (!PdfParseClass) {
    PdfParseClass = loadPdfParseClass();
  }
  const parser = new PdfParseClass({ data: buffer });
  try {
    const result = await parser.getText();
    logv.info(
      `[verifier] extractPdfText done elapsedMs=${Date.now() - startedAt} ` +
        `textLen=${result.text.length}`,
    );
    return result.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logv.warn(
      `[verifier] extractPdfText FAIL elapsedMs=${Date.now() - startedAt} message=${msg}`,
    );
    throw err;
  } finally {
    await parser.destroy();
  }
}
