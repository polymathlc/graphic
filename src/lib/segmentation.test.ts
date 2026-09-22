import { describe, expect, it } from "vitest";
import {
  borderColor,
  clampRegion,
  findGraphicRegions,
  inkColor,
  mergeRegions,
  pageColor,
  type PixelBuffer,
  type Region,
} from "./segmentation";

function fixture(width = 120, height = 90): PixelBuffer {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  };
}

function paint(image: PixelBuffer, region: Region, color: number[]): void {
  const data = image.data as Uint8ClampedArray;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      data.set([...color, 255], (y * image.width + x) * 4);
    }
  }
}

describe("raster segmentation", () => {
  it("finds two disconnected graphics and keeps crop rectangles in the page", () => {
    const image = fixture();
    paint(image, { x: 0, y: 12, width: 22, height: 30 }, [30, 60, 130]);
    paint(image, { x: 70, y: 48, width: 25, height: 20 }, [190, 70, 20]);
    const regions = findGraphicRegions(image);
    expect(regions).toHaveLength(2);
    expect(
      regions.some(
        (region) =>
          region.x === 0 &&
          region.y <= 12 &&
          region.width >= 22 &&
          region.height >= 30,
      ),
    ).toBe(true);
    expect(
      regions.every(
        (region) =>
          region.x >= 0 &&
          region.y >= 0 &&
          region.x + region.width <= image.width &&
          region.y + region.height <= image.height,
      ),
    ).toBe(true);
  });

  it("does not invent graphic elements on a uniform background", () => {
    const image = fixture();
    expect(findGraphicRegions(image)).toEqual([]);
    expect(pageColor(image)).toEqual([255, 255, 255]);
  });

  it("samples outside a text box and estimates contrasting ink", () => {
    const image = fixture();
    const region = { x: 20, y: 20, width: 50, height: 20 };
    paint(image, region, [25, 30, 40]);
    expect(borderColor(image, region)).toEqual([255, 255, 255]);
    expect(inkColor(image, region, borderColor(image, region))).toEqual(
      "rgb(25, 30, 40)",
    );
  });

  it("merges transitively overlapping crop bounds to prevent duplicate artwork", () => {
    expect(
      mergeRegions([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 18, y: 0, width: 10, height: 10 },
        { x: 9, y: 0, width: 10, height: 10 },
      ]),
    ).toEqual([{ x: 0, y: 0, width: 28, height: 10 }]);
  });

  it("retains dense artwork as one movable image when the element limit is exceeded", () => {
    const image = fixture();
    paint(image, { x: 10, y: 10, width: 20, height: 20 }, [0, 0, 0]);
    paint(image, { x: 70, y: 50, width: 20, height: 20 }, [0, 0, 0]);
    expect(findGraphicRegions(image, 1)).toEqual([
      { x: 0, y: 0, width: 120, height: 90 },
    ]);
  });

  it("clamps off-page text masks without reversing their size", () => {
    expect(
      clampRegion({ x: -5, y: -4, width: 20, height: 14 }, 100, 80),
    ).toEqual({ x: 0, y: 0, width: 15, height: 10 });
    expect(
      clampRegion({ x: 105, y: 85, width: 20, height: 14 }, 100, 80),
    ).toEqual({ x: 100, y: 80, width: 0, height: 0 });
  });
});
