import {
  Canvas,
  Color,
  FabricImage,
  FabricObject,
  FabricText,
  Group,
  Line,
  Path,
  Polygon,
  Polyline,
  Rect,
  StaticCanvas,
  util,
} from "fabric";
import type PptxGenJS from "pptxgenjs";
import {
  downloadBlob,
  safeFileName,
  validateProject,
  type GraphicProject,
} from "./project";

/** Call with the canvas at its logical page dimensions and an identity viewport. */
export function exportPng(canvas: Canvas, name: string): void {
  const data = canvas.toDataURL({
    format: "png",
    multiplier: 1,
    enableRetinaScaling: false,
  });
  const bytes = Uint8Array.from(
    atob(data.slice(data.indexOf(",") + 1)),
    (character) => character.charCodeAt(0),
  );
  downloadBlob(
    new Blob([bytes], { type: "image/png" }),
    `${safeFileName(name)}.png`,
  );
}

/** SVG preserves vector paths and text; imported raster images remain images. */
export function exportSvg(canvas: Canvas, name: string): void {
  downloadBlob(
    new Blob([canvas.toSVG()], { type: "image/svg+xml;charset=utf-8" }),
    `${safeFileName(name)}.svg`,
  );
}

type ExportContext = {
  presentation: PptxGenJS;
  slide: PptxGenJS.Slide;
  factor: number;
  offsetX: number;
  offsetY: number;
  rasterized: number;
};

function paint(
  value: unknown,
  opacity = 1,
): { color: string; transparency: number } {
  if (typeof value !== "string" || !value)
    return { color: "000000", transparency: 100 };
  const color = new Color(value);
  return {
    color: color.toHex(),
    transparency: Math.round((1 - color.getAlpha() * opacity) * 100),
  };
}

function nativePaint(object: FabricObject): boolean {
  return (
    (!object.fill || typeof object.fill === "string") &&
    (!object.stroke || typeof object.stroke === "string")
  );
}

function objectName(object: FabricObject): string {
  const label: unknown = object.get("name");
  // PptxGenJS places object names directly into an XML attribute.
  return (typeof label === "string" ? label : object.type)
    .replace(/[<>&"']/g, "")
    .slice(0, 150);
}

function geometry(object: FabricObject, context: ExportContext) {
  const matrix = util.qrDecompose(object.calcTransformMatrix());
  const width = Math.abs(object.width * matrix.scaleX) * context.factor;
  const height = Math.abs(object.height * matrix.scaleY) * context.factor;
  return {
    matrix,
    props: {
      x: context.offsetX + matrix.translateX * context.factor - width / 2,
      y: context.offsetY + matrix.translateY * context.factor - height / 2,
      w: width,
      h: height,
      rotate: ((matrix.angle % 360) + 360) % 360,
      flipH: matrix.scaleX < 0,
      flipV: matrix.scaleY < 0,
      objectName: objectName(object),
    },
  };
}

function shapeStyle(
  object: FabricObject,
  opacity: number,
  factor: number,
): Pick<PptxGenJS.ShapeProps, "fill" | "line"> {
  return {
    fill: paint(object.fill, opacity),
    line: {
      ...paint(object.stroke, opacity),
      width:
        object.strokeWidth *
        (object.strokeUniform ? 1 : object.getObjectScaling().x) *
        factor *
        72,
      dashType: object.strokeDashArray?.length ? "dash" : "solid",
      beginArrowType: "none",
      endArrowType: "none",
    },
  };
}

function textRuns(
  object: FabricText,
  opacity: number,
  fontScale: number,
): PptxGenJS.TextProps[] {
  // Use unwrapped lines: PowerPoint performs its own wrapping inside the editable box.
  const runs: PptxGenJS.TextProps[] = [];
  const lines = object.text.split("\n");
  let previousStyle = "";
  lines.forEach((line, lineIndex) => {
    const characters = Array.from(line);
    characters.forEach((character, index) => {
      const style = object.getCompleteStyleDeclaration(lineIndex, index);
      const color = paint(style.fill, opacity);
      const run: PptxGenJS.TextProps = {
        text: character,
        options: {
          fontFace: style.fontFamily,
          fontSize: Math.max(1, style.fontSize * fontScale),
          bold: style.fontWeight === "bold" || Number(style.fontWeight) >= 600,
          italic: style.fontStyle === "italic" || style.fontStyle === "oblique",
          underline: style.underline ? { style: "sng" } : undefined,
          strike: style.linethrough,
          color: color.color,
          transparency: color.transparency,
        },
      };
      const signature = JSON.stringify(run.options);
      if (signature === previousStyle && runs.length)
        runs[runs.length - 1].text += character;
      else runs.push(run);
      previousStyle = signature;
    });
    if (lineIndex < lines.length - 1) {
      runs.push({ text: "\n" });
      previousStyle = "";
    }
  });
  return runs;
}

function customPoints(
  object: Path | Polyline,
  scaleX: number,
  scaleY: number,
): PptxGenJS.ShapeProps["points"] {
  const x = (value: number) =>
    (value - object.pathOffset.x + object.width / 2) * scaleX;
  const y = (value: number) =>
    (value - object.pathOffset.y + object.height / 2) * scaleY;
  if (object instanceof Path) {
    return object.path.map((command) => {
      switch (command[0]) {
        case "M":
          return { x: x(command[1]), y: y(command[2]), moveTo: true };
        case "L":
          return { x: x(command[1]), y: y(command[2]) };
        case "C":
          return {
            x: x(command[5]),
            y: y(command[6]),
            curve: {
              type: "cubic" as const,
              x1: x(command[1]),
              y1: y(command[2]),
              x2: x(command[3]),
              y2: y(command[4]),
            },
          };
        case "Q":
          return {
            x: x(command[3]),
            y: y(command[4]),
            curve: {
              type: "quadratic" as const,
              x1: x(command[1]),
              y1: y(command[2]),
            },
          };
        case "Z":
          return { close: true as const };
      }
    });
  }
  const points: NonNullable<PptxGenJS.ShapeProps["points"]> = object.points.map(
    (point, index) => ({
      x: x(point.x),
      y: y(point.y),
      moveTo: index === 0,
    }),
  );
  if (object instanceof Polygon) points.push({ close: true });
  return points;
}

async function addRasterFallback(
  object: FabricObject,
  opacity: number,
  context: ExportContext,
): Promise<void> {
  const clone = await object.clone();
  try {
    // Baking a group's full transform onto a detached clone also handles nested children.
    util.applyTransformToObject(clone, object.calcTransformMatrix());
    clone.set({ opacity });
    clone.setCoords();
    const center = clone.getCenterPoint();
    const bounds = clone.getBoundingRect();
    const multiplier = Math.min(
      2,
      4096 / Math.max(1, bounds.width, bounds.height),
    );
    const bitmap = clone.toCanvasElement({
      multiplier,
      enableRetinaScaling: false,
    });
    const width = (bitmap.width / multiplier) * context.factor;
    const height = (bitmap.height / multiplier) * context.factor;
    context.slide.addImage({
      data: bitmap.toDataURL("image/png"),
      x: context.offsetX + center.x * context.factor - width / 2,
      y: context.offsetY + center.y * context.factor - height / 2,
      w: width,
      h: height,
      objectName: objectName(object),
      altText:
        "Rendered element: its appearance is preserved as a separate movable image.",
    });
    bitmap.width = bitmap.height = 0;
    context.rasterized++;
  } finally {
    clone.dispose();
  }
}

async function addObject(
  object: FabricObject,
  parentOpacity: number,
  context: ExportContext,
): Promise<void> {
  if (!object.visible || object.opacity === 0) return;
  const opacity = object.opacity * parentOpacity;
  const { matrix, props } = geometry(object, context);
  const complex =
    !!object.clipPath ||
    !!object.shadow ||
    !nativePaint(object) ||
    Math.abs(matrix.skewX) > 0.01 ||
    Math.abs(matrix.skewY) > 0.01 ||
    object.globalCompositeOperation !== "source-over";
  if (complex) {
    await addRasterFallback(object, opacity, context);
    return;
  }
  if (object instanceof Group) {
    for (const child of object.getObjects())
      await addObject(child, opacity, context);
    return;
  }
  if (object instanceof FabricText) {
    if (object.path) {
      await addRasterFallback(object, opacity, context);
      return;
    }
    const fontScale = Math.abs(matrix.scaleY) * context.factor * 72;
    context.slide.addText(textRuns(object, opacity, fontScale), {
      ...props,
      margin: 0,
      breakLine: false,
      valign: "top",
      align: object.textAlign.startsWith("justify")
        ? "justify"
        : (object.textAlign as "left" | "center" | "right"),
      fontFace: object.fontFamily,
      fontSize: Math.max(1, object.fontSize * fontScale),
      lineSpacingMultiple: object.lineHeight,
      charSpacing: (object.charSpacing / 1000) * object.fontSize * fontScale,
      paraSpaceAfter: 0,
      paraSpaceBefore: 0,
      fit: "shrink",
      isTextBox: true,
      color: paint(object.fill, opacity).color,
      transparency: paint(object.fill, opacity).transparency,
    });
    return;
  }
  if (object instanceof FabricImage) {
    // Render only the picture's crop, leaving its size, rotation and position editable.
    const bitmap = object.toCanvasElement({
      withoutTransform: true,
      withoutShadow: true,
      enableRetinaScaling: false,
    });
    context.slide.addImage({
      ...props,
      data: bitmap.toDataURL("image/png"),
      transparency: (1 - parentOpacity) * 100,
    });
    bitmap.width = bitmap.height = 0;
    return;
  }
  const shape = shapeStyle(object, opacity, context.factor);
  if (object instanceof Line) {
    const local = object.calcLinePoints();
    const transform = object.calcTransformMatrix();
    const first = util.transformPoint({ x: local.x1, y: local.y1 }, transform);
    const last = util.transformPoint({ x: local.x2, y: local.y2 }, transform);
    context.slide.addShape(context.presentation.ShapeType.line, {
      ...shape,
      x: context.offsetX + Math.min(first.x, last.x) * context.factor,
      y: context.offsetY + Math.min(first.y, last.y) * context.factor,
      w: Math.abs(last.x - first.x) * context.factor,
      h: Math.abs(last.y - first.y) * context.factor,
      flipH: last.x < first.x,
      flipV: last.y < first.y,
      objectName: objectName(object),
    });
    return;
  }
  if (object instanceof Path || object instanceof Polyline) {
    // v4 supports custom geometry at runtime; its ShapeType declaration omits it.
    context.slide.addShape("custGeom" as PptxGenJS.ShapeType, {
      ...props,
      ...shape,
      points: customPoints(
        object,
        Math.abs(matrix.scaleX) * context.factor,
        Math.abs(matrix.scaleY) * context.factor,
      ),
    });
    return;
  }
  const type = object.type.toLowerCase();
  const shapeType =
    type === "circle" || type === "ellipse"
      ? context.presentation.ShapeType.ellipse
      : type === "triangle"
        ? context.presentation.ShapeType.triangle
        : object instanceof Rect
          ? object.rx || object.ry
            ? context.presentation.ShapeType.roundRect
            : context.presentation.ShapeType.rect
          : null;
  if (shapeType) {
    context.slide.addShape(shapeType, {
      ...props,
      ...shape,
      rectRadius:
        object instanceof Rect
          ? Math.min(1, object.rx * Math.abs(matrix.scaleX) * context.factor)
          : undefined,
    });
    return;
  }
  await addRasterFallback(object, opacity, context);
}

/**
 * Native editable text, shapes and paths; pictures remain separate pictures.
 * Clipping, gradients, skew, text on paths and shadows are rasterized per element.
 * PowerPoint uses one slide size, so other page sizes fit inside the first page.
 */
export async function exportPptx(project: GraphicProject): Promise<void> {
  const checked = validateProject(project);
  const { default: PptxGenJSClass } = await import("pptxgenjs");
  const presentation = new PptxGenJSClass();
  const first = checked.pages[0];
  // Keep PowerPoint dimensions within its supported 56 inch maximum.
  const pixelsPerInch = Math.max(96, Math.max(first.width, first.height) / 50);
  const slideWidth = first.width / pixelsPerInch;
  const slideHeight = first.height / pixelsPerInch;
  presentation.defineLayout({
    name: "GRAPHIC",
    width: slideWidth,
    height: slideHeight,
  });
  presentation.layout = "GRAPHIC";
  presentation.author = "Graphic";
  presentation.subject = "Editable Graphic project";
  presentation.title = checked.name;
  for (const page of checked.pages) {
    const canvas = new StaticCanvas(document.createElement("canvas"), {
      width: page.width,
      height: page.height,
      enableRetinaScaling: false,
      renderOnAddRemove: false,
    });
    try {
      await canvas.loadFromJSON(page.json);
      canvas.setDimensions({ width: page.width, height: page.height });
      canvas.renderAll();
      const slide = presentation.addSlide();
      const factor = Math.min(
        slideWidth / page.width,
        slideHeight / page.height,
      );
      const context: ExportContext = {
        presentation,
        slide,
        factor,
        offsetX: (slideWidth - page.width * factor) / 2,
        offsetY: (slideHeight - page.height * factor) / 2,
        rasterized: 0,
      };
      if (typeof canvas.backgroundColor === "string") {
        slide.background = {
          color: paint(canvas.backgroundColor || "#ffffff").color,
        };
      }
      if (canvas.backgroundImage)
        await addObject(canvas.backgroundImage, 1, context);
      for (const object of canvas.getObjects())
        await addObject(object, 1, context);
      if (canvas.overlayImage) await addObject(canvas.overlayImage, 1, context);
      slide.addNotes(
        [
          `Source page: ${page.name}. Text, standard shapes and vector paths are editable. Pictures can be moved, resized, rotated and cropped.`,
          "Fonts and text wrapping may vary between browsers and PowerPoint. Image crops are baked into picture pixels.",
          context.rasterized
            ? `${context.rasterized} complex element(s) were rendered as separate images to preserve clipping, gradients, shadows, skew or other effects.`
            : "",
          "PowerPoint uses a single slide size. Pages with other dimensions are proportionally fitted and centered.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } finally {
      await canvas.dispose();
    }
  }
  const output = await presentation.write({
    outputType: "blob",
    compression: true,
  });
  if (!(output instanceof Blob))
    throw new Error("PowerPoint export did not produce a downloadable file.");
  downloadBlob(output, `${safeFileName(checked.name)}.pptx`);
}
