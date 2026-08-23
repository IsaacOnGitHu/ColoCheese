import { describe, expect, test } from "vitest";
import { canBounce } from "../venator";

type Tile = [number, number];

const SOURCE_ORIGIN: Tile = [0, 0];
const TEST_SIZES = [1, 2, 3, 4, 5];

describe("venator bounce tests", () => {
  test("odd-sized sources bounce when the target center is within 2 tiles of the source center", () => {
    expect(canBounce(0, 0, 1, 2, 2, 1)).toBe(true);
    expect(canBounce(0, 0, 1, 3, 0, 1)).toBe(false);

    expect(canBounce(0, 0, 3, 3, 1, 1)).toBe(true);
    expect(canBounce(0, 0, 3, 4, -1, 1)).toBe(false);

    expect(canBounce(0, 0, 5, 4, 0, 1)).toBe(true);
    expect(canBounce(0, 0, 5, 5, -2, 1)).toBe(false);
  });

  test("even-sized sources bounce when the target center is within 2 tiles of any source tile", () => {
    expect(canBounce(0, 0, 2, 3, 0, 1)).toBe(true);
    expect(canBounce(0, 0, 2, 4, 0, 1)).toBe(false);

    expect(canBounce(0, 0, 4, -1, 1, 1)).toBe(true);
    expect(canBounce(0, 0, 4, 6, 0, 1)).toBe(false);
  });

  test("uses the updated center tiles for 2x2 and 4x4 targets", () => {
    expect(canBounce(0, 0, 1, 2, 0, 2)).toBe(true);
    expect(canBounce(0, 0, 1, 3, 0, 2)).toBe(false);

    expect(canBounce(0, 0, 1, 0, 0, 4)).toBe(true);
    expect(canBounce(0, 0, 1, 1, 0, 4)).toBe(false);
  });

  test("requires at least one target tile within 3 tiles of the source center", () => {
    expect(canBounce(0, 0, 4, -1, 0, 1)).toBe(true);
    expect(canBounce(0, 0, 4, -2, 0, 1)).toBe(false);
  });

  test("matches the simplified rules for all supported size combinations around the source", () => {
    for (const sourceSize of TEST_SIZES) {
      for (const targetSize of TEST_SIZES) {
        for (let x = -8; x <= 8; ++x) {
          for (let y = -8; y <= 8; ++y) {
            expect(
              canBounce(...SOURCE_ORIGIN, sourceSize, x, y, targetSize),
              `source ${sourceSize}x${sourceSize}, target ${targetSize}x${targetSize} at ${x}, ${y}`
            ).toBe(expectedCanBounce(...SOURCE_ORIGIN, sourceSize, x, y, targetSize));
          }
        }
      }
    }
  });

  test("rejects unsupported NPC sizes", () => {
    expect(() => canBounce(0, 0, 6, 0, 0, 1)).toThrow("Unsupported NPC size 6");
    expect(() => canBounce(0, 0, 1, 0, 0, 6)).toThrow("Unsupported NPC size 6");
  });
});

function expectedCanBounce(
  x: number,
  y: number,
  size: number,
  x2: number,
  y2: number,
  size2: number
) {
  const sourceCenter = centerTile(x, y, size);
  const targetCenter = centerTile(x2, y2, size2);
  const sourceTilesToCheck = size % 2 === 1 ? [sourceCenter] : tiles(x, y, size);

  return (
    sourceTilesToCheck.some((sourceTile) => withinRadius(sourceTile, targetCenter, 2)) &&
    tiles(x2, y2, size2).some((targetTile) => withinRadius(sourceCenter, targetTile, 3))
  );
}

function centerTile(x: number, y: number, size: number): Tile {
  if (size === 2) {
    return [x, y];
  }
  if (size === 4) {
    return [x + 2, y - 1];
  }
  if (size === 1 || size === 3 || size === 5) {
    const offset = Math.floor(size / 2);
    return [x + offset, y - offset];
  }
  throw new Error(`Unsupported NPC size ${size}`);
}

function tiles(x: number, y: number, size: number): Tile[] {
  const result: Tile[] = [];
  for (let dx = 0; dx < size; ++dx) {
    for (let dy = 0; dy < size; ++dy) {
      result.push([x + dx, y - dy]);
    }
  }
  return result;
}

function withinRadius([x, y]: Tile, [x2, y2]: Tile, radius: number) {
  return Math.abs(x - x2) <= radius && Math.abs(y - y2) <= radius;
}
