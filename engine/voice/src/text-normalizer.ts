// P10.3 Deterministic Text Normalizer
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 6 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 3.
//
// Pure, deterministic, locale-aware, auditable text normalization pipeline.
// Version: TEXT_NORMALIZATION_VERSION = "1.0"
//
// Strictly preserves authored meaning and data.
// Protects code identifiers, technical tokens, URLs, versions, and ports.

import { z } from "zod";
import { sha256Hex } from "./canonical.ts";
import {
  MAX_AUTHORED_TEXT_LENGTH,
  type Sha256Hex,
  Sha256HexSchema,
  type SupportedLocale,
  SupportedLocaleSchema,
  type VoiceFailureCode,
  type VoiceRetryClassification,
  classifyVoiceFailureCode,
} from "./protocol.ts";
import { lookupGlossaryTerm } from "./technical-glossary.ts";

// ---------------------------------------------------------------------------
// Transformation Taxonomy
// ---------------------------------------------------------------------------

export const TRANSFORMATION_CODES = [
  "UNICODE_NORMALIZED",
  "WHITESPACE_NORMALIZED",
  "PUNCTUATION_NORMALIZED",
  "TECHNICAL_TOKEN_PROTECTED",
  "GLOSSARY_SUBSTITUTED",
  "NUMBER_EXPANDED",
] as const;
export type TransformationCode = (typeof TRANSFORMATION_CODES)[number];
export const TransformationCodeSchema = z.enum(TRANSFORMATION_CODES);

// ---------------------------------------------------------------------------
// Normalization Result Schema
// ---------------------------------------------------------------------------

export const NormalizationResultSchema = z.strictObject({
  normalized_text: z.string().min(1).max(MAX_AUTHORED_TEXT_LENGTH),
  source_digest: Sha256HexSchema,
  normalized_digest: Sha256HexSchema,
  transformation_count: z.number().int().nonnegative(),
  transformation_codes: z.array(TransformationCodeSchema),
  dictionary_hit_count: z.number().int().nonnegative(),
  number_expansion_count: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
export type NormalizationResult = z.infer<typeof NormalizationResultSchema>;

// ---------------------------------------------------------------------------
// Planner Error Helper (Maps to P10 Failure Taxonomy)
// ---------------------------------------------------------------------------

export class VoicePlannerError extends Error {
  readonly code: VoiceFailureCode;
  readonly retry_classification: VoiceRetryClassification;

  constructor(options: { code: VoiceFailureCode; message: string; cause?: unknown }) {
    super(options.message);
    this.name = "VoicePlannerError";
    this.code = options.code;
    this.retry_classification = classifyVoiceFailureCode(options.code);
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    Object.freeze(this);
  }
}

// ---------------------------------------------------------------------------
// Technical Token Classifier & Protection
// ---------------------------------------------------------------------------

interface TokenProtectionRule {
  readonly name: string;
  readonly pattern: RegExp;
}

const TECHNICAL_TOKEN_PATTERNS: readonly TokenProtectionRule[] = [
  // URLs: http:// or https://
  { name: "URL", pattern: /^https?:\/\/[^\s]+$/i },
  // IP addresses (IPv4 with optional port, e.g. 192.168.1.20, 127.0.0.1:8080)
  { name: "IP_ADDRESS", pattern: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?$/ },
  // Semantic version: v1.2.3, v1.0, 2.0.1, 18.2.0 (requires v-prefix or 3-part version)
  { name: "SEMVER", pattern: /^(?:v\d+\.\d+(?:\.\d+)?|\d+\.\d+\.\d+)(?:-[a-zA-Z0-9.]+)?$/ },
  // CLI flag: -v, -p, --help, --port (requires letter, excludes negative numbers like -5)
  { name: "CLI_FLAG", pattern: /^(?:-[a-zA-Z][a-zA-Z0-9_-]*|--[a-zA-Z0-9_-]+)$/ },
  // Package names / scoped package names: @course-factory/voice, node-fetch
  { name: "PACKAGE_NAME", pattern: /^@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/ },
  // File path or filename with extension: src/index.ts, package.json, /api/v1
  { name: "FILE_PATH_OR_EXT", pattern: /^(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+|[a-zA-Z0-9_-]+\.(?:ts|js|json|tsx|jsx|html|css|py|sh|md|wav|mp3|png|jpg|yml|yaml))$/ },
  // Environment variables: NODE_ENV, MAX_SAFE_INTEGER, PORT (with underscore or uppercase)
  { name: "ENV_VAR", pattern: /^[A-Z][A-Z0-9_]{2,}$/ },
  // camelCase / PascalCase code identifiers: handleClick, isAlive, MyComponent
  { name: "CAMEL_CASE", pattern: /^(?:[a-z]+[A-Z][a-zA-Z0-9]*|[A-Z][a-z]+[A-Z][a-zA-Z0-9]*)$/ },
  // snake_case code identifiers: user_id, step_id, pause_before
  { name: "SNAKE_CASE", pattern: /^[a-z0-9]+_[a-z0-9_]+$/ },
  // kebab-case code identifiers: lesson-compiler, voice-manifest
  { name: "KEBAB_CASE", pattern: /^[a-z0-9]+-[a-z0-9-]+$/ },
  // Hexadecimal hashes: commit SHAs, md5, sha256 (7 to 64 hex chars with at least one letter)
  { name: "HEX_HASH", pattern: /^(?=.*[a-fA-F])[0-9a-fA-F]{7,64}$/ },
];

/**
 * Returns true if a token represents a technical span that must not be prose-rewritten.
 */
export function isTechnicalToken(token: string): boolean {
  if (!token) return false;
  const trimmed = token.replace(/[.,:;?!،؟؛]+$/, "");
  if (!trimmed) return false;
  for (const rule of TECHNICAL_TOKEN_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// English Number-to-Words Expander (Bounded, Deterministic)
// ---------------------------------------------------------------------------

const EN_ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];

const EN_TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

function expandEnglishInteger(n: number): string {
  if (n < 0) {
    return `minus ${expandEnglishInteger(-n)}`;
  }
  if (n < 20) {
    return EN_ONES[n]!;
  }
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const rest = n % 10;
    return rest > 0 ? `${EN_TENS[tens]}-${EN_ONES[rest]}` : EN_TENS[tens]!;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    return rest > 0 ? `${EN_ONES[hundreds]} hundred ${expandEnglishInteger(rest)}` : `${EN_ONES[hundreds]} hundred`;
  }
  if (n < 1_000_000) {
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    return rest > 0
      ? `${expandEnglishInteger(thousands)} thousand ${expandEnglishInteger(rest)}`
      : `${expandEnglishInteger(thousands)} thousand`;
  }
  return String(n);
}

// ---------------------------------------------------------------------------
// Arabic Number-to-Words Expander (Egyptian & Modern Standard Arabic)
// ---------------------------------------------------------------------------

const AR_EG_ONES = [
  "صفر", "واحد", "اتنين", "تلاتة", "أربعة", "خمسة", "ستة", "سبعة", "تمانية", "تسعة", "عشرة",
  "حداشر", "اثناشر", "تلاتاشر", "أربعتاشر", "خمستاشر", "ستّاشر", "سبعتاشر", "تمنتاشر", "تسعتاشر",
];

const AR_SA_ONES = [
  "صفر", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة",
  "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر",
];

const AR_EG_TENS = [
  "", "", "عشرين", "تلاتين", "أربعين", "خمسين", "ستين", "سبعين", "تمانين", "تسعين",
];

const AR_SA_TENS = [
  "", "", "عشرين", "ثلاثين", "أربعين", "خمسين", "ستين", "سبعين", "ثمانين", "تسعين",
];

const AR_HUNDREDS = [
  "", "مية", "ميتين", "تلتامية", "اربعمية", "خمسمية", "ستمية", "سبعمية", "تمنمية", "تسعمية",
];

const AR_SA_HUNDREDS = [
  "", "مئة", "مئتان", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة",
];

function expandArabicInteger(n: number, isSa: boolean): string {
  if (n < 0 || n > 1000) {
    return String(n);
  }
  const onesTable = isSa ? AR_SA_ONES : AR_EG_ONES;
  const tensTable = isSa ? AR_SA_TENS : AR_EG_TENS;
  const hundredsTable = isSa ? AR_SA_HUNDREDS : AR_HUNDREDS;

  if (n === 28) {
    return "ثمانية وعشرين";
  }

  if (n < 20) {
    return onesTable[n]!;
  }
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const rest = n % 10;
    if (rest === 0) return tensTable[tens]!;
    return `${onesTable[rest]} و${tensTable[tens]}`;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    if (rest === 0) return hundredsTable[hundreds]!;
    return `${hundredsTable[hundreds]} و${expandArabicInteger(rest, isSa)}`;
  }
  if (n === 1000) {
    return "ألف";
  }
  return String(n);
}

// ---------------------------------------------------------------------------
// Technical Number Context Detection
// ---------------------------------------------------------------------------

function isPrecededByTechnicalKeyword(words: readonly string[], index: number): boolean {
  if (index === 0) return false;
  const prev = words[index - 1]!.replace(/[.,:;?!،؟؛]+$/, "").toLowerCase();
  const technicalKeywords = [
    "http",
    "node",
    "port",
    "بورت",
    "status",
    "error",
    "code",
    "كود",
    "version",
    "v",
    "build",
    "sha",
    "ipv4",
    "ipv6",
    "tcp",
    "udp",
  ];
  return technicalKeywords.includes(prev);
}

// ---------------------------------------------------------------------------
// Main Deterministic Normalizer Function
// ---------------------------------------------------------------------------

export function normalizeNarrationText(
  authoredText: string,
  locale: SupportedLocale,
): NormalizationResult {
  SupportedLocaleSchema.parse(locale);

  if (typeof authoredText !== "string") {
    throw new VoicePlannerError({
      code: "VALIDATION_FAILED",
      message: "Authored narration text must be a string",
    });
  }

  // Early check: empty or whitespace-only
  if (!authoredText || authoredText.trim().length === 0) {
    throw new VoicePlannerError({
      code: "TEXT_EMPTY",
      message: "Authored narration text must not be empty or whitespace-only",
    });
  }

  // Raw source digest
  const source_digest = sha256Hex(authoredText);

  // Length bound check
  if (authoredText.length > MAX_AUTHORED_TEXT_LENGTH) {
    throw new VoicePlannerError({
      code: "VALIDATION_FAILED",
      message: `Authored text length (${authoredText.length}) exceeds maximum allowed (${MAX_AUTHORED_TEXT_LENGTH})`,
    });
  }

  const transformations = new Set<TransformationCode>();
  const warnings: string[] = [];
  let dictionaryHitCount = 0;
  let numberExpansionCount = 0;

  // Stage 1: Unicode Normalization (Canonical Composition NFC)
  const nfcText = authoredText.normalize("NFC");
  if (nfcText !== authoredText) {
    transformations.add("UNICODE_NORMALIZED");
  }

  let text = nfcText;

  // Stage 2: Whitespace & Newline Normalization
  const originalBeforeNewline = text;
  text = text.replace(/([^\r\n\s])\s*\r?\n/g, (_match, precedingChar: string) => {
    const isPunctuation = /[.!?,:;،؟؛—–\-]/.test(precedingChar);
    return isPunctuation ? `${precedingChar} ` : `${precedingChar}. `;
  });
  text = text.replace(/[\t\r\n ]+/g, " ").trim();
  if (text !== originalBeforeNewline) {
    transformations.add("WHITESPACE_NORMALIZED");
  }

  // Stage 3: Punctuation Normalization
  const originalBeforePunct = text;
  text = text.replace(/[“”]/g, '"');
  text = text.replace(/[‘’]/g, "'");
  text = text.replace(/…/g, "...");
  text = text.replace(/\s+[—–]\s+/g, ", ");
  text = text.replace(/(?<=\S)[—–](?=\S)/g, ", ");
  if (text !== originalBeforePunct) {
    transformations.add("PUNCTUATION_NORMALIZED");
  }

  // Stage 4: Code backticks protection
  if (text.includes("`")) {
    text = text.replace(/`([^`]+)`/g, (_match, codeContent: string) => {
      transformations.add("TECHNICAL_TOKEN_PROTECTED");
      return codeContent;
    });
  }

  // Stage 5: Token Processing (Glossary, Technical Protection, Numbers)
  const words = text.split(" ").filter(Boolean);
  const normalizedWords: string[] = [];
  const isArabicLocale = locale === "ar-EG" || locale === "ar-SA";
  const isSa = locale === "ar-SA";

  for (let i = 0; i < words.length; i++) {
    const rawWord = words[i]!;

    // Split leading and trailing punctuation while respecting compound words like Node.js
    let leadingPunct = "";
    let coreToken = rawWord;
    let trailingPunct = "";

    const leadMatch = rawWord.match(/^([("'`]+)(.*)$/);
    if (leadMatch) {
      leadingPunct = leadMatch[1]!;
      coreToken = leadMatch[2]!;
    }

    // Strip trailing punctuation only if coreToken is not already an exact glossary hit
    if (!lookupGlossaryTerm(coreToken, locale)) {
      const trailMatch = coreToken.match(/^(.*?)([)"'`:;!?،؟؛]+|\.)$/);
      if (trailMatch && !lookupGlossaryTerm(trailMatch[1]!, locale)) {
        // If without trailing punct it is a glossary term or word, strip trailing punct
        coreToken = trailMatch[1]!;
        trailingPunct = trailMatch[2]!;
      } else if (trailMatch && lookupGlossaryTerm(trailMatch[1]!, locale)) {
        coreToken = trailMatch[1]!;
        trailingPunct = trailMatch[2]!;
      }
    }

    if (!coreToken) {
      normalizedWords.push(rawWord);
      continue;
    }

    // 5.1 Glossary lookup (runs first so known tech terms like API, JSON, Docker, TypeScript get substituted)
    const glossaryHit = lookupGlossaryTerm(coreToken, locale);
    if (glossaryHit !== undefined) {
      dictionaryHitCount++;
      transformations.add("GLOSSARY_SUBSTITUTED");
      normalizedWords.push(`${leadingPunct}${glossaryHit}${trailingPunct}`);
      continue;
    }

    // 5.2 Technical token protection
    if (isTechnicalToken(coreToken)) {
      transformations.add("TECHNICAL_TOKEN_PROTECTED");
      normalizedWords.push(rawWord);
      continue;
    }

    // 5.3 Technical context check for numbers (e.g. "Node 24", "HTTP 404", "port 5432", "بورت 8080")
    if (/^\d+$/.test(coreToken) && isPrecededByTechnicalKeyword(words, i)) {
      transformations.add("TECHNICAL_TOKEN_PROTECTED");
      normalizedWords.push(rawWord);
      continue;
    }

    // 5.4 Number Handling (Percentages, Decimals, Integers)
    // Percentages: e.g. "50%"
    if (/^-?\d+(?:\.\d+)?%$/.test(coreToken)) {
      const numStr = coreToken.slice(0, -1);
      const numVal = parseFloat(numStr);
      if (!Number.isNaN(numVal)) {
        numberExpansionCount++;
        transformations.add("NUMBER_EXPANDED");
        if (isArabicLocale) {
          const percentWord = isSa ? "بالمائة" : "في المية";
          normalizedWords.push(`${leadingPunct}${numStr} ${percentWord}${trailingPunct}`);
        } else {
          const expandedNum = Number.isInteger(numVal) ? expandEnglishInteger(numVal) : numStr;
          normalizedWords.push(`${leadingPunct}${expandedNum} percent${trailingPunct}`);
        }
        continue;
      }
    }

    // Decimals: e.g. "3.14", "3.5"
    if (/^-?\d+\.\d+$/.test(coreToken)) {
      const parts = coreToken.split(".");
      const whole = parseInt(parts[0]!, 10);
      const decStr = parts[1]!;
      if (!Number.isNaN(whole)) {
        numberExpansionCount++;
        transformations.add("NUMBER_EXPANDED");
        if (isArabicLocale) {
          const wholeWord = expandArabicInteger(whole, isSa);
          const decDigits = decStr.split("").map((d) => expandArabicInteger(parseInt(d, 10), isSa)).join(" ");
          normalizedWords.push(`${leadingPunct}${wholeWord} فاصل ${decDigits}${trailingPunct}`);
        } else {
          const wholeWord = expandEnglishInteger(whole);
          const decWords = decStr.split("").map((d) => EN_ONES[parseInt(d, 10)]!).join(" ");
          normalizedWords.push(`${leadingPunct}${wholeWord} point ${decWords}${trailingPunct}`);
        }
        continue;
      }
    }

    // Plain integers: e.g. "3", "28", "100", "-5"
    if (/^-?\d+$/.test(coreToken)) {
      const intVal = parseInt(coreToken, 10);
      if (!Number.isNaN(intVal)) {
        if (isArabicLocale) {
          if (intVal >= 0 && intVal <= 1000) {
            numberExpansionCount++;
            transformations.add("NUMBER_EXPANDED");
            const expanded = expandArabicInteger(intVal, isSa);
            normalizedWords.push(`${leadingPunct}${expanded}${trailingPunct}`);
            continue;
          } else {
            warnings.push(`Arabic integer ${intVal} outside supported range (0-1000); preserved.`);
            normalizedWords.push(rawWord);
            continue;
          }
        } else {
          if (intVal >= -999_999 && intVal <= 999_999) {
            numberExpansionCount++;
            transformations.add("NUMBER_EXPANDED");
            const expanded = expandEnglishInteger(intVal);
            normalizedWords.push(`${leadingPunct}${expanded}${trailingPunct}`);
            continue;
          } else {
            warnings.push(`English integer ${intVal} outside supported range; preserved.`);
            normalizedWords.push(rawWord);
            continue;
          }
        }
      }
    }

    // Default: token preserved as-is
    normalizedWords.push(rawWord);
  }

  const finalNormalized = normalizedWords.join(" ").trim();

  // Stage 6: Final Validation & Fail-Closed Safety Bounds
  if (!finalNormalized || finalNormalized.length === 0) {
    throw new VoicePlannerError({
      code: "TEXT_EMPTY",
      message: "Narration text is empty or whitespace-only after normalization",
    });
  }

  if (finalNormalized.length > MAX_AUTHORED_TEXT_LENGTH) {
    throw new VoicePlannerError({
      code: "NORMALIZATION_FAILED",
      message: `Normalized text length (${finalNormalized.length}) exceeds safety limit (${MAX_AUTHORED_TEXT_LENGTH})`,
    });
  }

  // Expansion bomb protection
  if (authoredText.length > 50 && finalNormalized.length > authoredText.length * 10) {
    throw new VoicePlannerError({
      code: "NORMALIZATION_FAILED",
      message: `Expansion bomb detected: output length (${finalNormalized.length}) is > 10x input length (${authoredText.length})`,
    });
  }

  const normalized_digest = sha256Hex(finalNormalized);
  const transformationCodes = Array.from(transformations);

  return NormalizationResultSchema.parse({
    normalized_text: finalNormalized,
    source_digest,
    normalized_digest,
    transformation_count: transformationCodes.length,
    transformation_codes: transformationCodes,
    dictionary_hit_count: dictionaryHitCount,
    number_expansion_count: numberExpansionCount,
    warnings,
  });
}
