/**
 * Fit reconstructed text to the pixels it replaces without distorting glyphs.
 *
 * Editable text used to be squeezed into each OCR box with an independent
 * horizontal scale. Any mismatch between the substitute font and the scanned
 * font then turned into condensed or stretched letters, and neighbouring runs
 * on one line ended up with visibly different proportions. Instead, every run
 * keeps a 1:1 aspect ratio: the font size is chosen from both the ink height
 * and the width the font would naturally occupy, sizes are shared across a
 * line and snapped to the few sizes a page actually uses, and any remaining
 * width difference is absorbed by letter spacing, which never changes a
 * glyph's shape.
 */

/** Fabric's line box multiplier and the fraction of it below the baseline. */
export const FABRIC_FONT_SIZE_MULT = 1.13;
export const FABRIC_FONT_SIZE_FRACTION = 0.222;
/** Distance from a Fabric text object's top edge to its first baseline (lineHeight 1). */
export const BASELINE_OFFSET =
  FABRIC_FONT_SIZE_MULT * (1 - FABRIC_FONT_SIZE_FRACTION);

/** Letter spacing is in thousandths of an em; beyond these limits text reads as spaced out or crushed. */
export const MIN_CHAR_SPACING = -80;
export const MAX_CHAR_SPACING = 160;
/** The width-derived size may only refine the height estimate, not replace it. */
const MIN_WIDTH_RATIO = 0.78;
const MAX_WIDTH_RATIO = 1.28;
/** Sizes within this relative distance are treated as the same typographic size. */
const SIZE_CLUSTER_TOLERANCE = 0.09;
/** Bold is only inferred when regular type must be widened by more than this… */
const BOLD_TRIGGER = 1.1;
/** …and bold type fits the measured width at least this much better. */
const BOLD_IMPROVEMENT = 0.5;

export type FontWeight = "normal" | "bold";

export interface TextMeasure {
  /**
   * Natural advance width of `text` at 1px, including word spaces.
   * Canvas widths scale linearly with font size, so one measurement suffices.
   */
  (text: string, weight: FontWeight): number;
}

export interface FitRequest {
  text: string;
  /** Width, in page pixels, occupied by the original ink. */
  targetWidth: number;
  /** Font size estimated from glyph heights. */
  heightSize: number;
  /** Known weight (for example from PDF font names); omit to allow inference. */
  fontWeight?: FontWeight;
  /** The size is authoritative (PDF text): only letter spacing may change. */
  exactSize?: boolean;
}

export interface FittedText {
  fontSize: number;
  fontWeight: FontWeight;
  /** Fabric charSpacing in thousandths of an em. */
  charSpacing: number;
  /** Width of the fitted text in page pixels, suitable for a Textbox width. */
  width: number;
}

export function graphemeCount(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    let count = 0;
    for (const _ of segmenter.segment(text)) count++;
    return count;
  }
  return [...text].length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isUsable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Font size at which `text` naturally spans the target width. */
export function widthDerivedSize(
  unitWidth: number,
  targetWidth: number,
): number {
  if (!isUsable(unitWidth) || !isUsable(targetWidth)) return Number.NaN;
  return targetWidth / unitWidth;
}

/**
 * Keep the width estimate inside a plausible band around the height estimate.
 * Very short words and substituted fonts make width alone unreliable.
 */
export function reconcileSize(heightSize: number, widthSize: number): number {
  if (!isUsable(heightSize)) return isUsable(widthSize) ? widthSize : 12;
  if (!isUsable(widthSize)) return heightSize;
  return clamp(
    widthSize,
    heightSize * MIN_WIDTH_RATIO,
    heightSize * MAX_WIDTH_RATIO,
  );
}

/** Letter spacing (thousandths of an em) that makes natural text span the target width. */
export function spacingToFit(
  naturalWidth: number,
  targetWidth: number,
  fontSize: number,
  graphemes: number,
): number {
  // Fabric adds charSpacing after every grapheme except the last on a line.
  const gaps = graphemes - 1;
  if (gaps < 1 || !isUsable(fontSize) || !isUsable(targetWidth)) return 0;
  const perGap = (targetWidth - naturalWidth) / gaps;
  const spacing = (perGap / fontSize) * 1000;
  return Math.round(clamp(spacing, MIN_CHAR_SPACING, MAX_CHAR_SPACING));
}

/** Width that Fabric will lay out for the text with the given spacing. */
export function laidOutWidth(
  unitWidth: number,
  fontSize: number,
  charSpacing: number,
  graphemes: number,
): number {
  return (
    unitWidth * fontSize +
    Math.max(0, graphemes - 1) * (charSpacing / 1000) * fontSize
  );
}

/**
 * Decide whether bold type explains a run that regular type cannot fill.
 * Both conditions must hold, so ordinary letter-spaced text stays regular.
 */
export function inferWeight(
  measure: TextMeasure,
  request: FitRequest,
  fontSize: number,
): FontWeight {
  if (request.fontWeight) return request.fontWeight;
  const letters = request.text.replace(/[^\p{L}\p{N}]/gu, "");
  if ([...letters].length < 3) return "normal";
  const regular = measure(request.text, "normal") * fontSize;
  const bold = measure(request.text, "bold") * fontSize;
  if (!isUsable(regular) || !isUsable(bold) || bold <= regular) return "normal";
  if (request.targetWidth < regular * BOLD_TRIGGER) return "normal";
  const regularError = Math.abs(request.targetWidth - regular);
  const boldError = Math.abs(request.targetWidth - bold);
  return boldError <= regularError * BOLD_IMPROVEMENT ? "bold" : "normal";
}

/** Fit one run at an already agreed font size. */
export function fitAtSize(
  measure: TextMeasure,
  request: FitRequest,
  fontSize: number,
): FittedText {
  const fontWeight = inferWeight(measure, request, fontSize);
  const unitWidth = measure(request.text, fontWeight);
  const graphemes = graphemeCount(request.text);
  const natural = unitWidth * fontSize;
  const charSpacing = isUsable(unitWidth)
    ? spacingToFit(natural, request.targetWidth, fontSize, graphemes)
    : 0;
  const width = isUsable(unitWidth)
    ? laidOutWidth(unitWidth, fontSize, charSpacing, graphemes)
    : request.targetWidth;
  return { fontSize, fontWeight, charSpacing, width };
}

/** Candidate size for one run before line and page harmonisation. */
export function preferredSize(
  measure: TextMeasure,
  request: FitRequest,
): number {
  if (request.exactSize && isUsable(request.heightSize))
    return request.heightSize;
  const weights: FontWeight[] = request.fontWeight
    ? [request.fontWeight]
    : ["normal", "bold"];
  // Bold scans are wider than regular Arial; measuring only regular type would
  // mistake their extra width for a larger size. Keep whichever weight agrees
  // best with the glyph height, then clamp it to the plausible band.
  let best = Number.NaN;
  for (const weight of weights) {
    const candidate = widthDerivedSize(
      measure(request.text, weight),
      request.targetWidth,
    );
    if (!isUsable(candidate)) continue;
    if (
      !isUsable(best) ||
      Math.abs(Math.log(candidate / request.heightSize)) <
        Math.abs(Math.log(best / request.heightSize))
    )
      best = candidate;
  }
  return reconcileSize(request.heightSize, best);
}

interface WeightedSize {
  size: number;
  weight: number;
}

/** Weighted median: robust to the odd short word whose box is misleading. */
export function weightedMedian(values: readonly WeightedSize[]): number {
  const usable = values
    .filter((value) => isUsable(value.size) && isUsable(value.weight))
    .sort((a, b) => a.size - b.size);
  if (!usable.length) return Number.NaN;
  const total = usable.reduce((sum, value) => sum + value.weight, 0);
  let running = 0;
  for (const value of usable) {
    running += value.weight;
    if (running >= total / 2) return value.size;
  }
  return usable.at(-1)!.size;
}

/**
 * Group sizes that differ by less than the tolerance and replace each with its
 * cluster's weighted mean, so headings and body text each get one size.
 */
export function harmonizeSizes(values: readonly WeightedSize[]): number[] {
  const order = values
    .map((value, index) => ({ ...value, index }))
    .filter((value) => isUsable(value.size))
    .sort((a, b) => a.size - b.size);
  const result = values.map((value) => value.size);
  let cluster: typeof order = [];
  const flush = () => {
    if (!cluster.length) return;
    const weight = cluster.reduce(
      (sum, value) => sum + Math.max(1, value.weight),
      0,
    );
    const size =
      cluster.reduce(
        (sum, value) => sum + value.size * Math.max(1, value.weight),
        0,
      ) / weight;
    for (const value of cluster) result[value.index] = size;
    cluster = [];
  };
  for (const value of order) {
    // Compare with the cluster's smallest member so clusters cannot drift upward indefinitely.
    if (
      cluster.length &&
      value.size > cluster[0].size * (1 + SIZE_CLUSTER_TOLERANCE)
    )
      flush();
    cluster.push(value);
  }
  flush();
  return result.map((size) => Math.round(size * 10) / 10);
}

export interface LineRun extends FitRequest {
  /** Runs sharing a key come from the same printed line. */
  line: number;
}

/**
 * Fit every run on a page. Runs on one line share a size; lines that differ
 * only by estimation noise share a size; nothing is scaled non-uniformly.
 */
export function fitPageText<T extends LineRun>(
  measureFor: (run: T) => TextMeasure,
  runs: readonly T[],
): FittedText[] {
  const lineSizes = new Map<number, WeightedSize[]>();
  for (const run of runs) {
    if (run.exactSize) continue;
    const size = preferredSize(measureFor(run), run);
    const weight = Math.max(1, graphemeCount(run.text.replace(/\s/g, "")));
    const entry = lineSizes.get(run.line) ?? [];
    entry.push({ size, weight });
    lineSizes.set(run.line, entry);
  }
  const lines = [...lineSizes.entries()].map(([line, sizes]) => ({
    line,
    size: weightedMedian(sizes),
    weight: sizes.reduce((sum, value) => sum + value.weight, 0),
  }));
  const harmonized = harmonizeSizes(lines);
  const sizeOfLine = new Map(
    lines.map((line, index) => [line.line, harmonized[index]]),
  );
  return runs.map((run) => {
    const size = run.exactSize ? run.heightSize : sizeOfLine.get(run.line);
    return fitAtSize(
      measureFor(run),
      run,
      size !== undefined && isUsable(size) ? size : Math.max(1, run.heightSize),
    );
  });
}

/** Canvas-backed measurement, cached because pages repeat many words. */
export function canvasMeasure(
  context: CanvasRenderingContext2D,
  fontFamily: string,
  fontStyle: "normal" | "italic" = "normal",
): TextMeasure {
  const cache = new Map<string, number>();
  const reference = 100;
  return (text, weight) => {
    const key = `${weight}\u0000${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      context.font = `${fontStyle} ${weight} ${reference}px ${fontFamily}`;
      width = context.measureText(text).width / reference;
      cache.set(key, width);
    }
    return width;
  };
}
