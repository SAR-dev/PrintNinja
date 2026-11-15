import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/locales/en";
import ja from "@/lib/i18n/locales/ja";

// MISSING_FEATURES item 46: the README and the Settings hint used to
// claim CPCL and raster need a paired PC, when only PDF does (CPCL has
// an on-device encoder, raster renders on the phone). These tests keep
// the README and both Settings translations naming the same languages,
// and pin the corrected "only PDF" claim so it cannot quietly revert.

/** Every printer language the app knows. */
const LANGUAGES = ["ESC/POS", "ZPL", "TSPL", "CPCL", "raster", "PDF"] as const;
/** The languages that must never be tied to needing a PC. Raster also
 * appears under its Japanese name in ja.ts. */
const THERMAL = ["ESC/POS", "ZPL", "TSPL", "CPCL", "raster", "ラスター"];

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(resolve(here, "..", "..", "README.md"), "utf8");
const enHint = en.printers.lang_android_hint;
const jaHint = ja.printers.lang_android_hint;

/** The printer languages named anywhere in a text. */
function languagesNamed(text: string): Set<string> {
  const lower = text.toLowerCase();
  return new Set(
    LANGUAGES.filter((lang) =>
      lang === "raster"
        ? lower.includes("raster") || text.includes("ラスター")
        : lower.includes(lang.toLowerCase()),
    ),
  );
}

/** Sentences that pair a PC with needing one (English "need" or the
 * Japanese 必要), the shape the old wrong claim had. */
function pcNeedSentences(text: string): string[] {
  return text
    .split(/[.!?\n。！？]/)
    .filter(
      (sentence) =>
        /\bPC\b/.test(sentence) &&
        (/need/i.test(sentence) || sentence.includes("必要な")),
    );
}

describe("Android print text", () => {
  it("README and the Settings hint name the same printer languages", () => {
    const fromReadme = languagesNamed(readme);
    // The README itself must cover the full set, or the comparison
    // below would pass while saying nothing.
    expect(fromReadme).toEqual(new Set(LANGUAGES));
    expect(languagesNamed(enHint)).toEqual(fromReadme);
    expect(languagesNamed(jaHint)).toEqual(fromReadme);
  });

  it("never ties a thermal language to needing a PC without the PDF rule", () => {
    const texts: Record<string, string> = {
      README: readme,
      "Settings (en)": enHint,
      "Settings (ja)": jaHint,
    };
    for (const [name, text] of Object.entries(texts)) {
      for (const sentence of pcNeedSentences(text)) {
        const namesThermal = THERMAL.some((lang) => sentence.includes(lang));
        if (!namesThermal) {
          continue;
        }
        // A sentence may name thermal languages next to "needs a PC"
        // only when it is stating the exception: only PDF does.
        const statesPdfRule =
          /only\s+PDF\s+needs/i.test(sentence) || sentence.includes("PDFだけ");
        expect(statesPdfRule, `${name}: ${sentence.trim()}`).toBe(true);
      }
    }
  });

  it("states in both languages that only PDF needs a paired PC", () => {
    expect(readme).toMatch(/only PDF needs a (?:paired )?PC/i);
    expect(enHint).toMatch(/only PDF needs a (?:paired )?PC/i);
    expect(jaHint).toContain("PDFだけ");
  });
});
