/**
 * ETHQR — Ethiopia interoperable QR code (NBE / EthSwitch "IPS ET" standard).
 *
 * Pure codec: TLV parse/build, CRC-16/CCITT-FALSE validation, and payload
 * classification for the scan-verify route. No network, no state.
 *
 * Spec: "Standard for Interoperable QR Code Payments" (NBE, April 2024),
 * EMV® QRCPS Merchant-Presented Mode tailored to Ethiopia. Distilled in
 * flutter-version/doc/ethqr-notes.md. Two documented quirks of the official
 * sample: Tag 53 uses `586` (a Raast artifact — the body of the standard
 * says `230` for ETB) and the MAI-28 length digit doesn't match its content,
 * so the sample's CRC is not reproducible. We emit 230 and verify CRCs with
 * the canonical CRC-16/CCITT-FALSE check value instead.
 */

export interface EthQrTag {
  id: string;
  value: string;
}

export interface Mai28 {
  /** Scheme GUID (UUID without hyphens), sub-tag 00. */
  guid: string | null;
  /** Creditor institution BIC (8 or 11 chars), sub-tag 01. */
  bic: string | null;
  /** Merchant account number (≤24), sub-tag 02. */
  accountNumber: string | null;
}

export interface EthQrDecoded {
  kind: "ethqr";
  tags: Record<string, string>;
  mai28: Mai28 | null;
  crcValid: boolean;
  payloadFormatIndicator: string | null;
  /** `11` static / `12` dynamic / null when absent. */
  pointOfInitiation: string | null;
  merchantCategoryCode: string | null;
  currency: string | null;
  amount: string | null;
  merchantName: string | null;
  merchantCity: string | null;
  referenceLabel: string | null;
  purposeOfTransaction: string | null;
}

export type QrPayloadDecode =
  | { kind: "ethqr"; decoded: EthQrDecoded }
  /** Legacy closed-loop QRs (Annexure B: old Telebirr till numbers) — bare digit strings. */
  | { kind: "legacy_till"; value: string }
  | { kind: "unknown" };

const MAI_DOMESTIC_SCHEME_TAG = "28";
const MAX_PAYLOAD_LENGTH = 512;

/** Canonical CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection/xor-out). */
export function crc16CcittFalse(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Parse a TLV string. Returns tags in order; the value bytes are the raw
 * string slice (EMVCo says every value is ASCII here — we never need bytes).
 */
export function parseTlv(
  payload: string,
): { ok: true; tags: EthQrTag[] } | { ok: false; error: string } {
  if (payload.length === 0) return { ok: false, error: "empty payload" };
  if (!/^[0-9A-Za-z+\-.$/:%&#@?!=~_*,;'"()\[\]{}\s]*$/.test(payload)) {
    // EMVCo merchant-presented payloads are printable ASCII; reject binary garbage.
    if (/[^\x20-\x7e]/.test(payload)) return { ok: false, error: "non-printable characters" };
  }
  const tags: EthQrTag[] = [];
  let i = 0;
  while (i < payload.length) {
    if (i + 4 > payload.length) return { ok: false, error: `truncated tag at offset ${i}` };
    const id = payload.slice(i, i + 2);
    const lenStr = payload.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lenStr)) {
      return { ok: false, error: `malformed tag/length at offset ${i}` };
    }
    const len = Number(lenStr);
    const valueStart = i + 4;
    if (valueStart + len > payload.length) {
      return { ok: false, error: `tag ${id} length ${len} exceeds payload` };
    }
    tags.push({ id, value: payload.slice(valueStart, valueStart + len) });
    i = valueStart + len;
  }
  return { ok: true, tags };
}

export function encodeTlv(id: string, value: string): string {
  const len = value.length;
  if (len > 99) throw new Error(`tag ${id} value too long (${len} > 99)`);
  return `${id}${String(len).padStart(2, "0")}${value}`;
}

/** Parse the IPS ET merchant-account template (tag 28) sub-tags. */
export function parseMai28(value: string): Mai28 {
  const parsed = parseTlv(value);
  const mai: Mai28 = { guid: null, bic: null, accountNumber: null };
  if (!parsed.ok) return mai;
  for (const tag of parsed.tags) {
    if (tag.id === "00" && /^[0-9a-f]{32}$/i.test(tag.value)) mai.guid = tag.value.toLowerCase();
    if (tag.id === "01" && (tag.value.length === 8 || tag.value.length === 11)) mai.bic = tag.value;
    if (tag.id === "02" && tag.value.length >= 1 && tag.value.length <= 24) {
      mai.accountNumber = tag.value;
    }
  }
  return mai;
}

export function isCrcValid(payload: string): boolean {
  if (payload.length < 8) return false;
  const stated = payload.slice(-4);
  const recomputed = crc16CcittFalse(payload.slice(0, -4));
  return stated.toUpperCase() === recomputed;
}

/** Classify any scanned payload the way the scan-verify route needs it. */
export function decodeQrPayload(rawPayload: string): QrPayloadDecode {
  const payload = rawPayload.trim();
  if (!payload) return { kind: "unknown" };

  // Legacy closed-loop QRs: bare digit strings (old Telebirr merchant tills).
  if (/^\d{10,}$/.test(payload)) return { kind: "legacy_till", value: payload };

  const parsed = parseTlv(payload);
  if (!parsed.ok) return { kind: "unknown" };
  const hasCrc = parsed.tags.some((t) => t.id === "63");
  // An ETHQR/EMVCo payload always carries a CRC; anything TLV-shaped without
  // one is treated as unknown so we don't misreport arbitrary TLV strings.
  if (!hasCrc) return { kind: "unknown" };

  const tags: Record<string, string> = {};
  for (const t of parsed.tags) tags[t.id] = t.value;

  const mai28Value = tags[MAI_DOMESTIC_SCHEME_TAG];
  const ethqr: EthQrDecoded = {
    kind: "ethqr",
    tags,
    mai28: mai28Value != null ? parseMai28(mai28Value) : null,
    crcValid: isCrcValid(payload),
    payloadFormatIndicator: tags["00"] ?? null,
    pointOfInitiation: tags["01"] ?? null,
    merchantCategoryCode: tags["52"] ?? null,
    currency: tags["53"] ?? null,
    amount: tags["54"] ?? null,
    merchantName: tags["59"] ?? null,
    merchantCity: tags["60"] ?? null,
    referenceLabel: null,
    purposeOfTransaction: tags["80"] ?? null,
  };
  if (tags["62"]) {
    const addl = parseTlv(tags["62"]);
    if (addl.ok) {
      for (const t of addl.tags) {
        if (t.id === "05") ethqr.referenceLabel = t.value;
        if (t.id === "08") ethqr.purposeOfTransaction = t.value;
      }
    }
  }
  return { kind: "ethqr", decoded: ethqr };
}

/* ------------------------------ encoder ------------------------------ */

export interface MerchantPresentedInput {
  /** Creditor institution BIC (8 or 11 chars) — required to be routable. */
  bic: string;
  /** Merchant account number (≤24 chars). */
  accountNumber: string;
  /** "Doing business as" merchant name (≤25). */
  merchantName: string;
  /** Merchant city (≤15). */
  merchantCity: string;
  /** ISO 18245 category code, 4 digits. Default `5999` (retail). */
  merchantCategoryCode?: string;
  /** ISO 4217 numeric. Default `230` (ETB). */
  currency?: string;
  /** Amount in major units ("1234.56"). Presence makes the QR dynamic. */
  amount?: string | null;
  /** Tag 62/05 reference label — the payo short reference (PY-dddddd-DDD). */
  referenceLabel?: string | null;
  /** Tag 62/08 purpose of transaction. Default `P2M` (EthSwitch value list unpublished). */
  purposeOfTransaction?: string | null;
  /** IPS ET scheme GUID (32 hex, no hyphens). */
  schemeGuid: string;
}

const ISO4217_NUMERIC = new Set([
  "230", // ETB — the only currency this product settles in, kept explicit
]);

export function buildMerchantPresented(input: MerchantPresentedInput): string {
  const bic = input.bic.trim();
  if (bic.length !== 8 && bic.length !== 11) {
    throw new Error(`BIC must be 8 or 11 characters, got ${bic.length}`);
  }
  const account = input.accountNumber.trim();
  if (!account || account.length > 24) {
    throw new Error(`merchant account must be 1–24 characters, got ${account.length}`);
  }
  const name = input.merchantName.trim();
  if (!name || name.length > 25) throw new Error("merchant name must be 1–25 characters");
  const city = input.merchantCity.trim();
  if (!city || city.length > 15) throw new Error("merchant city must be 1–15 characters");
  const mcc = (input.merchantCategoryCode ?? "5999").trim();
  if (!/^\d{4}$/.test(mcc)) throw new Error(`MCC must be 4 digits, got "${mcc}"`);
  const currency = (input.currency ?? "230").trim();
  if (!/^\d{3}$/.test(currency) || !ISO4217_NUMERIC.has(currency)) {
    throw new Error(`unsupported currency code "${currency}"`);
  }
  const amount = input.amount?.trim() ?? "";
  if (amount && !/^\d{1,10}(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`amount must be digits with up to 2 decimals, got "${amount}"`);
  }

  const mai28 =
    encodeTlv("00", input.schemeGuid) +
    encodeTlv("01", bic) +
    encodeTlv("02", account);

  const addlParts: string[] = [];
  if (input.referenceLabel) addlParts.push(encodeTlv("05", input.referenceLabel.slice(0, 25)));
  const purpose = (input.purposeOfTransaction ?? "P2M").trim();
  if (purpose) addlParts.push(encodeTlv("08", purpose.slice(0, 25)));
  const addl = addlParts.length > 0 ? addlParts.join("") : "";

  const parts: string[] = [encodeTlv("00", "01")];
  if (amount) parts.push(encodeTlv("01", "12"));
  parts.push(encodeTlv(MAI_DOMESTIC_SCHEME_TAG, mai28));
  parts.push(encodeTlv("52", mcc));
  parts.push(encodeTlv("53", currency));
  if (amount) parts.push(encodeTlv("54", amount));
  parts.push(encodeTlv("58", "ET"));
  parts.push(encodeTlv("59", name));
  parts.push(encodeTlv("60", city));
  if (addl) parts.push(encodeTlv("62", addl));
  // CRC over everything so far, including the 6304 prefix.
  const withCrcPrefix = parts.join("") + "6304";
  return withCrcPrefix + crc16CcittFalse(withCrcPrefix);
}
