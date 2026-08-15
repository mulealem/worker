/**
 * Client-safe mapping from the database's `BankType` enum to the verifier's
 * lowercase `Provider` key.
 *
 * Lives in its own file (no Node.js dependencies) so it can be imported by
 * client components — the rest of `lib/verifier/verify.ts` transitively pulls
 * in `sharp`, `tesseract.js`, `node:fs`, etc., which can't be bundled into the
 * browser.
 */

export type BankType = "CBE" | "TELEBIRR" | "ABYSSINIA" | "DASHEN" | "AWASH" | "ZEMEN" | "CBE_BIRR" | "MPESA" | "OTHER";
import type { Provider } from "./types.js";

export function providerForBankType(bankType: BankType | string): Provider | null {
  switch (bankType) {
    case "CBE":
      return "cbe";
    case "TELEBIRR":
      return "telebirr";
    case "ABYSSINIA":
      return "boa";
    case "DASHEN":
      return "dashen";
    case "AWASH":
      return "awash";
    case "ZEMEN":
      return "zemen";
    case "CBE_BIRR":
      return "cbe-birr";
    case "MPESA":
      return "mpesa";
    case "OTHER":
      return null;
    default:
      return null;
  }
}
