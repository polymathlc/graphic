import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function start(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Saved on this device")).toBeAttached();
}
async function downloadedProject(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, "utf8"));
}

test("text edits, transforms, duplication, history, saved draft and project round-trip", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await page.getByLabel("Text content", { exact: true }).fill("A new idea");
  await page.getByLabel("Rotation", { exact: true }).fill("25");
  await page.getByLabel("Width", { exact: true }).fill("420");
  await page
    .getByRole("button", { name: "Duplicate element (Ctrl D)", exact: true })
    .click();
  await expect(page.locator(".layer-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Undo (Ctrl Z)", exact: true })
    .click();
  await expect(page.locator(".layer-row")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Redo (Ctrl Shift Z)", exact: true })
    .click();
  await expect(page.locator(".layer-row")).toHaveCount(2);
  await expect(page.getByText("Saved on this device")).toBeAttached();
  const project = await downloadedProject(page);
  expect(project.pages[0].json.objects[0].text).toBe("A new idea");
  expect(project.pages[0].json.objects[0].angle).toBe(25);
  expect(
    project.pages[0].json.objects[0].width *
      project.pages[0].json.objects[0].scaleX,
  ).toBeCloseTo(420, 0);
  await page.reload();
  await expect(page.locator(".layer-row")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Add blank page", exact: true })
    .click();
  await expect(page.locator(".page-card")).toHaveCount(2);
  await page.getByLabel("Open Graphic project", { exact: true }).setInputFiles({
    name: "roundtrip.graphic.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator(".page-card")).toHaveCount(1);
  await expect(page.locator(".layer-row")).toHaveCount(2);
});

test("image crop changes source rectangle and undo restores it", async ({
  page,
}) => {
  await start(page);
  const src = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 100;
    const x = c.getContext("2d")!;
    x.fillStyle = "red";
    x.fillRect(0, 0, 100, 100);
    x.fillStyle = "blue";
    x.fillRect(100, 0, 100, 100);
    return c.toDataURL();
  });
  const project = {
    version: 1,
    name: "Crop test",
    activePageId: "page",
    pages: [
      {
        id: "page",
        name: "Page",
        width: 960,
        height: 600,
        json: {
          objects: [
            {
              type: "Image",
              version: "7.4.0",
              src,
              left: 60,
              top: 70,
              width: 200,
              height: 100,
              scaleX: 1,
              scaleY: 1,
              originX: "left",
              originY: "top",
              cropX: 0,
              cropY: 0,
              name: "Test image",
            },
          ],
        },
      },
    ],
  };
  await page.getByLabel("Open Graphic project").setInputFiles({
    name: "crop.graphic.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.locator(".layer-select").click();
  await page.getByRole("button", { name: "Crop image", exact: true }).click();
  await page.getByLabel("Left %", { exact: true }).fill("25");
  await page.getByLabel("Bottom %", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Apply crop", exact: true }).click();
  let saved = await downloadedProject(page);
  expect(saved.pages[0].json.objects[0]).toMatchObject({
    width: 150,
    height: 90,
    cropX: 50,
    cropY: 0,
    left: 110,
    top: 70,
  });
  await page
    .getByRole("button", { name: "Undo (Ctrl Z)", exact: true })
    .click();
  saved = await downloadedProject(page);
  expect(saved.pages[0].json.objects[0]).toMatchObject({
    width: 200,
    height: 100,
    cropX: 0,
    cropY: 0,
  });
});

test("PNG/SVG downloads have logical dimensions and PowerPoint has editable text", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await page.getByLabel("Text content").fill("Editable export");
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  for (const format of ["PNG image", "SVG artwork", "PowerPoint"]) {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: new RegExp(`^${format}`) }).click();
    const download = await pending;
    const bytes = await readFile((await download.path())!);
    if (format === "PNG image") {
      expect(bytes.readUInt32BE(16)).toBe(960);
      expect(bytes.readUInt32BE(20)).toBe(600);
    }
    if (format === "SVG artwork") {
      expect(bytes.toString()).toContain('viewBox="0 0 960 600"');
      expect(bytes.toString()).toContain("Editable export");
    }
    if (format === "PowerPoint") {
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(bytes);
      const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
      expect(slide).toContain("<p:sp>");
      expect(slide).toContain("<a:t>Editable export</a:t>");
      expect(slide).toContain('prst="roundRect"');
    }
  }
});

test("page switching preserves changes and invalid project leaves composition intact", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Circle", exact: true }).click();
  await page
    .getByRole("button", { name: "Add blank page", exact: true })
    .click();
  await expect(page.locator(".layer-row")).toHaveCount(0);
  await page.locator(".page-card").first().click();
  await expect(page.locator(".layer-row")).toHaveCount(1);
  await page.getByLabel("Open Graphic project").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.getByRole("alert")).toContainText("not a supported");
  await expect(page.locator(".layer-row")).toHaveCount(1);
});

test("pointer dragging changes object position", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  const canvas = page.locator(".upper-canvas");
  const bounds = (await canvas.boundingBox())!;
  const scale = bounds.width / 960;
  await page.mouse.move(bounds.x + 350 * scale, bounds.y + 200 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 420 * scale, bounds.y + 240 * scale, {
    steps: 5,
  });
  await page.mouse.up();
  const p = await downloadedProject(page);
  expect(p.pages[0].json.objects[0].left).toBeGreaterThan(300);
});

test("layer locks persist through a project round-trip and can be unlocked", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  await page.getByRole("button", { name: "Lock layer", exact: true }).click();
  const p = await downloadedProject(page);
  expect(p.pages[0].json.objects[0].selectable).toBe(false);
  await page.getByLabel("Open Graphic project").setInputFiles({
    name: "locked.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(p)),
  });
  await expect(
    page.getByRole("button", { name: "Unlock layer", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unlock layer", exact: true }).click();
  await page.locator(".layer-select").click();
  await expect(page.getByLabel("Width", { exact: true })).toBeVisible();
  const updated = await downloadedProject(page);
  expect(updated.pages[0].json.objects[0].lockMovementX).toBe(false);
});
