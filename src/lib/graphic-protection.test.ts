import { describe, expect, it } from "vitest";
import {
  findProtectedGraphics,
  isInsideProtectedGraphic,
  isPlainTextBackground,
} from "./graphic-protection";
import type { PixelBuffer, Region } from "./segmentation";

function fixture(
  width = 320,
  height = 160,
  color = [255, 255, 255],
): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...color, 255], i);
  return { width, height, data };
}

function paint(image: PixelBuffer, region: Region, color: number[]): void {
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      (image.data as Uint8ClampedArray).set(
        [...color, 255],
        (y * image.width + x) * 4,
      );
    }
  }
}

function outline(
  image: PixelBuffer,
  box: Region,
  color = [239, 239, 241],
  radius = 0,
): void {
  const { x, y, width, height } = box;
  for (let yy = y; yy < y + height; yy++) {
    for (let xx = x; xx < x + width; xx++) {
      const cx = Math.max(x + radius, Math.min(x + width - radius - 1, xx));
      const cy = Math.max(y + radius, Math.min(y + height - radius - 1, yy));
      const d = Math.hypot(xx - cx, yy - cy);
      if (
        radius
          ? d >= radius - 1 && d <= radius
          : xx === x ||
            yy === y ||
            xx === x + width - 1 ||
            yy === y + height - 1
      ) {
        paint(image, { x: xx, y: yy, width: 1, height: 1 }, color);
      }
    }
  }
}

function word(
  image: PixelBuffer,
  x: number,
  y: number,
  color = [30, 30, 30],
): Region {
  // Separated H-shaped strokes, including full ascender/descender extents.
  for (let i = 0; i < 5; i++) {
    paint(image, { x: x + i * 12, y, width: 2, height: 15 }, color);
    paint(image, { x: x + i * 12 + 7, y, width: 2, height: 15 }, color);
    paint(image, { x: x + i * 12, y: y + 6, width: 9, height: 2 }, color);
  }
  return { x, y, width: 57, height: 15 };
}

describe("graphic text protection", () => {
  it("protects text inside faint rounded cards and nested buttons without swallowing outside text", () => {
    const image = fixture();
    const outside = word(image, 20, 20);
    outline(
      image,
      { x: 11, y: 85, width: 294, height: 64 },
      [240, 240, 242],
      10,
    );
    const inside = word(image, 42, 105);
    outline(
      image,
      { x: 205, y: 102, width: 83, height: 29 },
      [233, 233, 235],
      7,
    );
    const nested = word(image, 215, 109);
    const regions = findProtectedGraphics(image);
    expect(isInsideProtectedGraphic(inside, regions)).toBe(true);
    expect(isInsideProtectedGraphic(nested, regions)).toBe(true);
    expect(isInsideProtectedGraphic(outside, regions)).toBe(false);
    expect(
      regions.every((r) => r.width < image.width || r.height < image.height),
    ).toBe(true);
  });

  it("retains colored filled graphics and rejects their text background", () => {
    const image = fixture();
    paint(image, { x: 40, y: 35, width: 190, height: 75 }, [85, 110, 188]);
    const inside = word(image, 60, 50, [255, 255, 255]);
    expect(isInsideProtectedGraphic(inside, findProtectedGraphics(image))).toBe(
      true,
    );
    expect(isPlainTextBackground(image, inside)).toBe(false);
  });

  it("joins faint antialiased rounded corners to their stronger straight borders", () => {
    const image = fixture(430, 190);
    const card = { x: 17, y: 87, width: 391, height: 79 };
    outline(image, card, [250, 250, 250], 12);
    paint(
      image,
      { x: card.x + 12, y: card.y, width: card.width - 24, height: 1 },
      [242, 242, 242],
    );
    paint(
      image,
      {
        x: card.x + 12,
        y: card.y + card.height - 1,
        width: card.width - 24,
        height: 1,
      },
      [242, 242, 242],
    );
    paint(
      image,
      { x: card.x, y: card.y + 12, width: 1, height: card.height - 24 },
      [242, 242, 242],
    );
    paint(
      image,
      {
        x: card.x + card.width - 1,
        y: card.y + 12,
        width: 1,
        height: card.height - 24,
      },
      [242, 242, 242],
    );
    const regions = findProtectedGraphics(image);
    expect(isInsideProtectedGraphic(word(image, 44, 108), regions)).toBe(true);
    expect(
      regions.some(
        (r) =>
          r.x <= card.x &&
          r.y <= card.y &&
          r.width >= card.width &&
          r.height >= card.height,
      ),
    ).toBe(true);
    expect(isInsideProtectedGraphic(word(image, 25, 25), regions)).toBe(false);
  });

  it("allows ordinary black and blue standalone text, including a nearby underline", () => {
    const image = fixture();
    const black = word(image, 25, 25);
    const blue = word(image, 25, 65, [45, 80, 170]);
    paint(image, { x: 25, y: 81, width: 57, height: 1 }, [45, 80, 170]);
    expect(findProtectedGraphics(image)).toEqual([]);
    expect(isPlainTextBackground(image, black)).toBe(true);
    expect(isPlainTextBackground(image, blue)).toBe(true);
  });

  it("does not call a page frame or individual outlined glyphs a protected graphic", () => {
    const image = fixture();
    outline(image, { x: 0, y: 0, width: 320, height: 160 }, [220, 220, 220]);
    outline(image, { x: 25, y: 30, width: 12, height: 18 }, [30, 30, 30]);
    expect(findProtectedGraphics(image)).toEqual([]);
  });

  it("rejects textured interiors even when a tight crop has white edges", () => {
    const image = fixture();
    const region = { x: 30, y: 40, width: 100, height: 40 };
    for (let y = region.y; y < region.y + region.height; y++) {
      for (let x = region.x; x < region.x + region.width; x++) {
        paint(image, { x, y, width: 1, height: 1 }, [
          (x * 31 + y * 13) % 256,
          (x * 7 + y * 43) % 256,
          (x * 19 + y * 3) % 256,
        ]);
      }
    }
    expect(isPlainTextBackground(image, region)).toBe(false);
  });

  it("preserves one-pixel borders when an image requires the bounded grid", () => {
    const image = fixture(2200, 110);
    outline(image, { x: 301, y: 21, width: 1601, height: 61 });
    expect(
      isInsideProtectedGraphic(
        { x: 400, y: 35, width: 80, height: 20 },
        findProtectedGraphics(image),
      ),
    ).toBe(true);
  });

  it("ignores a small incidental overlap and handles empty bounds", () => {
    const boxes = [{ x: 100, y: 100, width: 100, height: 60 }];
    expect(
      isInsideProtectedGraphic({ x: 70, y: 90, width: 40, height: 20 }, boxes),
    ).toBe(false);
    expect(
      isInsideProtectedGraphic({ x: 110, y: 110, width: 0, height: 10 }, boxes),
    ).toBe(false);
    expect(findProtectedGraphics(fixture(0, 0))).toEqual([]);
    expect(
      isPlainTextBackground(fixture(), { x: 20, y: 20, width: 0, height: 5 }),
    ).toBe(false);
  });
});
