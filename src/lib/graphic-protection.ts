import {
  clampRegion,
  pageColor,
  type PixelBuffer,
  type Region,
  type RGB,
} from "./segmentation";

const pageBackgrounds = new WeakMap<PixelBuffer, RGB>();

function backgroundOf(image: PixelBuffer): RGB {
  let value = pageBackgrounds.get(image);
  if (!value) {
    value = pageColor(image);
    pageBackgrounds.set(image, value);
  }
  return value;
}

function readPixel(image: PixelBuffer, x: number, y: number): RGB {
  const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  const alpha = (image.data[offset + 3] ?? 255) / 255;
  return [
    image.data[offset] * alpha + 255 * (1 - alpha),
    image.data[offset + 1] * alpha + 255 * (1 - alpha),
    image.data[offset + 2] * alpha + 255 * (1 - alpha),
  ];
}

function difference(a: RGB, b: RGB): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

/**
 * Preserve enclosing UI/artwork before removing OCR text. The low contrast mask
 * deliberately retains faint card borders that ordinary graphic segmentation
 * drops. Connected components are visited once on a grid bounded to 1800².
 * Border coverage distinguishes boxes from text strokes; dense substantial
 * components also retain filled panels and illustrations.
 */
export function findProtectedGraphics(image: PixelBuffer): Region[] {
  if (image.width < 1 || image.height < 1) return [];
  const cell = Math.max(
    1,
    Math.ceil(Math.max(image.width, image.height) / 1800),
  );
  const width = Math.ceil(image.width / cell);
  const height = Math.ceil(image.height / cell);
  const mask = new Uint8Array(width * height);
  const background = backgroundOf(image);

  // Pool every source pixel instead of point sampling: one-pixel borders must
  // survive downsampling regardless of their position within a grid cell.
  for (let y = 0; y < image.height; y++) {
    const row = Math.floor(y / cell) * width;
    for (let x = 0; x < image.width; x++) {
      const index = row + Math.floor(x / cell);
      // Antialiased corners can be much fainter than the straight border. A
      // higher cutoff breaks an otherwise closed card into four separate lines.
      if (!mask[index] && difference(readPixel(image, x, y), background) >= 4)
        mask[index] = 1;
    }
  }

  const queue = new Int32Array(mask.length);
  const regions: Region[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    let head = 0,
      tail = 1;
    queue[0] = start;
    mask[start] = 2;
    let minX = start % width,
      maxX = minX;
    let minY = Math.floor(start / width),
      maxY = minY;
    while (head < tail) {
      const point = queue[head++];
      const x = point % width,
        y = Math.floor(point / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] === 1) {
            mask[next] = 2;
            queue[tail++] = next;
          }
        }
      }
    }
    const boxWidth = maxX - minX + 1,
      boxHeight = maxY - minY + 1;
    const pixelWidth = boxWidth * cell,
      pixelHeight = boxHeight * cell;
    // Do not treat page frames, small glyphs, or a line/underline as a card.
    if (pixelWidth < 30 || pixelHeight < 20 || pixelWidth * pixelHeight < 800)
      continue;
    if (boxWidth >= width * 0.97 && boxHeight >= height * 0.97) continue;
    const substantial = pixelWidth >= 48 && pixelHeight >= 24;
    const density = tail / (boxWidth * boxHeight);
    const top = new Uint8Array(boxWidth),
      bottom = new Uint8Array(boxWidth);
    const left = new Uint8Array(boxHeight),
      right = new Uint8Array(boxHeight);
    const bandX = Math.max(1, Math.min(4, Math.floor(boxWidth * 0.12)));
    const bandY = Math.max(1, Math.min(4, Math.floor(boxHeight * 0.12)));
    let topCount = 0,
      bottomCount = 0,
      leftCount = 0,
      rightCount = 0;
    for (let i = 0; i < tail; i++) {
      const x = (queue[i] % width) - minX,
        y = Math.floor(queue[i] / width) - minY;
      if (y < bandY && !top[x]) {
        top[x] = 1;
        topCount++;
      }
      if (y >= boxHeight - bandY && !bottom[x]) {
        bottom[x] = 1;
        bottomCount++;
      }
      if (x < bandX && !left[y]) {
        left[y] = 1;
        leftCount++;
      }
      if (x >= boxWidth - bandX && !right[y]) {
        right[y] = 1;
        rightCount++;
      }
    }
    const closedBox =
      topCount / boxWidth >= 0.65 &&
      bottomCount / boxWidth >= 0.65 &&
      leftCount / boxHeight >= 0.5 &&
      rightCount / boxHeight >= 0.5;
    const filledGraphic = substantial && density >= 0.67;
    if (!closedBox && !filledGraphic) continue;
    regions.push(
      clampRegion(
        {
          x: minX * cell - 1,
          y: minY * cell - 1,
          width: pixelWidth + 2,
          height: pixelHeight + 2,
        },
        image.width,
        image.height,
      ),
    );
  }
  return regions;
}

/** A word touching a border slightly is allowed; substantially enclosed ink stays raster. */
export function isInsideProtectedGraphic(
  region: Region,
  protectedRegions: Region[],
): boolean {
  if (region.width <= 0 || region.height <= 0) return false;
  const area = region.width * region.height;
  const centerX = region.x + region.width / 2,
    centerY = region.y + region.height / 2;
  return protectedRegions.some((box) => {
    const overlapWidth = Math.max(
      0,
      Math.min(region.x + region.width, box.x + box.width) -
        Math.max(region.x, box.x),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(region.y + region.height, box.y + box.height) -
        Math.max(region.y, box.y),
    );
    return (
      (overlapWidth * overlapHeight) / area >= 0.55 &&
      centerX >= box.x &&
      centerX <= box.x + box.width &&
      centerY >= box.y &&
      centerY <= box.y + box.height
    );
  });
}

/**
 * Text erasure is appropriate only on a flat page-colored surface. Use two rings
 * outside the tight word bounds so descenders, underlines, and adjacent letters
 * can occupy a minority of samples without turning ordinary text into artwork.
 */
export function isPlainTextBackground(
  image: PixelBuffer,
  region: Region,
): boolean {
  const box = clampRegion(region, image.width, image.height);
  if (!box.width || !box.height) return false;
  const samples: RGB[] = [];
  const step = Math.max(1, Math.ceil(Math.max(box.width, box.height) / 100));
  const sample = (x: number, y: number) => {
    if (x >= 0 && x < image.width && y >= 0 && y < image.height)
      samples.push(readPixel(image, x, y));
  };
  for (const padding of [2, 4]) {
    const x1 = box.x - padding,
      x2 = box.x + box.width - 1 + padding;
    const y1 = box.y - padding,
      y2 = box.y + box.height - 1 + padding;
    for (let x = x1; x <= x2; x += step) {
      sample(x, y1);
      sample(x, y2);
    }
    for (let y = y1 + step; y < y2; y += step) {
      sample(x1, y);
      sample(x2, y);
    }
  }
  if (samples.length < 8) return false;
  const background = backgroundOf(image);
  const plainSamples = samples.filter(
    (color) => difference(color, background) <= 16,
  ).length;
  if (plainSamples / samples.length < 0.74) return false;

  let total = 0,
    backgroundCount = 0;
  const colors = new Set<number>();
  const interiorStep = Math.max(
    1,
    Math.ceil(Math.sqrt((box.width * box.height) / 1800)),
  );
  for (let y = box.y; y < box.y + box.height; y += interiorStep) {
    for (let x = box.x; x < box.x + box.width; x += interiorStep) {
      const color = readPixel(image, x, y);
      total++;
      if (difference(color, background) <= 20) backgroundCount++;
      else
        colors.add(
          (Math.floor(color[0] / 64) << 4) |
            (Math.floor(color[1] / 64) << 2) |
            Math.floor(color[2] / 64),
        );
    }
  }
  // Multiple text colors and their antialiasing are fine. Dense or richly
  // multicolored interiors are much likelier to be an icon/photo than a word.
  return backgroundCount / total >= 0.24 && colors.size <= 18;
}
