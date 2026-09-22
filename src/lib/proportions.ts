import { FabricImage, Textbox, type FabricObject } from "fabric";

/**
 * Text and pictures must never be stretched in one direction: a squeezed
 * letter or photo is the "distortion" people notice first. Shapes keep free
 * resizing because changing a rectangle's aspect ratio is the point of it.
 */
export type ResizeKind = "text" | "image" | "shape";

export interface Dimensions {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

export function resizeKind(object: FabricObject): ResizeKind {
  if (object instanceof Textbox) return "text";
  if (object instanceof FabricImage) return "image";
  return "shape";
}

function positive(value: number, fallback = 1): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Uniform scale shared by both axes, based on the larger current axis scale. */
export function uniformScale(dimensions: Dimensions): number {
  return positive(
    Math.max(Math.abs(dimensions.scaleX), Math.abs(dimensions.scaleY)),
  );
}

/**
 * Properties to apply when a Width or Height field changes.
 * Text reflows by changing its box width and scales only uniformly;
 * images scale uniformly; shapes resize freely along one axis.
 */
export function resizeProps(
  kind: ResizeKind,
  dimensions: Dimensions,
  axis: "width" | "height",
  value: number,
): Record<string, number> {
  const target = positive(value);
  const width = positive(dimensions.width);
  const height = positive(dimensions.height);
  if (kind === "shape") {
    return axis === "width"
      ? { scaleX: target / width }
      : { scaleY: target / height };
  }
  if (kind === "text" && axis === "width") {
    // Keep glyphs at their current proportions and let the words rewrap.
    const scale = uniformScale(dimensions);
    return { width: target / scale, scaleX: scale, scaleY: scale };
  }
  const scale = target / (axis === "width" ? width : height);
  return { scaleX: scale, scaleY: scale };
}

/** Undo any stretch that an older project or a previous version introduced. */
export function repairedScale(dimensions: Dimensions): {
  scaleX: number;
  scaleY: number;
} | null {
  const x = Math.abs(dimensions.scaleX),
    y = Math.abs(dimensions.scaleY);
  if (!(x > 0) || !(y > 0) || Math.abs(x / y - 1) < 0.001) return null;
  const scale = Math.sqrt(x * y);
  return {
    scaleX: Math.sign(dimensions.scaleX || 1) * scale,
    scaleY: Math.sign(dimensions.scaleY || 1) * scale,
  };
}

/**
 * Remove the canvas handles that stretch along one axis. Corner handles keep
 * proportional scaling, and Textbox side handles only change the wrap width.
 */
export function protectProportions(object: FabricObject): void {
  const kind = resizeKind(object);
  if (kind === "shape") return;
  object.set({ lockSkewingX: true, lockSkewingY: true });
  if (kind === "image") {
    object.setControlsVisibility({
      ml: false,
      mr: false,
      mt: false,
      mb: false,
    });
  } else {
    object.setControlsVisibility({ mt: false, mb: false });
  }
}

/**
 * Text that was stretched on import is rebuilt at its visual height with no
 * scaling at all, so existing drafts stop looking distorted too. The box is
 * widened only as far as needed to keep the original number of lines.
 */
export function straightenText(object: FabricObject): boolean {
  if (!(object instanceof Textbox)) return false;
  if (!repairedScale(object)) return false;
  const lines = Math.max(1, object.textLines.length);
  const visualWidth = object.width * Math.abs(object.scaleX);
  const fontScale = positive(Math.abs(object.scaleY));
  object.set({
    fontSize: Math.max(1, object.fontSize * fontScale),
    scaleX: 1,
    scaleY: 1,
    width: Math.max(1, visualWidth),
  });
  object.initDimensions();
  for (
    let attempt = 0;
    attempt < 8 && object.textLines.length > lines;
    attempt++
  ) {
    object.set({ width: object.width * 1.1 + 2 });
    object.initDimensions();
  }
  object.setCoords();
  return true;
}
