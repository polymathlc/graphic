import { FabricImage, Textbox, type FabricObject } from "fabric";
import {
  borderColor,
  clampRegion,
  cssColor,
  findGraphicRegions,
  inkColor,
  pageColor,
  type Region,
} from "./segmentation";
import type { Worker as OCRWorker } from "tesseract.js";
import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";

export interface ImportedPage {
  id: string;
  name: string;
  width: number;
  height: number;
  objects: FabricObject[];
  warnings: string[];
}

type Progress = (message: string, progress: number) => void;
interface TextRegion extends Region {
  text: string;
  fontSize: number;
  fontFamily: string;
  angle: number;
  fontWeight?: "normal" | "bold";
  fontStyle?: "normal" | "italic";
  direction?: "ltr" | "rtl";
}

const MAX_EDGE = 1800;
const MAX_PAGES = 20;
const MAX_TEXT_BOXES = 1500;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const RECONSTRUCTION_WARNING =
  "Text and graphics are reconstructed approximately. Review recognized words, font sizes, and spacing. Graphics remain raster images; backgrounds beneath text are estimated from nearby colors.";

async function deadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Text recognition timed out.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error(
      "Your browser could not create an image canvas. Try a smaller file.",
    );
  return context;
}

function named<T extends FabricObject>(object: T, name: string): T {
  object.set({ name, id: crypto.randomUUID() });
  return object;
}

async function imageCanvas(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error(
        "This image could not be decoded. Try a PNG, JPEG, WebP, or another browser-supported image.",
      );
    }
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error("This image has no usable dimensions.");
    const scale = Math.min(
      1,
      MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = canvasOf(
      image.naturalWidth * scale,
      image.naturalHeight * scale,
    );
    const context = contextOf(canvas);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function textBounds(text: TextRegion, padding = 2): Region {
  const angle = (text.angle * Math.PI) / 180;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const corners = [
    [0, 0],
    [text.width, 0],
    [0, text.height],
    [text.width, text.height],
  ];
  const xs = corners.map(([x, y]) => text.x + x * cos - y * sin);
  const ys = corners.map(([x, y]) => text.y + x * sin + y * cos);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return {
    x: x - padding,
    y: y - padding,
    width: Math.max(...xs) - x + padding * 2,
    height: Math.max(...ys) - y + padding * 2,
  };
}

function makeText(text: TextRegion, fill: string): Textbox {
  const measure = contextOf(canvasOf(1, 1));
  measure.font = `${text.fontStyle ?? "normal"} ${text.fontWeight ?? "normal"} ${text.fontSize}px ${text.fontFamily}`;
  const naturalWidth = Math.max(1, measure.measureText(text.text).width + 2);
  const object = new Textbox(text.text, {
    left: text.x,
    top: text.y - text.fontSize * 0.12,
    originX: "left",
    originY: "top",
    width: naturalWidth,
    fontSize: text.fontSize,
    fontFamily: text.fontFamily,
    fontWeight: text.fontWeight ?? "normal",
    fontStyle: text.fontStyle ?? "normal",
    direction: text.direction ?? "ltr",
    textAlign: text.direction === "rtl" ? "right" : "left",
    fill,
    angle: text.angle,
    lineHeight: 1,
    padding: 3,
    splitByGrapheme: false,
  });
  object.set({ scaleX: text.width / Math.max(1, object.width) });
  return named(
    object,
    text.text.length > 42 ? `${text.text.slice(0, 39)}…` : text.text,
  );
}

/** Make independent opaque crops; masking is intentionally approximate, not generative inpainting. */
async function assemblePage(
  source: HTMLCanvasElement,
  texts: TextRegion[],
  name: string,
  warnings: string[],
): Promise<ImportedPage> {
  const width = source.width,
    height = source.height;
  const original = contextOf(source).getImageData(0, 0, width, height);
  const cleaned = canvasOf(width, height);
  const context = contextOf(cleaned);
  context.drawImage(source, 0, 0);
  const textObjects: Textbox[] = [];
  for (const text of texts) {
    const bounds = clampRegion(textBounds(text), width, height);
    if (!bounds.width || !bounds.height) continue;
    const background = borderColor(original, bounds);
    const fill = inkColor(original, bounds, background);
    context.save();
    context.translate(text.x, text.y);
    context.rotate((text.angle * Math.PI) / 180);
    context.fillStyle = cssColor(background);
    context.fillRect(-2, -2, text.width + 4, text.height + 4);
    context.restore();
    textObjects.push(makeText(text, fill));
  }

  const cleanPixels = context.getImageData(0, 0, width, height);
  const regions = findGraphicRegions(cleanPixels);
  const backgroundColor = pageColor(cleanPixels);
  const base = canvasOf(width, height);
  const baseContext = contextOf(base);
  baseContext.drawImage(cleaned, 0, 0);
  const graphics: FabricImage[] = [];
  for (const [index, region] of regions.entries()) {
    const crop = canvasOf(region.width, region.height);
    contextOf(crop).drawImage(
      cleaned,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      region.width,
      region.height,
    );
    // A full-page/photo crop gets a neutral backing so the entire image can still be moved/cropped.
    baseContext.fillStyle = cssColor(backgroundColor);
    baseContext.fillRect(region.x, region.y, region.width, region.height);
    graphics.push(
      named(
        new FabricImage(crop, {
          left: region.x,
          top: region.y,
          originX: "left",
          originY: "top",
        }),
        regions.length === 1 &&
          region.width * region.height > width * height * 0.8
          ? "Image artwork"
          : `Graphic ${index + 1}`,
      ),
    );
  }
  const background = named(
    new FabricImage(base, {
      left: 0,
      top: 0,
      originX: "left",
      originY: "top",
      selectable: false,
      evented: false,
      lockMovementX: true,
      lockMovementY: true,
      lockScalingX: true,
      lockScalingY: true,
      lockRotation: true,
      hasControls: false,
    }),
    "Page background",
  );
  if (!texts.length)
    warnings.push(
      "No editable text was detected. The page is available as image elements; you can add text manually.",
    );
  if (texts.length >= MAX_TEXT_BOXES)
    warnings.push(
      `Only the first ${MAX_TEXT_BOXES} text runs were converted. Remaining content stays in the raster background.`,
    );
  return {
    id: crypto.randomUUID(),
    name,
    width,
    height,
    objects: [background, ...graphics, ...textObjects],
    warnings: [...new Set(warnings)],
  };
}

class OCRSession {
  private worker?: OCRWorker;
  private progress: Progress = () => {};
  private failed = false;
  private closed = false;
  constructor(private language: string) {}

  async recognize(
    canvas: HTMLCanvasElement,
    progress: Progress,
  ): Promise<TextRegion[]> {
    if (this.failed) throw new Error("OCR is unavailable for this import.");
    this.progress = progress;
    try {
      if (!this.worker) {
        progress(
          "Loading text recognition · first use downloads language data",
          0.03,
        );
        const [{ createWorker, PSM }, { default: workerPath }] =
          await Promise.all([
            import("tesseract.js"),
            import("tesseract.js/dist/worker.min.js?url"),
          ]);
        let rejectInitialization: (reason?: unknown) => void = () => {};
        const initializationError = new Promise<never>((_, reject) => {
          rejectInitialization = reject;
        });
        const initialization = createWorker(this.language, 1, {
          workerPath,
          errorHandler: (error) => rejectInitialization(error),
          logger: (message) => {
            if (message.status === "recognizing text")
              this.progress(
                "Recognizing editable text",
                0.2 + message.progress * 0.75,
              );
          },
        });
        // Tesseract 7 can leave createWorker pending after a language-download error.
        // Surface that error and also release a worker if it finishes after timeout/cleanup.
        void initialization.then(
          (worker) => {
            if (this.closed || this.failed) void worker.terminate();
          },
          () => {},
        );
        this.worker = await deadline(
          Promise.race([initialization, initializationError]),
          90_000,
        );
        await this.worker.setParameters({
          tessedit_pageseg_mode: PSM.AUTO,
          preserve_interword_spaces: "1",
        });
      }
      const result = await deadline(
        this.worker.recognize(canvas, {}, { blocks: true, text: true }),
        90_000,
      );
      const lines = (result.data.blocks ?? []).flatMap((block) =>
        block.paragraphs.flatMap((paragraph) => paragraph.lines),
      );
      return lines
        .filter(
          (line) =>
            line.text.trim() &&
            line.confidence >= 45 &&
            line.bbox.x1 > line.bbox.x0 &&
            line.bbox.y1 > line.bbox.y0,
        )
        .slice(0, MAX_TEXT_BOXES)
        .map((line) => ({
          x: line.bbox.x0,
          y: line.bbox.y0,
          width: line.bbox.x1 - line.bbox.x0,
          height: line.bbox.y1 - line.bbox.y0,
          text: line.text.trim().replace(/\s+/g, " "),
          fontSize: Math.max(6, (line.bbox.y1 - line.bbox.y0) * 1.16),
          fontFamily: "Arial",
          angle: 0,
        }));
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.worker) await this.worker.terminate().catch(() => {});
    this.worker = undefined;
  }
}

async function recognizeSafely(
  canvas: HTMLCanvasElement,
  session: OCRSession,
  progress: Progress,
  warnings: string[],
): Promise<TextRegion[]> {
  try {
    return await session.recognize(canvas, progress);
  } catch {
    warnings.push(
      "Text recognition could not finish. Check your connection for the initial OCR engine/language download and try importing again. Image editing is still available.",
    );
    return [];
  }
}

function fontFamily(name: string): string {
  if (/mono|courier/i.test(name)) return "Courier New";
  if (/times|georgia|serif/i.test(name) && !/sans/i.test(name))
    return "Georgia";
  return "Arial";
}

async function nativePDFText(
  page: PDFPageProxy,
  scale: number,
  transform: number[],
): Promise<TextRegion[]> {
  const content = await page.getTextContent();
  const pdfjs = await import("pdfjs-dist");
  return content.items
    .filter(
      (item): item is TextItem => "str" in item && Boolean(item.str.trim()),
    )
    .slice(0, MAX_TEXT_BOXES)
    .flatMap((item) => {
      const style = content.styles[item.fontName];
      const matrix = pdfjs.Util.transform(transform, item.transform);
      const fontSize = Math.hypot(matrix[2], matrix[3]);
      const width = Math.abs(
        (style?.vertical ? item.height : item.width) * scale,
      );
      if (!Number.isFinite(fontSize) || fontSize < 1 || width < 0.5) return [];
      const angle =
        Math.atan2(matrix[1], matrix[0]) + (style?.vertical ? Math.PI / 2 : 0);
      const ascent =
        fontSize *
        (style?.ascent ?? (style?.descent ? 1 + style.descent : 0.8));
      return [
        {
          text: item.str,
          x: matrix[4] + ascent * Math.sin(angle),
          y: matrix[5] - ascent * Math.cos(angle),
          width,
          height: fontSize * 1.1,
          fontSize,
          fontFamily: fontFamily(style?.fontFamily ?? ""),
          angle: (angle * 180) / Math.PI,
          direction: item.dir === "rtl" ? ("rtl" as const) : ("ltr" as const),
          fontWeight: /bold/i.test(style?.fontFamily ?? "")
            ? ("bold" as const)
            : ("normal" as const),
          fontStyle: /italic|oblique/i.test(style?.fontFamily ?? "")
            ? ("italic" as const)
            : ("normal" as const),
        },
      ];
    });
}

async function importPDF(
  file: File,
  onProgress: Progress,
  session: OCRSession,
): Promise<ImportedPage[]> {
  onProgress("Opening PDF", 0.02);
  const [pdfjs, { default: workerSrc }] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const assetRoot = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/`;
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${assetRoot}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetRoot}standard_fonts/`,
    wasmUrl: `${assetRoot}wasm/`,
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > MAX_PAGES)
      throw new Error(
        `This PDF has ${pdf.numPages} pages. Please upload a PDF with ${MAX_PAGES} pages or fewer.`,
      );
    const pages: ImportedPage[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const originalViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(
          2,
          MAX_EDGE / Math.max(originalViewport.width, originalViewport.height),
        );
        const viewport = page.getViewport({ scale });
        const canvas = canvasOf(viewport.width, viewport.height);
        const progress: Progress = (message, amount) =>
          onProgress(
            `Page ${number}/${pdf.numPages} · ${message}`,
            (number - 1 + amount) / pdf.numPages,
          );
        progress("Rendering page", 0.05);
        await page.render({
          canvas,
          canvasContext: contextOf(canvas),
          viewport,
        }).promise;
        const warnings = [RECONSTRUCTION_WARNING];
        let texts = await nativePDFText(page, scale, viewport.transform);
        if (!texts.length)
          texts = await recognizeSafely(
            canvas,
            session,
            (message, amount) => progress(message, 0.15 + amount * 0.7),
            warnings,
          );
        else
          warnings.push(
            "Selectable PDF text was extracted. Fonts use browser substitutes; text baked into images on this page remains in the artwork.",
          );
        progress("Separating graphics and text", 0.9);
        pages.push(
          await assemblePage(
            canvas,
            texts,
            `${file.name.replace(/\.pdf$/i, "")} · ${number}`,
            warnings,
          ),
        );
        progress("Ready", 1);
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error(
        "This PDF is password protected. Upload an unlocked copy to convert it.",
      );
    if (error instanceof Error && error.name === "InvalidPDFException")
      throw new Error(
        "This PDF could not be read. Try opening it in a PDF viewer and saving a new copy.",
      );
    throw error;
  } finally {
    await loading.destroy();
  }
}

/** Files stay in this browser. OCR/PDF engine assets may be downloaded on first use. */
export async function importFile(
  file: File,
  onProgress: Progress,
  options: { ocrLanguage?: string } = {},
): Promise<ImportedPage[]> {
  if (!file.size)
    throw new Error("This file is empty. Choose another image or PDF.");
  if (file.size > MAX_FILE_BYTES)
    throw new Error(
      "This file is larger than 25 MB. Try a smaller image or PDF.",
    );
  const isPDF = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (
    !isPDF &&
    !file.type.startsWith("image/") &&
    !/\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(file.name)
  ) {
    throw new Error("Choose an image or PDF file.");
  }
  const language = options.ocrLanguage ?? "eng";
  if (!/^[a-z_]+(?:\+[a-z_]+)*$/i.test(language))
    throw new Error("Choose a valid recognition language.");
  const session = new OCRSession(language);
  try {
    if (isPDF) return await importPDF(file, onProgress, session);
    onProgress("Reading image", 0.02);
    const canvas = await imageCanvas(file);
    const warnings = [RECONSTRUCTION_WARNING];
    const texts = await recognizeSafely(
      canvas,
      session,
      (message, amount) => onProgress(message, 0.05 + amount * 0.8),
      warnings,
    );
    onProgress("Separating graphics and text", 0.9);
    const page = await assemblePage(
      canvas,
      texts,
      file.name.replace(/\.[^.]+$/, "") || "Pasted image",
      warnings,
    );
    onProgress("Ready", 1);
    return [page];
  } finally {
    await session.close();
  }
}
