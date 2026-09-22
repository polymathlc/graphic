import { describe, expect, it } from "vitest";
import {
  BASELINE_OFFSET,
  MAX_CHAR_SPACING,
  MIN_CHAR_SPACING,
  fitAtSize,
  fitPageText,
  graphemeCount,
  harmonizeSizes,
  inferWeight,
  laidOutWidth,
  preferredSize,
  reconcileSize,
  spacingToFit,
  weightedMedian,
  type LineRun,
  type TextMeasure,
} from "./text-fit";

/** A monospaced stand-in: every grapheme is 0.5em regular and 0.6em bold. */
const measure: TextMeasure = (text, weight) =>
  graphemeCount(text) * (weight === "bold" ? 0.6 : 0.5);

function run(
  text: string,
  targetWidth: number,
  heightSize: number,
  line: number,
  extra: Partial<LineRun> = {},
): LineRun {
  return { text, targetWidth, heightSize, line, ...extra };
}

describe("proportional text fitting", () => {
  it("places the first baseline where Fabric renders it", () => {
    expect(BASELINE_OFFSET).toBeCloseTo(1.13 * 0.778, 5);
  });

  it("uses the width-derived size when it agrees with the glyph height", () => {
    // 10 glyphs at 0.5em spanning 104px means a 20.8px font.
    expect(preferredSize(measure, run("abcdefghij", 104, 20, 0))).toBeCloseTo(
      20.8,
    );
  });

  it("never lets width alone produce a wildly different size", () => {
    expect(reconcileSize(20, 60)).toBeCloseTo(20 * 1.28);
    expect(reconcileSize(20, 2)).toBeCloseTo(20 * 0.78);
    expect(reconcileSize(20, Number.NaN)).toBe(20);
    expect(reconcileSize(Number.NaN, 14)).toBe(14);
  });

  it("keeps an authoritative PDF size untouched", () => {
    expect(
      preferredSize(
        measure,
        run("abcdefghij", 300, 12, 0, { exactSize: true }),
      ),
    ).toBe(12);
  });

  it("absorbs the remaining width with letter spacing instead of stretching", () => {
    const spacing = spacingToFit(100, 118, 20, 10);
    // 18px over 9 gaps = 2px per gap = 0.1em = 100 thousandths.
    expect(spacing).toBe(100);
    expect(laidOutWidth(5, 20, spacing, 10)).toBeCloseTo(118);
  });

  it("clamps letter spacing to a readable range", () => {
    expect(spacingToFit(100, 1000, 20, 10)).toBe(MAX_CHAR_SPACING);
    expect(spacingToFit(100, 1, 20, 10)).toBe(MIN_CHAR_SPACING);
    expect(spacingToFit(100, 140, 20, 1)).toBe(0);
  });

  it("recognizes bold type from its extra width", () => {
    // 10 bold glyphs at 20px = 120px; regular would only reach 100px.
    expect(inferWeight(measure, run("ABCDEFGHIJ", 120, 20, 0), 20)).toBe(
      "bold",
    );
    expect(inferWeight(measure, run("ABCDEFGHIJ", 102, 20, 0), 20)).toBe(
      "normal",
    );
    // Too short to judge reliably.
    expect(inferWeight(measure, run("AB", 30, 20, 0), 20)).toBe("normal");
    // A known weight always wins.
    expect(
      inferWeight(
        measure,
        run("ABCDEFGHIJ", 120, 20, 0, { fontWeight: "normal" }),
        20,
      ),
    ).toBe("normal");
  });

  it("does not mistake bold width for a larger size", () => {
    expect(preferredSize(measure, run("ABCDEFGHIJ", 120, 20, 0))).toBeCloseTo(
      20,
    );
  });

  it("returns a width that matches the target when spacing can reach it", () => {
    const fitted = fitAtSize(measure, run("abcdefghij", 108, 20, 0), 20);
    expect(fitted.fontWeight).toBe("normal");
    expect(fitted.width).toBeCloseTo(108, 0);
  });

  it("computes a weighted median that ignores short outliers", () => {
    expect(
      weightedMedian([
        { size: 40, weight: 1 },
        { size: 20, weight: 10 },
        { size: 21, weight: 8 },
      ]),
    ).toBe(20);
    expect(weightedMedian([])).toBeNaN();
  });

  it("snaps near-identical sizes to one shared size", () => {
    const sizes = harmonizeSizes([
      { size: 20, weight: 10 },
      { size: 21, weight: 10 },
      { size: 30, weight: 5 },
      { size: 20.5, weight: 10 },
    ]);
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[1]).toBe(sizes[3]);
    expect(sizes[2]).toBe(30);
    expect(sizes[0]).toBeCloseTo(20.5, 1);
  });

  it("gives every run on a printed line the same size", () => {
    const fitted = fitPageText(
      () => measure,
      [
        run("Do not", 66, 20, 0),
        run("turn", 38, 17, 0),
        run("over this page", 158, 21, 0),
        run("Heading", 140, 36, 1),
      ],
    );
    expect(new Set(fitted.slice(0, 3).map((item) => item.fontSize)).size).toBe(
      1,
    );
    expect(fitted[3].fontSize).toBeGreaterThan(fitted[0].fontSize * 1.3);
  });

  it("never returns a non-positive size, even from degenerate boxes", () => {
    const fitted = fitPageText(
      () => measure,
      [run("x", 0, 0, 0), run("", 10, 12, 1)],
    );
    for (const item of fitted) {
      expect(item.fontSize).toBeGreaterThan(0);
      expect(Number.isFinite(item.charSpacing)).toBe(true);
    }
  });

  it("counts user-perceived characters rather than code units", () => {
    expect(graphemeCount("café")).toBe(4);
    expect(graphemeCount("é")).toBe(1);
  });
});
