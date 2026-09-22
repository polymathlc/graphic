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
}

export interface OCRTextRun extends Region {
  text: string;
  textTop: number;
  fontSize: number;
  /** Only these individual word rectangles may be erased from the original. */
  wordRegions: Region[];
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
  for (const line of lines) {
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
    const fontSize = Math.max(
      6,
      heights[Math.floor((heights.length - 1) * 0.85)] * 1.16,
    );
    const textTop = Math.min(...accepted.map((region) => region.y));
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
      } else {
        run = { ...region, text, textTop, fontSize, wordRegions: [region] };
        result.push(run);
      }
    }
  }
  return result;
}
