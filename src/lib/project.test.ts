import { describe, expect, it } from "vitest";
import { safeFileName, validateProject, type GraphicProject } from "./project";

function project(): GraphicProject {
  return {
    version: 1,
    name: "My design",
    activePageId: "page-1",
    pages: [
      {
        id: "page-1",
        name: "Page 1",
        width: 1200,
        height: 675,
        json: {
          version: "7.4.0",
          objects: [{ type: "Rect", width: 100, height: 100, fill: "#ffffff" }],
        },
      },
    ],
  };
}

describe("project import validation", () => {
  it("preserves small imported images without breaking project saves", () => {
    const small = project();
    small.pages[0].width = 24;
    small.pages[0].height = 24;
    expect(validateProject(small).pages[0].width).toBe(24);
  });
  it("accepts and clones an editable project", () => {
    const original = project();
    const result = validateProject(original);
    expect(result).toEqual(original);
    expect(result.pages[0].json).not.toBe(original.pages[0].json);
  });

  it("accepts Fabric optional fields before JSON.stringify removes undefined", () => {
    const value = project();
    value.pages[0].json.objects = [
      { type: "Textbox", text: "Editable text", path: undefined },
    ];
    expect(validateProject(value).pages[0].json.objects).toEqual(
      value.pages[0].json.objects,
    );
  });

  it("accepts the Fabric group layout manager", () => {
    const value = project();
    value.pages[0].json.objects = [
      {
        type: "Group",
        objects: [{ type: "Rect", width: 100, height: 80 }],
        layoutManager: { type: "layoutManager", strategy: "fit-content" },
      },
    ];
    expect(validateProject(value).pages).toHaveLength(1);
  });

  it("bounds dimensions after nested group scaling", () => {
    const value = project();
    value.pages[0].json.objects = [
      {
        type: "Group",
        scaleX: 100,
        scaleY: 100,
        objects: [
          { type: "Rect", width: 1000, height: 1000, scaleX: 100, scaleY: 100 },
        ],
      },
    ];
    expect(() => validateProject(value)).toThrow(/dimensions/);
  });

  it("refuses external images even when nested inside a group", () => {
    const value = project();
    value.pages[0].json.objects = [
      {
        type: "Group",
        objects: [{ type: "Image", src: "https://example.com/private.png" }],
      },
    ];
    expect(() => validateProject(value)).toThrow(/embedded/);
  });

  it("refuses SVG images which could reference remote assets", () => {
    const value = project();
    value.pages[0].json.objects = [
      { type: "Image", src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
    ];
    expect(() => validateProject(value)).toThrow(/embedded/);
  });

  it("accepts embedded raster images", () => {
    const value = project();
    value.pages[0].json.objects = [
      {
        type: "Image",
        src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
      },
    ];
    expect(validateProject(value).pages).toHaveLength(1);
  });

  it("refuses a non-raster payload disguised with an image MIME type", () => {
    const value = project();
    value.pages[0].json.objects = [
      { type: "Image", src: "data:image/png;base64,PHN2Zz48L3N2Zz4=" },
    ];
    expect(() => validateProject(value)).toThrow(/raster format/);
  });

  it("rejects prototype properties at every nesting depth", () => {
    const value = project();
    value.pages[0].json = JSON.parse(
      '{"objects":[],"data":{"__proto__":{"polluted":true}}}',
    ) as Record<string, unknown>;
    expect(() => validateProject(value)).toThrow(/unsafe/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects huge pages, duplicate IDs and absent active pages", () => {
    const oversized = project();
    oversized.pages[0].height = 90_000;
    expect(() => validateProject(oversized)).toThrow(/4000/);
    const duplicate = project();
    duplicate.pages.push(duplicate.pages[0]);
    expect(() => validateProject(duplicate)).toThrow(/unique/);
    const inactive = project();
    inactive.activePageId = "missing";
    expect(() => validateProject(inactive)).toThrow(/missing/);
  });

  it("refuses unsupported constructors and external paint servers", () => {
    const value = project();
    value.pages[0].json.objects = [{ type: "Anything" }];
    expect(() => validateProject(value)).toThrow(/unsupported/);
    value.pages[0].json.objects = [
      { type: "Rect", fill: "url(https://example.com/paint.svg)" },
    ];
    expect(() => validateProject(value)).toThrow(/paint/);
  });

  it("refuses excessively deep groups and nonfinite numbers", () => {
    const value = project();
    let group: unknown = { type: "Rect" };
    for (let index = 0; index < 40; index++)
      group = { type: "Group", objects: [group] };
    value.pages[0].json.objects = [group];
    expect(() => validateProject(value)).toThrow(/complex/);
    value.pages[0].json.objects = [{ type: "Rect", left: Number.NaN }];
    expect(() => validateProject(value)).toThrow(/number/);
  });
});

describe("download filenames", () => {
  it("removes filename control characters and keeps a meaningful fallback", () => {
    expect(safeFileName("Design: Q3/launch?")).toBe("Design- Q3-launch-");
    expect(safeFileName("...")).toBe("Untitled");
  });
});
