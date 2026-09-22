import { describe, expect, it } from "vitest";
import {
  conservativeTextRuns,
  isOrdinaryText,
  isReliableWord,
  type OCRWord,
} from "./ocr-policy";

function word(text: string, x: number, confidence = 96): OCRWord {
  return {
    text,
    confidence,
    bbox: { x0: x, y0: 20, x1: x + 50, y1: 40 },
    symbols: [...text].map((text) => ({ text, confidence: 99 })),
  };
}

describe("conservative OCR policy", () => {
  it("keeps a clear phrase editable while masking only the individual words", () => {
    const runs = conservativeTextRuns([
      { words: [word("HELLO", 10), word("WORLD!", 70)] },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("HELLO WORLD!");
    expect(runs[0].wordRegions).toEqual([
      { x: 10, y: 20, width: 50, height: 20 },
      { x: 70, y: 20, width: 50, height: 20 },
    ]);
  });

  it("retains uncertain words as raster pixels and never bridges their gap", () => {
    const runs = conservativeTextRuns([
      {
        words: [
          word("Download", 10),
          word("uncertain", 70, 60),
          word("source", 130),
        ],
      },
    ]);
    expect(runs.map((run) => run.text)).toEqual(["Download", "source"]);
    expect(
      runs.flatMap((run) => run.wordRegions).some((region) => region.x === 70),
    ).toBe(false);
  });

  it("accepts genuine single words and attached punctuation", () => {
    expect(isReliableWord(word("Website", 10))).toBe(true);
    expect(isReliableWord(word("Hello,", 10))).toBe(true);
    expect(isReliableWord(word("中文", 10))).toBe(true);
    expect(isReliableWord(word("download.zip", 10))).toBe(true);
  });

  it("rejects pictographs, icon-only tokens, and doubtful single glyphs", () => {
    for (const text of ["📁", "↗", "□", "✓", "•", "📁Download"]) {
      expect(isOrdinaryText(text)).toBe(false);
    }
    expect(isReliableWord(word("G", 10, 92))).toBe(false);
    expect(isReliableWord(word("I", 10, 99))).toBe(true);
  });

  it("uses symbol confidence so a strong word average cannot hide an uncertain glyph", () => {
    const uncertain = word("Download", 10, 98);
    uncertain.symbols![0].confidence = 42;
    expect(isReliableWord(uncertain)).toBe(false);
    expect(conservativeTextRuns([{ words: [uncertain] }])).toEqual([]);
  });

  it("leaves protected words out of both text objects and masks", () => {
    const runs = conservativeTextRuns(
      [{ words: [word("Body", 10), word("Button", 80)] }],
      (region) => region.x < 50,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("Body");
    expect(runs[0].wordRegions).toHaveLength(1);
  });
});
