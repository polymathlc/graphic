/** Deliberately conservative raster segmentation; this does not trace vectors. */
export interface PixelBuffer {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RGB = readonly [number, number, number];

export function clampRegion(
  region: Region,
  width: number,
  height: number,
): Region {
  const x = Math.max(0, Math.min(width, Math.floor(region.x)));
  const y = Math.max(0, Math.min(height, Math.floor(region.y)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width, Math.ceil(region.x + region.width)) - x),
    height: Math.max(
      0,
      Math.min(height, Math.ceil(region.y + region.height)) - y,
    ),
  };
}

function pixel(image: PixelBuffer, x: number, y: number): RGB {
  const offset =
    (Math.max(0, Math.min(image.height - 1, Math.round(y))) * image.width +
      Math.max(0, Math.min(image.width - 1, Math.round(x)))) *
    4;
  const alpha = (image.data[offset + 3] ?? 255) / 255;
  return [0, 1, 2].map((channel) =>
    Math.round(image.data[offset + channel] * alpha + 255 * (1 - alpha)),
  ) as unknown as RGB;
}

function dominant(samples: RGB[]): RGB {
  if (!samples.length) return [255, 255, 255];
  const buckets = new Map<string, { count: number; total: number[] }>();
  for (const color of samples) {
    const key = color.map((channel) => Math.round(channel / 24)).join(",");
    const bucket = buckets.get(key) ?? { count: 0, total: [0, 0, 0] };
    bucket.count++;
    color.forEach((channel, i) => {
      bucket.total[i] += channel;
    });
    buckets.set(key, bucket);
  }
  const best = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
  return best.total.map((channel) =>
    Math.round(channel / best.count),
  ) as unknown as RGB;
}

/** Samples outside a text/graphic rectangle, avoiding its original ink. */
export function borderColor(image: PixelBuffer, region: Region): RGB {
  const samples: RGB[] = [];
  const step = Math.max(
    1,
    Math.floor(Math.max(region.width, region.height) / 90),
  );
  const x1 = region.x - 3;
  const y1 = region.y - 3;
  const x2 = region.x + region.width + 2;
  const y2 = region.y + region.height + 2;
  for (let x = Math.max(0, x1); x <= Math.min(image.width - 1, x2); x += step) {
    if (y1 >= 0) samples.push(pixel(image, x, y1));
    if (y2 < image.height) samples.push(pixel(image, x, y2));
  }
  for (
    let y = Math.max(0, y1);
    y <= Math.min(image.height - 1, y2);
    y += step
  ) {
    if (x1 >= 0) samples.push(pixel(image, x1, y));
    if (x2 < image.width) samples.push(pixel(image, x2, y));
  }
  return samples.length ? dominant(samples) : pageColor(image);
}

export function pageColor(image: PixelBuffer): RGB {
  const samples: RGB[] = [];
  const step = Math.max(
    1,
    Math.floor(Math.max(image.width, image.height) / 150),
  );
  for (let x = 0; x < image.width; x += step) {
    samples.push(pixel(image, x, 0), pixel(image, x, image.height - 1));
  }
  for (let y = 0; y < image.height; y += step) {
    samples.push(pixel(image, 0, y), pixel(image, image.width - 1, y));
  }
  return dominant(samples);
}

export function cssColor(color: RGB): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/** Dominant ink color, after excluding pixels similar to the sampled background. */
export function inkColor(
  image: PixelBuffer,
  region: Region,
  background: RGB,
): string {
  const box = clampRegion(region, image.width, image.height);
  const samples: RGB[] = [];
  const step = Math.max(
    1,
    Math.floor(Math.sqrt((box.width * box.height) / 5000)),
  );
  for (let y = box.y; y < box.y + box.height; y += step) {
    for (let x = box.x; x < box.x + box.width; x += step) {
      const color = pixel(image, x, y);
      if (distance(color, background) > 85) samples.push(color);
    }
  }
  if (!samples.length)
    return background[0] + background[1] + background[2] > 384
      ? "#202124"
      : "#ffffff";
  return cssColor(dominant(samples));
}

function distance(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function overlaps(a: Region, b: Region, gap = 0): boolean {
  return (
    a.x <= b.x + b.width + gap &&
    b.x <= a.x + a.width + gap &&
    a.y <= b.y + b.height + gap &&
    b.y <= a.y + a.height + gap
  );
}

/** Merge overlapping crop rectangles so initial reconstruction never duplicates pixels. */
export function mergeRegions(regions: Region[], gap = 0): Region[] {
  const result: Region[] = [];
  for (const original of regions) {
    let region = { ...original };
    let index = 0;
    while (index < result.length) {
      const other = result[index];
      if (!overlaps(region, other, gap)) {
        index++;
        continue;
      }
      const x = Math.min(region.x, other.x);
      const y = Math.min(region.y, other.y);
      region = {
        x,
        y,
        width: Math.max(region.x + region.width, other.x + other.width) - x,
        height: Math.max(region.y + region.height, other.y + other.height) - y,
      };
      result.splice(index, 1);
      index = 0;
    }
    result.push(region);
  }
  return result;
}

/** Find connected graphics against a near-flat page background on a bounded grid. */
export function findGraphicRegions(
  image: PixelBuffer,
  maxRegions = 60,
): Region[] {
  if (!image.width || !image.height || maxRegions < 1) return [];
  const cell = Math.max(
    1,
    Math.ceil(Math.max(image.width, image.height) / 450),
  );
  const width = Math.ceil(image.width / cell);
  const height = Math.ceil(image.height / cell);
  const foreground = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const background = pageColor(image);
  // Three samples per cell retain thin strokes without allocating a full-size mask.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (const fraction of [0.15, 0.5, 0.85]) {
        if (
          distance(
            pixel(image, (x + fraction) * cell, (y + fraction) * cell),
            background,
          ) > 48
        ) {
          foreground[y * width + x] = 1;
          break;
        }
      }
    }
  }
  const queue = new Int32Array(width * height);
  const regions: Region[] = [];
  for (let start = 0; start < foreground.length; start++) {
    if (!foreground[start] || visited[start]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    let minX = start % width,
      maxX = minX;
    let minY = Math.floor(start / width),
      maxY = minY;
    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (foreground[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    if (tail < 5 || (maxX - minX + 1) * (maxY - minY + 1) * cell * cell < 100)
      continue;
    regions.push(
      clampRegion(
        {
          x: minX * cell - 2,
          y: minY * cell - 2,
          width: (maxX - minX + 1) * cell + 4,
          height: (maxY - minY + 1) * cell + 4,
        },
        image.width,
        image.height,
      ),
    );
    // Dense photos/noisy scans are kept as one movable raster instead of hundreds of fragments.
    if (regions.length > 400)
      return [{ x: 0, y: 0, width: image.width, height: image.height }];
  }
  const merged = mergeRegions(regions, cell * 2).sort(
    (a, b) => b.width * b.height - a.width * a.height,
  );
  if (merged.length > maxRegions) {
    return [{ x: 0, y: 0, width: image.width, height: image.height }];
  }
  return merged;
}
