import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface SavedObject {
  type: string;
  text?: string;
  src?: string;
  name?: string;
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX?: number;
  scaleY?: number;
  angle?: number;
  selectable?: boolean;
  lockMovementX?: boolean;
  lockMovementY?: boolean;
}

interface SavedPage {
  width: number;
  height: number;
  json: { objects: SavedObject[] };
}

interface SavedProject {
  pages: SavedPage[];
}

type PixelRegion = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
const PROTECTED_REGIONS: PixelRegion[] = [
  {
    name: "subtle rounded card and its text",
    x: 66,
    y: 256,
    width: 508,
    height: 308,
  },
  {
    name: "small button and its label",
    x: 646,
    y: 281,
    width: 158,
    height: 56,
  },
  {
    name: "folder outline beside the download text",
    x: 646,
    y: 401,
    width: 50,
    height: 45,
  },
  {
    name: "colored artwork and embedded text",
    x: 646,
    y: 556,
    width: 438,
    height: 228,
  },
];

test.setTimeout(180_000);

/** Synthetic UI/artwork fixture; no user's document or attachment is saved in the repository. */
async function designFixture(
  page: Page,
  format = "image/png",
): Promise<Buffer> {
  const base64 = await page.evaluate((mimeType) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1000;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#202124";
    context.font = "bold 64px Arial";
    context.fillText("BODY CONTENT", 70, 108);
    context.font = "28px Arial";
    context.fillText("This paragraph should remain editable.", 70, 173);

    // A low-contrast enclosing UI card must protect all the text inside it.
    context.fillStyle = "#fafafa";
    context.strokeStyle = "#e5e7eb";
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(70, 260, 500, 300, 24);
    context.fill();
    context.stroke();
    context.fillStyle = "#4b5563";
    context.font = "25px Arial";
    context.fillText("Web preview", 102, 314);
    context.fillStyle = "#202124";
    context.font = "bold 40px Arial";
    context.fillText("Website", 102, 388);

    context.fillStyle = "#f8f9fa";
    context.strokeStyle = "#d8dade";
    context.beginPath();
    context.roundRect(650, 285, 150, 48, 9);
    context.fill();
    context.stroke();
    context.fillStyle = "#292d35";
    context.font = "22px Arial";
    context.fillText("Open in", 686, 317);

    // Folder outlines can otherwise be misread as punctuation/letters and erased.
    context.strokeStyle = "#596474";
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(651, 439);
    context.lineTo(651, 407);
    context.lineTo(669, 407);
    context.lineTo(676, 415);
    context.lineTo(689, 415);
    context.lineTo(689, 439);
    context.closePath();
    context.stroke();
    context.beginPath();
    context.moveTo(651, 418);
    context.lineTo(689, 418);
    context.stroke();
    context.fillStyle = "#202124";
    context.font = "28px Arial";
    context.fillText("Download source", 716, 438);

    // Text integrated into a colored illustration should remain in that artwork.
    const gradient = context.createLinearGradient(650, 560, 1080, 780);
    gradient.addColorStop(0, "#6652d9");
    gradient.addColorStop(1, "#c44583");
    context.fillStyle = gradient;
    context.fillRect(650, 560, 430, 220);
    context.fillStyle = "#eeb954";
    context.beginPath();
    context.arc(1010, 614, 42, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "bold 42px Arial";
    context.fillText("CREATIVE", 686, 694);
    return canvas.toDataURL(mimeType, 0.97).split(",")[1];
  }, format);
  return Buffer.from(base64, "base64");
}

async function savedProject(page: Page): Promise<SavedProject> {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await pending;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("The project download contained no data.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as SavedProject;
}

async function start(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByLabel("Text conversion mode")).toHaveValue(
    "conservative",
  );
  await expect(page.locator("canvas.lower-canvas")).not.toHaveAttribute(
    "width",
    "300",
  );
}

async function importComplete(page: Page, pageCount: number): Promise<void> {
  await expect(page.locator(".page-card")).toHaveCount(pageCount, {
    timeout: 140_000,
  });
  await expect(page.locator(".layer-row").first()).toBeVisible({
    timeout: 140_000,
  });
  await expect(page.locator(".progress-overlay")).toHaveCount(0, {
    timeout: 140_000,
  });
}

async function pasteImage(page: Page, png: Buffer): Promise<void> {
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File([bytes], "pasted-design.png", { type: "image/png" }),
    );
    document.body.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, png.toString("base64"));
}

/** Compare actual raster pixels, rather than accepting a layer-count-only conversion. */
async function rasterDifferences(
  page: Page,
  original: Buffer,
  saved: SavedPage,
  regions: PixelRegion[],
) {
  return page.evaluate(
    async ({ originalBase64, savedPage, areas }) => {
      const sourceImage = new Image();
      sourceImage.src = `data:image/png;base64,${originalBase64}`;
      await sourceImage.decode();
      const originalCanvas = document.createElement("canvas");
      originalCanvas.width = savedPage.width;
      originalCanvas.height = savedPage.height;
      const originalContext = originalCanvas.getContext("2d")!;
      originalContext.drawImage(
        sourceImage,
        0,
        0,
        savedPage.width,
        savedPage.height,
      );

      const rebuilt = document.createElement("canvas");
      rebuilt.width = savedPage.width;
      rebuilt.height = savedPage.height;
      const rebuiltContext = rebuilt.getContext("2d")!;
      rebuiltContext.fillStyle = "#ffffff";
      rebuiltContext.fillRect(0, 0, savedPage.width, savedPage.height);
      for (const object of savedPage.json.objects) {
        if (object.type.toLowerCase() !== "image") continue;
        const image = new Image();
        image.src = object.src!;
        await image.decode();
        rebuiltContext.save();
        rebuiltContext.translate(object.left, object.top);
        rebuiltContext.rotate(((object.angle ?? 0) * Math.PI) / 180);
        rebuiltContext.drawImage(
          image,
          0,
          0,
          object.width * (object.scaleX ?? 1),
          object.height * (object.scaleY ?? 1),
        );
        rebuiltContext.restore();
      }
      return areas.map((region) => {
        const originalPixels = originalContext.getImageData(
          region.x,
          region.y,
          region.width,
          region.height,
        ).data;
        const rebuiltPixels = rebuiltContext.getImageData(
          region.x,
          region.y,
          region.width,
          region.height,
        ).data;
        let changedPixels = 0;
        for (let offset = 0; offset < originalPixels.length; offset += 4) {
          if (
            originalPixels[offset] !== rebuiltPixels[offset] ||
            originalPixels[offset + 1] !== rebuiltPixels[offset + 1] ||
            originalPixels[offset + 2] !== rebuiltPixels[offset + 2] ||
            originalPixels[offset + 3] !== rebuiltPixels[offset + 3]
          )
            changedPixels++;
        }
        return { name: region.name, changedPixels };
      });
    },
    {
      originalBase64: original.toString("base64"),
      savedPage: saved,
      areas: regions,
    },
  );
}

async function forbidOCR(context: BrowserContext): Promise<string[]> {
  const attempts: string[] = [];
  // Catch both dynamic engine imports and requests made from the OCR worker.
  await context.route(
    /tesseract|traineddata|worker\.min\.js(?:\?|$)/i,
    async (route) => {
      attempts.push(route.request().url());
      await route.abort();
    },
  );
  return attempts;
}

function streamObject(content: Buffer, dictionary = ""): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("\nendstream"),
  ]);
}

/** Minimal standards-compliant PDF fixtures with accurate byte offsets. */
function makePDF(objects: Buffer[]): Buffer {
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets: number[] = [];
  let size = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(object);
    size += object.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

function nativePDF(): Buffer {
  return makePDF([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    ),
    streamObject(
      Buffer.from(
        "BT /F1 36 Tf 1 0 0 1 55 300 Tm (NATIVE PDF PAGE ONE) Tj ET\n0.4 0.3 0.8 rg 70 100 200 110 re f",
      ),
    ),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>",
    ),
    streamObject(
      Buffer.from(
        "BT /F1 36 Tf 1 0 0 1 55 300 Tm (NATIVE PDF PAGE TWO) Tj ET\n0.8 0.3 0.4 rg 320 70 190 100 re f",
      ),
    ),
  ]);
}

function scannedPDF(jpeg: Buffer): Buffer {
  return makePDF([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 1000] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    ),
    streamObject(Buffer.from("q 1200 0 0 1000 0 0 cm /Im0 Do Q")),
    streamObject(
      jpeg,
      "/Type /XObject /Subtype /Image /Width 1200 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
    ),
  ]);
}

function expectOriginalImage(saved: SavedPage): void {
  expect(saved.json.objects).toHaveLength(1);
  const object = saved.json.objects[0];
  expect(object.type.toLowerCase()).toBe("image");
  expect(object.text).toBeUndefined();
  expect(object.selectable).not.toBe(false);
  expect(object.lockMovementX).not.toBe(true);
  expect(object.lockMovementY).not.toBe(true);
  expect(object.left).toBe(0);
  expect(object.top).toBe(0);
  expect(object.width * (object.scaleX ?? 1)).toBe(saved.width);
  expect(object.height * (object.scaleY ?? 1)).toBe(saved.height);
  expect(object.src).toMatch(/^data:image\/png;base64,/);
}

test("conservative conversion edits ordinary text while preserving UI labels, icons, and artwork pixels", async ({
  page,
}) => {
  await start(page);
  const png = await designFixture(page);
  await page.getByLabel("Import images or PDFs").setInputFiles({
    name: "synthetic-design.png",
    mimeType: "image/png",
    buffer: png,
  });
  await importComplete(page, 1);
  const saved = (await savedProject(page)).pages[0];
  const text = saved.json.objects
    .filter((object) => typeof object.text === "string")
    .map((object) => object.text!)
    .join(" ");
  expect(text).toContain("BODY CONTENT");
  expect(text.toLowerCase()).toContain("paragraph");
  expect(text).not.toMatch(/web\s*preview|website|open\s*in|creative/i);
  expect(saved.width).toBe(1200);
  expect(saved.height).toBe(1000);
  const differences = await rasterDifferences(
    page,
    png,
    saved,
    PROTECTED_REGIONS,
  );
  for (const region of differences)
    expect(region.changedPixels, region.name).toBe(0);
  // Verify ordinary extracted text was actually removed from the underlying raster.
  const [heading] = await rasterDifferences(page, png, saved, [
    { name: "body heading", x: 65, y: 45, width: 555, height: 75 },
  ]);
  expect(heading.changedPixels).toBeGreaterThan(1000);
});

test("Images only preserves uploaded and pasted images exactly without loading OCR", async ({
  page,
  context,
}) => {
  const ocrRequests = await forbidOCR(context);
  await start(page);
  await page.getByLabel("Text conversion mode").selectOption("image-only");
  await expect(page.getByLabel("Text recognition language")).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Text conversion mode")).toHaveValue(
    "image-only",
  );
  await expect(page.getByLabel("Text recognition language")).toBeDisabled();
  await expect(page.locator("canvas.lower-canvas")).not.toHaveAttribute(
    "width",
    "300",
  );
  const png = await designFixture(page);
  await page.getByLabel("Import images or PDFs").setInputFiles({
    name: "unchanged.png",
    mimeType: "image/png",
    buffer: png,
  });
  await importComplete(page, 1);
  await pasteImage(page, png);
  await importComplete(page, 2);
  const project = await savedProject(page);
  expect(project.pages).toHaveLength(2);
  for (const saved of project.pages) {
    expectOriginalImage(saved);
    const [difference] = await rasterDifferences(page, png, saved, [
      { name: "entire source", x: 0, y: 0, width: 1200, height: 1000 },
    ]);
    expect(difference.changedPixels).toBe(0);
  }
  expect(ocrRequests).toEqual([]);
  await page.getByLabel("Text conversion mode").selectOption("conservative");
  await expect(page.getByLabel("Text recognition language")).toBeEnabled();
});

test("Images only keeps native and scanned PDF pages as single movable pictures with zero OCR requests", async ({
  page,
  context,
}) => {
  const ocrRequests = await forbidOCR(context);
  await start(page);
  await page.getByLabel("Text conversion mode").selectOption("image-only");
  const jpeg = await designFixture(page, "image/jpeg");
  await page.getByLabel("Import images or PDFs").setInputFiles([
    { name: "native.pdf", mimeType: "application/pdf", buffer: nativePDF() },
    { name: "scan.pdf", mimeType: "application/pdf", buffer: scannedPDF(jpeg) },
  ]);
  await importComplete(page, 3);
  const project = await savedProject(page);
  expect(project.pages).toHaveLength(3);
  project.pages.forEach(expectOriginalImage);
  expect(project.pages[0].width).toBe(1200);
  expect(project.pages[0].height).toBe(800);
  expect(project.pages[1].width).toBe(1200);
  expect(project.pages[1].height).toBe(800);
  expect(
    Math.max(project.pages[2].width, project.pages[2].height),
  ).toBeLessThanOrEqual(1800);
  expect(ocrRequests).toEqual([]);
  // The retained whole-page image remains editable through the normal transform controls.
  await page.locator(".layer-select").click();
  await page.getByLabel("Rotation", { exact: true }).fill("18");
  const edited = await savedProject(page);
  expect(edited.pages[0].json.objects[0].angle).toBe(18);
});
