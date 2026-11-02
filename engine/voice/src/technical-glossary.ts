// P10.3 Technical Pronunciation Glossary
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 6.1 (6, 8) and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 3.
//
// Deterministic, reviewable pronunciation table for technical acronyms and terms.
// Tied to TEXT_NORMALIZATION_VERSION = "1.0".
//
// Strictly separates:
// - Known canonical technical substitutions per locale
// - Ambiguous / unlisted technical terms: preserved verbatim without guessing.

import type { SupportedLocale } from "./protocol.ts";

/** Technical glossary version matching Text Normalization Version. */
export const TECHNICAL_GLOSSARY_VERSION = "1.0" as const;

/**
 * English acronyms and technical terms expanded for letter-by-letter or natural pronunciation.
 * Keys are exact case-sensitive matches.
 */
export const GLOSSARY_EN: Readonly<Record<string, string>> = Object.freeze({
  CLI: "C-L-I",
  API: "A-P-I",
  IDE: "I-D-E",
  DOM: "D-O-M",
  WSL: "W-S-L",
  JSON: "J-SON",
  SQL: "S-Q-L",
  SDK: "S-D-K",
  URL: "U-R-L",
  HTTP: "H-T-T-P",
  HTTPS: "H-T-T-P-S",
  HTML: "H-T-M-L",
  CSS: "C-S-S",
  UI: "U-I",
  UX: "U-X",
  OS: "O-S",
  IP: "I-P",
  RAM: "RAM",
  CPU: "C-P-U",
  IO: "I-O",
  PR: "P-R",
  CI: "C-I",
  CD: "C-D",
  ASCII: "ASCII",
});

/**
 * Arabic (Egyptian Technical) phonetic glossary for English technical nouns embedded in Arabic prose.
 * Prevents phonetic distortion by Arabic acoustic models while preserving pedagogical clarity.
 */
export const GLOSSARY_AR_EG: Readonly<Record<string, string>> = Object.freeze({
  API: "إيه بي آي",
  CLI: "سي إل آي",
  IDE: "آي دي إي",
  DOM: "دوم",
  JSON: "جيسون",
  SQL: "إس كيو إل",
  SDK: "إس دي كي",
  URL: "يو آر إل",
  HTTP: "إتش تي تي بي",
  HTTPS: "إتش تي تي بي إس",
  HTML: "إتش تي إم إل",
  CSS: "سي إس إس",
  WSL: "دبليو إس إل",
  Docker: "دوكر",
  docker: "دوكر",
  React: "رياكت",
  react: "رياكت",
  Electron: "إلكترون",
  electron: "إلكترون",
  TypeScript: "تايب سكريبت",
  typescript: "تايب سكريبت",
  JavaScript: "جافا سكريبت",
  javascript: "جافا سكريبت",
  "Node.js": "نود جي إس",
  Node: "نود",
  node: "نود",
  Python: "بايثون",
  python: "بايثون",
  Terminal: "تيرمينال",
  terminal: "تيرمينال",
  Container: "كونتينر",
  container: "كونتينر",
  Process: "بروسيس",
  process: "بروسيس",
  Git: "جيت",
  git: "جيت",
  GitHub: "جيت هاب",
  github: "جيت هاب",
  Linux: "لينكس",
  linux: "لينكس",
  Ubuntu: "أوبونتو",
  ubuntu: "أوبونتو",
  "VS Code": "في إس كود",
});

/**
 * Arabic (Modern Standard) phonetic glossary.
 */
export const GLOSSARY_AR_SA: Readonly<Record<string, string>> = Object.freeze({
  ...GLOSSARY_AR_EG,
});

/**
 * Looks up a technical token in the glossary for the specified locale.
 * Returns the deterministic phonetic replacement if an explicit entry exists;
 * returns undefined if no entry exists (caller must preserve the token).
 */
export function lookupGlossaryTerm(token: string, locale: SupportedLocale): string | undefined {
  if (!token) return undefined;

  switch (locale) {
    case "ar-EG":
      return GLOSSARY_AR_EG[token];
    case "ar-SA":
      return GLOSSARY_AR_SA[token];
    case "en-US":
    case "en-GB":
      return GLOSSARY_EN[token];
    default:
      return undefined;
  }
}

/**
 * Returns true if the token is a recognized technical term in the locale glossary.
 */
export function isKnownTechnicalTerm(token: string, locale: SupportedLocale): boolean {
  return lookupGlossaryTerm(token, locale) !== undefined;
}
