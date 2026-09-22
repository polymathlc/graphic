export interface ProjectPage {
  id: string;
  name: string;
  width: number;
  height: number;
  json: Record<string, unknown>;
}

export interface GraphicProject {
  version: 1;
  name: string;
  pages: ProjectPage[];
  activePageId: string;
}

const MAX_FILE_BYTES = 80 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = 45 * 1024 * 1024;
const MAX_OBJECTS = 10_000;
const DB_NAME = "graphic-studio";
const STORE_NAME = "drafts";
const DRAFT_KEY = "current";
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const OBJECT_TYPES = new Set([
  "rect",
  "circle",
  "ellipse",
  "triangle",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "itext",
  "i-text",
  "textbox",
  "image",
  "group",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringField(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} must be text between 1 and ${max} characters.`);
  }
  return value;
}

function dimension(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > 4000
  ) {
    throw new Error(`${label} must be between 1 and 4000 pixels.`);
  }
  return value;
}

function validateImageSource(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > MAX_DATA_URL_LENGTH ||
    !/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      value,
    )
  ) {
    throw new Error(
      "Project images must be embedded PNG, JPEG, WebP, or GIF files. External image links are not supported.",
    );
  }
  const separator = value.indexOf(",");
  const format = value.slice(11, value.indexOf(";"));
  const prefix = atob(value.slice(separator + 1, separator + 25));
  const validSignature =
    format === "png"
      ? prefix.startsWith("\x89PNG\r\n\x1a\n")
      : format === "jpeg" || format === "jpg"
        ? prefix.startsWith("\xff\xd8\xff")
        : format === "gif"
          ? /^GIF8[79]a/.test(prefix)
          : prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
  if (!validSignature)
    throw new Error(
      "An embedded image does not match its declared raster format.",
    );
}

/** Validate every node before Fabric deserializes it. Never load arbitrary URLs. */
function validateTree(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 30 || ++budget.nodes > 250_000)
    throw new Error("This project is too complex to open safely.");
  // Fabric's in-memory serialization uses undefined for optional fields such as text.path.
  if (value === null || value === undefined || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 10_000_000)
      throw new Error("The project contains an invalid number.");
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_DATA_URL_LENGTH)
      throw new Error("An embedded image or text value is too large.");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50_000)
      throw new Error("The project contains an oversized array.");
    value.forEach((item) => validateTree(item, depth + 1, budget));
    return;
  }
  if (!isRecord(value))
    throw new Error("The project contains an unsupported value.");
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key))
      throw new Error("The project contains an unsafe property.");
    if (
      key === "type" &&
      (typeof item !== "string" ||
        (!OBJECT_TYPES.has(item.toLowerCase()) &&
          !["linear", "radial", "pattern", "shadow", "layoutmanager"].includes(
            item.toLowerCase(),
          )))
    ) {
      throw new Error("The project contains an unsupported element type.");
    }
    if (
      key === "strategy" &&
      !["fit-content", "fixed", "clip-path"].includes(String(item))
    ) {
      throw new Error("The project contains an unsupported group layout.");
    }
    if (key === "text" && (typeof item !== "string" || item.length > 100_000)) {
      throw new Error(
        "Text elements must contain no more than 100,000 characters.",
      );
    }
    if (["src", "source", "url", "href"].includes(key))
      validateImageSource(item);
    if (
      ["fill", "stroke", "background", "backgroundColor", "color"].includes(
        key,
      ) &&
      typeof item === "string" &&
      /url\s*\(/i.test(item)
    ) {
      throw new Error("External paint references are not supported.");
    }
    if (key === "filters" && (!Array.isArray(item) || item.length !== 0)) {
      throw new Error(
        "Image filters in imported project files are not supported.",
      );
    }
    validateTree(item, depth + 1, budget);
  }
}

function validateObject(
  value: unknown,
  count: { value: number },
  depth = 0,
  parentScale = 1,
): void {
  if (depth > 20 || ++count.value > MAX_OBJECTS || !isRecord(value)) {
    throw new Error(
      "The project contains too many elements or invalid groups.",
    );
  }
  if (
    typeof value.type !== "string" ||
    !OBJECT_TYPES.has(value.type.toLowerCase())
  ) {
    throw new Error("The project contains an unsupported element type.");
  }
  if (value.type.toLowerCase() === "image") validateImageSource(value.src);
  const scaleX = value.scaleX ?? 1;
  const scaleY = value.scaleY ?? 1;
  if (
    typeof scaleX !== "number" ||
    typeof scaleY !== "number" ||
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY)
  ) {
    throw new Error("An element has an unsupported scale.");
  }
  const scale = parentScale * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  for (const key of ["radius", "rx", "ry", "fontSize"]) {
    const size = value[key];
    if (
      size !== undefined &&
      (typeof size !== "number" || size < 0 || size * scale > 16384)
    ) {
      throw new Error("An element has invalid dimensions.");
    }
  }
  for (const key of ["skewX", "skewY"]) {
    const skew = value[key];
    if (
      skew !== undefined &&
      (typeof skew !== "number" || Math.abs(skew) >= 89)
    ) {
      throw new Error("An element has an unsupported skew.");
    }
  }
  for (const key of ["width", "height"]) {
    const size = value[key];
    if (
      size !== undefined &&
      (typeof size !== "number" ||
        size < 0 ||
        size > 32768 ||
        size * scale > 32768)
    ) {
      throw new Error("An element has invalid dimensions.");
    }
  }
  if (value.objects !== undefined) {
    if (!Array.isArray(value.objects))
      throw new Error("A group must contain an array of elements.");
    value.objects.forEach((child) =>
      validateObject(child, count, depth + 1, scale),
    );
  }
  if (value.clipPath !== undefined && value.clipPath !== null)
    validateObject(value.clipPath, count, depth + 1, scale);
}

export function validateProject(value: unknown): GraphicProject {
  if (!isRecord(value) || value.version !== 1)
    throw new Error("This is not a supported Graphic project (version 1).");
  validateTree(value);
  const name = stringField(value.name, "Project name");
  if (
    !Array.isArray(value.pages) ||
    value.pages.length < 1 ||
    value.pages.length > 40
  ) {
    throw new Error("Projects must contain between 1 and 40 pages.");
  }
  const ids = new Set<string>();
  const count = { value: 0 };
  const pages = value.pages.map((page): ProjectPage => {
    if (!isRecord(page))
      throw new Error("The project contains an invalid page.");
    const id = stringField(page.id, "Page ID", 100);
    if (ids.has(id)) throw new Error("Every page must have a unique ID.");
    ids.add(id);
    const width = dimension(page.width, "Page width");
    const height = dimension(page.height, "Page height");
    if (width * height > 24_000_000)
      throw new Error("A page is too large (maximum 24 million pixels).");
    if (
      !isRecord(page.json) ||
      !Array.isArray(page.json.objects) ||
      page.json.objects.length > 2000
    ) {
      throw new Error(
        "Each page must contain a valid canvas with no more than 2,000 elements.",
      );
    }
    page.json.objects.forEach((object) => validateObject(object, count));
    for (const key of ["backgroundImage", "overlayImage", "clipPath"]) {
      if (page.json[key] !== undefined && page.json[key] !== null)
        validateObject(page.json[key], count);
    }
    return {
      id,
      name: stringField(page.name, "Page name"),
      width,
      height,
      json: page.json,
    };
  });
  const activePageId = stringField(value.activePageId, "Active page ID", 100);
  if (!ids.has(activePageId))
    throw new Error("The active page is missing from this project.");
  // Clone only after validation so callers cannot accidentally mutate persisted input.
  return structuredClone({ version: 1, name, pages, activePageId });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new Error(
          "Local storage is unavailable in this browser. Download a project file to save your work.",
        ),
      );
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () =>
      reject(
        new Error(
          "Could not open local draft storage. Download a project file to save your work.",
          { cause: request.error },
        ),
      );
    request.onblocked = () =>
      reject(
        new Error(
          "Local draft storage is blocked. Close other Graphic tabs and retry.",
        ),
      );
  });
}

export async function saveDraft(project: GraphicProject): Promise<void> {
  const checked = validateProject(project);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(checked, DRAFT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(
          new Error(
            "The draft could not be saved. Browser storage may be full; download a project file.",
            { cause: transaction.error },
          ),
        );
    });
  } finally {
    database.close();
  }
}

export async function loadDraft(): Promise<GraphicProject | null> {
  const database = await openDatabase();
  try {
    const stored = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(DRAFT_KEY);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () =>
        reject(
          new Error("The local draft could not be read.", {
            cause: transaction.error,
          }),
        );
    });
    return stored === undefined ? null : validateProject(stored);
  } finally {
    database.close();
  }
}

export function safeFileName(name: string): string {
  return (
    name
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
      .replace(/[. ]+$/, "")
      .slice(0, 100) || "Untitled"
  );
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give browsers time to begin reading the download before revoking the URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadProject(project: GraphicProject): void {
  const json = JSON.stringify(validateProject(project));
  if (json.length > MAX_FILE_BYTES)
    throw new Error(
      "This project exceeds the 80 MB file limit. Split it into smaller projects.",
    );
  downloadBlob(
    new Blob([json], { type: "application/json" }),
    `${safeFileName(project.name)}.graphic.json`,
  );
}

export async function readProject(file: File): Promise<GraphicProject> {
  if (file.size > MAX_FILE_BYTES)
    throw new Error("Project files must be smaller than 80 MB.");
  let value: unknown;
  try {
    value = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error(
      "This file is not valid JSON. Choose a .graphic.json project file.",
    );
  }
  return validateProject(value);
}
