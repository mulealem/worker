/**
 * Fetcher for the 8 bank receipt transports.
 *
 *   - HTML          : Telebirr, Awash        → fetchHtml (transport pool)
 *   - PDF           : CBE, Dashen, Zemen, CBE Birr → fetchPdf (transport pool)
 *   - JSON API      : BoA, CBE token, M-Pesa → fetch*Json / fetchCbeApi / fetchMpesaApi
 *
 * Every transport goes through the per-provider `TransportPool` so we get
 * retries, regional relay fallbacks (Telebirr / M-Pesa), and circuit
 * breakers for free. Playwright is no longer used as a fallback anywhere.
 */

import { Buffer } from "node:buffer";
import { getProviderPool } from "./providers.js";
import { TransportError } from "./transport.js";
import { log } from "..\/log.js";

const logv = log.child({ module: "fetcher" });

/**
 * Fetch an HTML page through the provider's transport pool. The pool runs
 * the direct adapter first, then any configured regional relays.
 */
export async function fetchHtml(url: string, provider: import("./types.js").Provider): Promise<string> {
  const startedAt = Date.now();
  logv.info(`fetchHtml url=${url} provider=${provider}`);
  const outcome = await getProviderPool(provider).fetch(url);
  switch (outcome.kind) {
    case "ok": {
      const body = outcome.result.body;
      logv.info(
        `[verifier] fetchHtml OK url=${url} adapter=${outcome.adapterId} ` +
          `bodyLen=${body.length} elapsedMs=${Date.now() - startedAt}`,
      );
      return body;
    }
    case "permanent_fail": {
      const msg = `fetchHtml permanent fail (${outcome.status ?? "?"}): ${outcome.error}`;
      logv.warn(`[verifier] ${msg} url=${url}`);
      throw new TransportError(
        outcome.status !== null && outcome.status >= 400 && outcome.status < 500 ? "STATUS_4XX" : "STATUS_5XX",
        msg,
        { status: outcome.status, retryable: false },
      );
    }
    case "exhausted": {
      const msg = `fetchHtml exhausted: ${outcome.error} (${outcome.adapterErrors.map((e) => `${e.id}:${e.error}`).join(", ")})`;
      logv.warn(`[verifier] ${msg} url=${url}`);
      throw new TransportError("NETWORK", msg, { retryable: false });
    }
  }
}

/** Fetch a PDF and return its bytes (pdf-parse consumes a Buffer). */
export async function fetchPdf(url: string, provider: import("./types.js").Provider): Promise<Buffer> {
  const startedAt = Date.now();
  logv.info(`fetchPdf url=${url} provider=${provider}`);
  const outcome = await getProviderPool(provider).fetch(url);
  if (outcome.kind === "ok") {
    const buf = Buffer.from(outcome.result.body, "binary");
    logv.info(
      `[verifier] fetchPdf OK url=${url} adapter=${outcome.adapterId} ` +
        `bytes=${buf.length} contentType=${outcome.result.contentType ?? "<unknown>"} ` +
        `elapsedMs=${Date.now() - startedAt}`,
    );
    return buf;
  }
  if (outcome.kind === "permanent_fail") {
    const msg = `fetchPdf permanent fail (${outcome.status ?? "?"}): ${outcome.error}`;
    logv.warn(`[verifier] ${msg} url=${url}`);
    throw new TransportError(
      outcome.status !== null && outcome.status >= 400 && outcome.status < 500 ? "STATUS_4XX" : "STATUS_5XX",
      msg,
      { status: outcome.status, retryable: false },
    );
  }
  const msg = `fetchPdf exhausted: ${outcome.error} (${outcome.adapterErrors.map((e) => `${e.id}:${e.error}`).join(", ")})`;
  logv.warn(`[verifier] ${msg} url=${url}`);
  throw new TransportError("NETWORK", msg, { retryable: false });
}

interface BoaSlip {
  body?: Array<Record<string, string | number | null>>;
}

/**
 * BoA exposes a JSON API alongside the public HTML slip. We rewrite the
 * https://cs.bankofabyssinia.com/slip/?trx=... URL to the corresponding
 * /api/onlineSlip/getDetails/?id=... endpoint and return the parsed JSON.
 */
export async function fetchBoaJson(slipUrl: string): Promise<BoaSlip> {
  const startedAt = Date.now();
  logv.info(`fetchBoaJson slipUrl=${slipUrl}`);
  const trx = new URL(slipUrl).searchParams.get("trx");
  if (!trx) {
    logv.warn(`fetchBoaJson missing trx query param url=${slipUrl}`);
    throw new Error("BoA URL is missing the 'trx' query parameter.");
  }
  const apiUrl = `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${encodeURIComponent(trx)}`;
  const outcome = await getProviderPool("boa").fetch(apiUrl);
  if (outcome.kind === "ok") {
    try {
      const payload = JSON.parse(outcome.result.body) as BoaSlip;
      logv.info(
        `[verifier] fetchBoaJson OK url=${apiUrl} adapter=${outcome.adapterId} ` +
          `bodyLen=${payload.body?.length ?? 0} elapsedMs=${Date.now() - startedAt}`,
      );
      return payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TransportError("INVALID_BODY", `BoA API returned non-JSON: ${msg}`, {
        retryable: false,
        cause: err,
      });
    }
  }
  if (outcome.kind === "permanent_fail") {
    throw new TransportError(
      outcome.status !== null && outcome.status >= 400 && outcome.status < 500 ? "STATUS_4XX" : "STATUS_5XX",
      `HTTP ${outcome.status} from BoA API.`,
      { status: outcome.status, retryable: false },
    );
  }
  throw new TransportError("NETWORK", `fetchBoaJson exhausted: ${outcome.error}`, {
    retryable: false,
  });
}

/**
 * CBE receipt API fetcher. Extracts the last path segment from URLs like
 * `https://mbreciept.cbe.com.et/{token}` and calls the JSON API, retrying
 * the v2-prefix / unprefixed variants. Goes through the CBE transport pool,
 * which retries on 408/429/5xx up to 4 times with the configured delay.
 */
export async function fetchCbeApi(receiptUrl: string): Promise<{ json: unknown; raw: string }> {
  const startedAt = Date.now();
  logv.info(`fetchCbeApi receiptUrl=${receiptUrl}`);

  const token = receiptUrl.split("/").pop()?.trim();
  if (!token || token.length < 6) {
    throw new Error(`Could not extract token from receipt URL: ${receiptUrl}`);
  }

  const candidates: string[] = [token];
  if (token.startsWith("v2-")) candidates.push(token.slice(3));
  if (token.startsWith("v1-")) candidates.push(token.slice(3));

  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    const apiUrl =
      `https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/${encodeURIComponent(candidate)}`;
    logv.info(
      `fetchCbeApi trying apiUrl=${apiUrl} ` +
        `candidateLen=${candidate.length} attempt=${candidates.indexOf(candidate) + 1}/${candidates.length}`,
    );

    const outcome = await getProviderPool("cbe").fetch(apiUrl);
    if (outcome.kind === "ok") {
      const raw = outcome.result.body;
      try {
        const json = JSON.parse(raw);
        logv.info(
          `[verifier] fetchCbeApi OK apiUrl=${apiUrl} adapter=${outcome.adapterId} ` +
            `elapsedMs=${Date.now() - startedAt}`,
        );
        return { json, raw };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        logv.warn(
          `[verifier] fetchCbeApi non-JSON apiUrl=${apiUrl} ` +
            `elapsedMs=${Date.now() - startedAt} message=${lastErr.message}`,
        );
        continue;
      }
    }
    if (outcome.kind === "permanent_fail") {
      if (outcome.status === 404) {
        logv.warn(`fetchCbeApi 404 apiUrl=${apiUrl}`);
        throw new TransportError("STATUS_4XX", `CBE receipt not found (404)`, {
          status: 404,
          retryable: false,
        });
      }
      lastErr = new TransportError(
        "STATUS_4XX",
        `HTTP ${outcome.status} from CBE API.`,
        { status: outcome.status, retryable: false },
      );
      continue;
    }
    lastErr = new TransportError("NETWORK", `fetchCbeApi exhausted: ${outcome.error}`, {
      retryable: false,
    });
  }

  throw lastErr ?? new Error("CBE API call failed for all token variations.");
}

interface MpesaApiResponse {
  responseCode?: number;
  responseDescription?: string;
  base64Data?: string;
}

/**
 * M-Pesa receipt API. Receives a receipt number, calls
 * `https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo=...`,
 * and returns the base64-encoded PDF inside `base64Data`. The transport pool
 * is what handles the foreign-hosting failover (Ethiopia regional relays).
 */
export async function fetchMpesaApi(receiptNumber: string): Promise<{ pdfBuffer: Buffer; raw: unknown }> {
  const startedAt = Date.now();
  logv.info(`fetchMpesaApi receiptNumber=${receiptNumber}`);
  const url = `https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo=${encodeURIComponent(receiptNumber)}`;
  const outcome = await getProviderPool("mpesa").fetch(url);
  if (outcome.kind !== "ok") {
    if (outcome.kind === "permanent_fail" && outcome.status === 404) {
      throw new TransportError("STATUS_4XX", `M-Pesa receipt not found`, {
        status: 404,
        retryable: false,
      });
    }
    throw new TransportError(
      "NETWORK",
      outcome.kind === "exhausted" ? `M-Pesa exhausted: ${outcome.error}` : outcome.error,
      { retryable: false },
    );
  }
  let payload: MpesaApiResponse;
  try {
    payload = JSON.parse(outcome.result.body) as MpesaApiResponse;
  } catch (err) {
    throw new TransportError("INVALID_BODY", "M-Pesa API returned non-JSON", {
      retryable: false,
      cause: err,
    });
  }
  if (!payload.base64Data) {
    throw new TransportError(
      "INVALID_BODY",
      `M-Pesa API returned no base64Data: ${payload.responseDescription ?? "<no description>"}`,
      { retryable: false },
    );
  }
  const pdfBuffer = Buffer.from(payload.base64Data, "base64");
  logv.info(
    `[verifier] fetchMpesaApi OK adapter=${outcome.adapterId} pdfBytes=${pdfBuffer.length} ` +
      `elapsedMs=${Date.now() - startedAt}`,
  );
  return { pdfBuffer, raw: payload };
}
