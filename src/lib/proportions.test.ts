import { describe, expect, it } from "vitest";
import { repairedScale, resizeProps, uniformScale } from "./proportions";

const box = { width: 200, height: 100, scaleX: 1, scaleY: 1 };

describe("distortion-free resizing", () => {
  it("scales images on both axes when only the width changes", () => {
    expect(resizeProps("image", box, "width", 400)).toEqual({
      scaleX: 2,
      scaleY: 2,
    });
  });

  it("scales images on both axes when only the height changes", () => {
    expect(resizeProps("image", box, "height", 50)).toEqual({
      scaleX: 0.5,
      scaleY: 0.5,
    });
  });

  it("reflows text on a width change instead of squeezing the letters", () => {
    expect(resizeProps("text", box, "width", 300)).toEqual({
      width: 300,
      scaleX: 1,
      scaleY: 1,
    });
    expect(
      resizeProps("text", { ...box, scaleX: 2, scaleY: 2 }, "width", 300),
    ).toEqual({ width: 150, scaleX: 2, scaleY: 2 });
  });

  it("scales text uniformly on a height change", () => {
    expect(resizeProps("text", box, "height", 150)).toEqual({
      scaleX: 1.5,
      scaleY: 1.5,
    });
  });

  it("still lets shapes change their aspect ratio", () => {
    expect(resizeProps("shape", box, "width", 50)).toEqual({ scaleX: 0.25 });
    expect(resizeProps("shape", box, "height", 50)).toEqual({ scaleY: 0.5 });
  });

  it("ignores invalid input rather than producing zero or infinite scale", () => {
    const props = resizeProps(
      "image",
      { ...box, width: 0 },
      "width",
      Number.NaN,
    );
    for (const value of Object.values(props)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("repairs stretched scales to a uniform one and leaves uniform ones alone", () => {
    expect(repairedScale({ ...box, scaleX: 4, scaleY: 1 })).toEqual({
      scaleX: 2,
      scaleY: 2,
    });
    expect(repairedScale({ ...box, scaleX: -4, scaleY: 1 })).toEqual({
      scaleX: -2,
      scaleY: 2,
    });
    expect(repairedScale({ ...box, scaleX: 1.5, scaleY: 1.5 })).toBeNull();
    expect(uniformScale({ ...box, scaleX: 0.5, scaleY: 3 })).toBe(3);
  });
});
