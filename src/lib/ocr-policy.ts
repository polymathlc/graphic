import type { Region } from "./segmentation";

interface OCRBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OCRWord {
  text: string;
  confidence: number;
  bbox: OCRBox;
  symbols?: Array<{ text: string; confidence: number }>;
}

export interface OCRLine {
  words: OCRWord[];
  /** Tesseract's fitted baseline, from the line's left end to its right end. */
  baseline?: OCRBox | null;
}

export interface OCRTextRun extends Region {
  text: string;
  textTop: number;
  fontSize: number;
  /** Only these individual word rectangles may be erased from the original. */
  wordRegions: Region[];
  /** Index of the printed line; runs from one line share a font size. */
  line: number;
  /** Baseline y at this run, used to place text without vertical drift. */
  baseline: number;
}

/** Arial proportions (em units) used to turn measured ink height into a font size. */
const CAP_HEIGHT = 0.716;
const X_HEIGHT = 0.519;
const DESCENT = 0.21;
const TALL_GLYPHS = /[\p{Lu}\p{N}bdfhklt'"“”‘’()[\]{}\/|!?#%&@$]/u;
const DESCENDING_GLYPHS = /[gjpqyQ,;()[\]{}|\/_]/u;

function median(values: readonly number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Baseline for a line: Tesseract's fitted baseline when it agrees with the
 * accepted words, else the bottom of words that have no descenders.
 */
export function lineBaseline(
  line: OCRLine,
  accepted: ReadonlyArray<{ text: string; region: Region }>,
): (x: number) => number {
  const top = Math.min(...accepted.map((item) => item.region.y));
  const bottom = Math.max(
    ...accepted.map((item) => item.region.y + item.region.height),
  );
  const flat = accepted
    .filter((item) => !DESCENDING_GLYPHS.test(item.text))
    .map((item) => item.region.y + item.region.height);
  const tallest = Math.max(...accepted.map((item) => item.region.height));
  const fallback = flat.length
    ? median(flat)
    : bottom - (tallest * DESCENT) / (CAP_HEIGHT + DESCENT);
  const fitted = line.baseline;
  if (
    fitted &&
    [fitted.x0, fitted.y0, fitted.x1, fitted.y1].every(Number.isFinite) &&
    fitted.x1 > fitted.x0
  ) {
    const slope = (fitted.y1 - fitted.y0) / (fitted.x1 - fitted.x0);
    const at = (x: number) => fitted.y0 + slope * (x - fitted.x0);
    const middle =
      accepted.reduce(
        (sum, item) => sum + item.region.x + item.region.width / 2,
        0,
      ) / accepted.length;
    // Reject baselines outside the ink or far from the descender-free bottoms.
    const value = at(middle);
    if (
      Math.abs(slope) < 0.2 &&
      value > top &&
      value <= bottom + 1 &&
      Math.abs(value - fallback) <= Math.max(2, (bottom - top) * 0.15)
    )
      return at;
  }
  return () => fallback;
}

/** Font size implied by the distance from the tallest glyph tops to the baseline. */
export function sizeFromInk(
  texts: readonly string[],
  textTop: number,
  baseline: number,
): number {
  const rise = baseline - textTop;
  if (!Number.isFinite(rise) || rise <= 0) return Number.NaN;
  const hasTall = texts.some((text) => TALL_GLYPHS.test(text));
  return rise / (hasTall ? CAP_HEIGHT : X_HEIGHT);
}

/** Ordinary punctuation can stay attached to words; pictographs and icon glyphs cannot. */
export function isOrdinaryText(text: string): boolean {
  return (
    /[\p{L}\p{N}]/u.test(text) &&
    /^[\p{L}\p{M}\p{N}\s'’‘"“”.,:;!?()[\]{}<>\/_\\@#%&+\-–—=…$€£¥、。·]+$/u.test(
      text,
    )
  );
}

export function isReliableWord(word: OCRWord): boolean {
  const text = word.text.trim();
  if (
    !isOrdinaryText(text) ||
    !Number.isFinite(word.confidence) ||
    word.confidence < 90
  )
    return false;
  const symbols = (word.symbols ?? []).filter((symbol) => symbol.text.trim());
  const lexicalLength = [...text.replace(/[^\p{L}\p{N}]/gu, "")].length;
  // A single confidently guessed glyph is often an adjacent file/arrow icon.
  // Preserve legitimate standalone A/I and digits only at near-certain confidence.
  if (lexicalLength === 1 && word.confidence < 98) return false;
  if (!symbols.length) return word.confidence >= 96;
  if (
    symbols.some(
      (symbol) => !Number.isFinite(symbol.confidence) || symbol.confidence < 80,
    )
  )
    return false;
  const mean =
    symbols.reduce((total, symbol) => total + symbol.confidence, 0) /
    symbols.length;
  return mean >= (lexicalLength === 1 ? 98 : 92);
}

function wordRegion(word: OCRWord): Region | null {
  const { x0, y0, x1, y1 } = word.bbox;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0)
    return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function canJoin(run: OCRTextRun, word: Region): boolean {
  const last = run.wordRegions.at(-1)!;
  const gap = word.x - (last.x + last.width);
  const height = Math.max(last.height, word.height);
  return (
    gap >= -1 &&
    gap <= Math.max(12, height * 0.9) &&
    Math.abs(last.y + last.height / 2 - word.y - word.height / 2) <=
      height * 0.4 &&
    Math.min(last.height, word.height) / height >= 0.45
  );
}

/** Reject doubtful words before grouping, so their pixels and nearby icons survive. */
export function conservativeTextRuns(
  lines: readonly OCRLine[],
  acceptRegion: (region: Region) => boolean = () => true,
): OCRTextRun[] {
  const result: OCRTextRun[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const words = line.words.map((word) => {
      const region = wordRegion(word);
      return {
        word,
        region,
        accepted:
          region !== null && isReliableWord(word) && acceptRegion(region),
      };
    });
    const accepted = words
      .filter((item) => item.accepted)
      .map((item) => item.region!);
    if (!accepted.length) continue;
    const heights = accepted
      .map((region) => region.height)
      .sort((a, b) => a - b);
    const textTop = Math.min(...accepted.map((region) => region.y));
    const acceptedWords = words
      .filter((item) => item.accepted)
      .map((item) => ({ text: item.word.text.trim(), region: item.region! }));
    const baselineAt = lineBaseline(line, acceptedWords);
    const lineMiddle =
      (Math.min(...accepted.map((region) => region.x)) +
        Math.max(...accepted.map((region) => region.x + region.width))) /
      2;
    const inkSize = sizeFromInk(
      acceptedWords.map((item) => item.text),
      textTop,
      baselineAt(lineMiddle),
    );
    const fontSize = Math.max(
      6,
      Number.isFinite(inkSize)
        ? inkSize
        : heights[Math.floor((heights.length - 1) * 0.85)] * 1.16,
    );
    let run: OCRTextRun | undefined;
    for (const item of words) {
      const { word, region } = item;
      if (!region || !item.accepted) {
        run = undefined;
        continue;
      }
      const text = word.text.trim();
      if (run && canJoin(run, region)) {
        const x = Math.min(run.x, region.x),
          y = Math.min(run.y, region.y);
        const right = Math.max(run.x + run.width, region.x + region.width);
        const bottom = Math.max(run.y + run.height, region.y + region.height);
        run.text += ` ${text}`;
        run.x = x;
        run.y = y;
        run.width = right - x;
        run.height = bottom - y;
        run.wordRegions.push(region);
        run.baseline = baselineAt(run.x + run.width / 2);
      } else {
        run = {
          ...region,
          text,
          textTop,
          fontSize,
          wordRegions: [region],
          line: lineIndex,
          baseline: baselineAt(region.x + region.width / 2),
        };
        result.push(run);
      }
    }
  }
  return result;
}
