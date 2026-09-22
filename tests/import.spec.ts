import { expect, test, type Page } from "@playwright/test";

interface SavedObject {
  type: string;
  text?: string;
  name?: string;
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  angle: number;
  selectable?: boolean;
  src?: string;
}
interface SavedProject {
  pages: Array<{
    width: number;
    height: number;
    json: { objects: SavedObject[] };
  }>;
}

test.setTimeout(180_000);

async function imageFixture(
  page: Page,
  text = "HELLO WORLD",
  format = "image/png",
): Promise<Buffer> {
  const data = await page.evaluate(
    ({ text, format }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1000;
      canvas.height = 650;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#171717";
      context.font = "bold 68px Arial";
      context.fillText(text, 85, 145);
      context.fillStyle = "#6555df";
      context.fillRect(90, 285, 190, 150);
      context.fillStyle = "#e89574";
      context.beginPath();
      context.arc(710, 380, 75, 0, Math.PI * 2);
      context.fill();
      return canvas.toDataURL(format, 0.95).split(",")[1];
    },
    { text, format },
  );
  return Buffer.from(data, "base64");
}

/** A tiny standards-compliant fixture PDF, with exact byte offsets and no PDF-writing dependency. */
function makePDF(objects: Buffer[]): Buffer {
  const buffers = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let length = buffers[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    buffers.push(object);
    length += object.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  buffers.push(Buffer.from(xref));
  return Buffer.concat(buffers);
}

function streamObject(content: Buffer, dictionary = ""): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("\nendstream"),
  ]);
}

function nativePDF(pageCount = 2): Buffer {
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(
      `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  for (let index = 0; index < pageCount; index++) {
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      ),
    );
    objects.push(
      streamObject(
        Buffer.from(
          `BT /F1 40 Tf 1 0 0 1 60 290 Tm (EDITABLE PAGE ${index + 1}) Tj ET\n0.4 0.3 0.8 rg 70 80 130 100 re f\n0.9 0.6 0.4 rg 340 85 90 90 re f`,
        ),
      ),
    );
  }
  return makePDF(objects);
}

function scannedPDF(jpeg: Buffer): Buffer {
  return makePDF([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 650] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    ),
    streamObject(Buffer.from("q 1000 0 0 650 0 0 cm /Im0 Do Q")),
    streamObject(
      jpeg,
      "/Type /XObject /Subtype /Image /Width 1000 /Height 650 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
    ),
  ]);
}

async function savedProject(page: Page): Promise<SavedProject> {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await pending;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Project download had no data.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function waitForImport(page: Page, text: string): Promise<void> {
  await expect(
    page.locator(".layer-name").filter({ hasText: text }),
  ).toBeVisible({ timeout: 140_000 });
  await expect(page.locator(".progress-overlay")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /From static to/ }),
  ).toBeVisible();
  // The initial IndexedDB draft read completes before the canvas gets its fitted dimensions.
  await expect(page.locator("canvas.lower-canvas")).not.toHaveAttribute(
    "width",
    "300",
  );
});

test("real image OCR creates editable text and independent graphic crops", async ({
  page,
}) => {
  await page
    .getByLabel("Import images or PDFs")
    .setInputFiles({
      name: "poster.png",
      mimeType: "image/png",
      buffer: await imageFixture(page),
    });
  await waitForImport(page, "HELLO WORLD");
  await page
    .locator(".layer-select")
    .filter({ hasText: "HELLO WORLD" })
    .click();
  await expect(page.getByLabel("Text content")).toHaveValue("HELLO WORLD");
  await page.getByLabel("Text content").fill("EDITED TITLE");
  await page.getByLabel("Rotation", { exact: true }).fill("12");
  const project = await savedProject(page);
  const first = project.pages[0];
  expect(first.width).toBe(1000);
  expect(first.height).toBe(650);
  const text = first.json.objects.find(
    (object) => object.text === "EDITED TITLE",
  );
  expect(text).toBeDefined();
  expect(text!.left).toBeGreaterThan(70);
  expect(text!.left).toBeLessThan(110);
  expect(text!.top).toBeGreaterThan(50);
  expect(text!.top).toBeLessThan(150);
  expect(text!.width * text!.scaleX).toBeGreaterThan(350);
  expect(text!.angle).toBe(12);
  const graphics = first.json.objects.filter(
    (object) =>
      object.type.toLowerCase() === "image" && object.selectable !== false,
  );
  expect(graphics.length).toBeGreaterThanOrEqual(2);
  expect(
    graphics.every((object) => object.src?.startsWith("data:image/")),
  ).toBe(true);
});

test("native multi-page PDFs keep text, dimensions, and separate pages", async ({
  page,
}) => {
  await page
    .getByLabel("Import images or PDFs")
    .setInputFiles({
      name: "two-pages.pdf",
      mimeType: "application/pdf",
      buffer: nativePDF(),
    });
  await waitForImport(page, "EDITABLE PAGE 1");
  await expect(page.locator(".page-card")).toHaveCount(2);
  const project = await savedProject(page);
  expect(project.pages).toHaveLength(2);
  project.pages.forEach((savedPage, index) => {
    expect(savedPage.width).toBe(1200);
    expect(savedPage.height).toBe(800);
    const text = savedPage.json.objects.find(
      (object) => object.text === `EDITABLE PAGE ${index + 1}`,
    );
    expect(text).toBeDefined();
    expect(text!.left).toBeCloseTo(120, 0);
    expect(text!.top).toBeGreaterThan(120);
    expect(text!.top).toBeLessThan(230);
    expect(text!.width * text!.scaleX).toBeGreaterThan(400);
  });
  const darkPixelsBeneathText = await page.evaluate(async (objects) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 1200, 800);
    for (const object of objects.filter(
      (object) => object.type.toLowerCase() === "image",
    )) {
      const image = new Image();
      image.src = object.src!;
      await image.decode();
      context.drawImage(
        image,
        object.left,
        object.top,
        object.width * object.scaleX,
        object.height,
      );
    }
    const pixels = context.getImageData(100, 130, 980, 125).data;
    let dark = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (
        pixels[index] < 80 &&
        pixels[index + 1] < 80 &&
        pixels[index + 2] < 80
      )
        dark++;
    }
    return dark;
  }, project.pages[0].json.objects);
  // Editable text must not leave a second, baked-in copy beneath the new text box.
  expect(darkPixelsBeneathText).toBeLessThan(30);
  await page.locator(".page-card").nth(1).click();
  await expect(
    page.locator(".layer-name").filter({ hasText: "EDITABLE PAGE 2" }),
  ).toBeVisible();
});

test("scanned PDFs fall back to real OCR", async ({ page }) => {
  const jpeg = await imageFixture(page, "SCANNED PAGE", "image/jpeg");
  await page
    .getByLabel("Import images or PDFs")
    .setInputFiles({
      name: "scan.pdf",
      mimeType: "application/pdf",
      buffer: scannedPDF(jpeg),
    });
  await waitForImport(page, "SCANNED PAGE");
  const project = await savedProject(page);
  expect(
    project.pages[0].json.objects.some(
      (object) => object.text === "SCANNED PAGE",
    ),
  ).toBe(true);
  expect(
    Math.max(project.pages[0].width, project.pages[0].height),
  ).toBeLessThanOrEqual(1800);
});

test("pasted image files go through the same conversion flow", async ({
  page,
}) => {
  const png = await imageFixture(page, "PASTED NOTE");
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    document.body.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, png.toString("base64"));
  await waitForImport(page, "PASTED NOTE");
  expect(
    (await savedProject(page)).pages[0].json.objects.some(
      (object) => object.text === "PASTED NOTE",
    ),
  ).toBe(true);
});

test("invalid and oversized-page PDFs show clear errors without changing the project", async ({
  page,
}) => {
  await page
    .getByLabel("Import images or PDFs")
    .setInputFiles({
      name: "broken.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not a valid PDF document"),
    });
  await expect(page.getByRole("alert")).toContainText(
    "This PDF could not be read",
  );
  await expect(page.locator(".progress-overlay")).toHaveCount(0);
  await page
    .getByLabel("Import images or PDFs")
    .setInputFiles({
      name: "too-many.pdf",
      mimeType: "application/pdf",
      buffer: nativePDF(21),
    });
  await expect(page.getByRole("alert")).toContainText("20 pages or fewer");
  await expect(page.locator(".page-card")).toHaveCount(1);
  expect((await savedProject(page)).pages[0].json.objects).toHaveLength(0);
});
