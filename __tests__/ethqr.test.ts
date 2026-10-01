import { describe, expect, it } from "vitest";
import {
  buildMerchantPresented,
  crc16CcittFalse,
  decodeQrPayload,
  isCrcValid,
  parseMai28,
  parseTlv,
} from "../lib/verifier/ethqr.js";

const GUID = "581b314e257f41bfbbdc6384daa31d16";

const base = {
  bic: "CBETETAA",
  accountNumber: "1000234567890",
  merchantName: "Tewodros Spices",
  merchantCity: "ADDIS ABABA",
  schemeGuid: GUID,
};

describe("crc16CcittFalse", () => {
  it("matches the canonical check value", () => {
    // ITU-T check value for CRC-16/CCITT-FALSE over "123456789".
    expect(crc16CcittFalse("123456789")).toBe("29B1");
  });

  it("pads to 4 uppercase hex digits", () => {
    expect(crc16CcittFalse("")).toBe("FFFF");
  });
});

describe("parseTlv", () => {
  it("round-trips tags", () => {
    const payload = "000201" + "52045999" + "5802ET";
    expect(parseTlv(payload)).toEqual({
      ok: true,
      tags: [
        { id: "00", value: "01" },
        { id: "52", value: "5999" },
        { id: "58", value: "ET" },
      ],
    });
  });

  it("rejects truncated input", () => {
    expect(parseTlv("0002015").ok).toBe(false);
    expect(parseTlv("6305ABC").ok).toBe(false);
    expect(parseTlv("")).toEqual({ ok: false, error: "empty payload" });
  });
});

describe("isCrcValid", () => {
  it("accepts a payload with a correct CRC", () => {
    const body = "000201" + "5802ET" + "6304";
    const payload = body + crc16CcittFalse(body);
    expect(isCrcValid(payload)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const body = "000201" + "5802ET" + "6304";
    const payload = body + crc16CcittFalse(body);
    const tampered = payload.replace("5802ET", "5802US");
    expect(isCrcValid(tampered)).toBe(false);
  });
});

describe("buildMerchantPresented", () => {
  it("emits a static QR (no POI, no amount) that parses back cleanly", () => {
    const payload = buildMerchantPresented(base);
    expect(payload.length).toBeLessThanOrEqual(512);
    const decoded = decodeQrPayload(payload);
    expect(decoded.kind).toBe("ethqr");
    if (decoded.kind !== "ethqr") return;
    expect(decoded.decoded.crcValid).toBe(true);
    expect(decoded.decoded.pointOfInitiation).toBeNull();
    expect(decoded.decoded.amount).toBeNull();
    expect(decoded.decoded.currency).toBe("230");
    expect(decoded.decoded.merchantName).toBe("Tewodros Spices");
    expect(decoded.decoded.merchantCity).toBe("ADDIS ABABA");
    expect(decoded.decoded.mai28).toEqual({
      guid: GUID,
      bic: "CBETETAA",
      accountNumber: "1000234567890",
    });
  });

  it("emits a dynamic QR (POI 12 + amount) and carries the reference label", () => {
    const payload = buildMerchantPresented({
      ...base,
      amount: "450.00",
      referenceLabel: "PY-933623-FDU",
    });
    const decoded = decodeQrPayload(payload);
    expect(decoded.kind).toBe("ethqr");
    if (decoded.kind !== "ethqr") return;
    expect(decoded.decoded.pointOfInitiation).toBe("12");
    expect(decoded.decoded.amount).toBe("450.00");
    expect(decoded.decoded.referenceLabel).toBe("PY-933623-FDU");
    expect(decoded.decoded.purposeOfTransaction).toBe("P2M");
  });

  it("is deterministic for identical input", () => {
    expect(buildMerchantPresented(base)).toBe(buildMerchantPresented(base));
  });

  it("rejects invalid BIC, over-long name, bad amount, and unknown currency", () => {
    expect(() => buildMerchantPresented({ ...base, bic: "SHORT" })).toThrow(/BIC/);
    expect(() =>
      buildMerchantPresented({ ...base, merchantName: "X".repeat(26) }),
    ).toThrow(/name/);
    expect(() => buildMerchantPresented({ ...base, amount: "1,000" })).toThrow(/amount/);
    expect(() => buildMerchantPresented({ ...base, currency: "840" })).toThrow(/currency/);
  });
});

describe("decodeQrPayload", () => {
  it("classifies legacy closed-loop till numbers", () => {
    // Annexure B: old Telebirr QRs are bare digit strings.
    const out = decodeQrPayload("1398597851655077890");
    expect(out).toEqual({ kind: "legacy_till", value: "1398597851655077890" });
  });

  it("classifies bank receipt URLs and arbitrary text as unknown", () => {
    expect(decodeQrPayload("https://mbreciept.cbe.com.et/?id=FT1234ABC").kind).toBe("unknown");
    expect(decodeQrPayload("hello world").kind).toBe("unknown");
    expect(decodeQrPayload("   ").kind).toBe("unknown");
  });

  it("flags a TLV payload with a broken CRC as ethqr but crcValid=false", () => {
    const payload = buildMerchantPresented(base);
    const tampered = payload.slice(0, -4) + "0000";
    const decoded = decodeQrPayload(tampered);
    expect(decoded.kind).toBe("ethqr");
    if (decoded.kind !== "ethqr") return;
    expect(decoded.decoded.crcValid).toBe(false);
  });

  it("parses the Annexure A sample's tag 28 sub-structure", () => {
    // The official sample's MAI-28 length digit (76) disagrees with its
    // content (68 bytes) — a known defect of the adapted Raast template —
    // so we assert the sub-tag contents through a corrected-length payload.
    const mai28 = "0032" + GUID + "0108CBETETAA" + "02160000171234567890";
    const mai = parseMai28(mai28);
    expect(mai).toEqual({
      guid: GUID,
      bic: "CBETETAA",
      accountNumber: "0000171234567890",
    });
  });
});
