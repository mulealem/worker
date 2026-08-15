/**
 * Provider detection.
 *
 * Strict allowlist: only these hostnames are ever fetched (SSRF protection).
 * `detectProvider(url)` returns the matching Provider or throws if the host
 * is not on the list.
 */

import type { Provider } from "./types.js";

export const ALLOWED_HOSTS: Record<string, Provider> = {
  "mbreciept.cbe.com.et": "cbe",
  "mb.cbe.com.et": "cbe",
  "receipt.dashensuperapp.com": "dashen",
  "awashpay.awashbank.com": "awash",
  "cs.bankofabyssinia.com": "boa",
  "share.zemenbank.com": "zemen",
  "transactioninfo.ethiotelecom.et": "telebirr",
  "cbepay1.cbe.com.et": "cbe-birr",
};

/** Hosts the verifier is allowed to talk to. Used to filter URLs scraped from SMS. */
export const ALLOWED_HOST_NAMES = Object.keys(ALLOWED_HOSTS);

export function detectProvider(url: string): Provider {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Only HTTPS URLs are accepted, got: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const provider = ALLOWED_HOSTS[host];
  if (!provider) {
    throw new Error(
      `Host ${host} is not supported. Supported hosts: ${ALLOWED_HOST_NAMES.join(", ")}`,
    );
  }
  return provider;
}

/**
 * Detect a known-bank URL anywhere in a free-text blob (SMS body or OCR output).
 * Returns the first matching URL or null. Walks the input left-to-right so the
 * first URL wins, which is what the customer pasted / the OCR found first.
 */
export function findBankUrl(text: string): { url: string; provider: Provider } | null {
  // Match http(s)://... greedily up to the first whitespace/quote/angle-bracket.
  const urlRe = /https:\/\/[^\s"'<>)\]}]+/gi;
  const matches = text.match(urlRe);
  if (!matches) return null;

  for (const raw of matches) {
    // Strip trailing punctuation that's commonly glued on by SMS templates.
    const url = raw.replace(/[.,;:!?)]+$/, "");
    try {
      const provider = detectProvider(url);
      return { url, provider };
    } catch {
      // Host not allow-listed — keep scanning for a known one.
    }
  }
  return null;
}
