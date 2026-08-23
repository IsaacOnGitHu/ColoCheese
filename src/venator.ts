// credit for testing/deriving logic:
// ttortt @ https://docs.google.com/document/d/e/2PACX-1vTST4TFAjn0WThClMm48673H9VCVDCTzBOWjrdpcVA0rn7ewWLYGeulGR9daLMDoSCZtGXI11JVaVgV/pub

const BOUNCE_RADIUS = 2;
const TARGET_TILE_RADIUS = 3;

type Tile = [number, number];
type HasLineOfSight = (from: Tile, to: Tile) => boolean;

const isInRadius = ([x, y]: Tile, [x2, y2]: Tile, radius: number) => {
  const dxAbs = Math.abs(x - x2);
  const dyAbs = Math.abs(y - y2);
  return dxAbs <= radius && dyAbs <= radius;
};

export function canBounce(
  x: number,
  y: number,
  size: number,
  x2: number,
  y2: number,
  size2: number,
  hasLineOfSight: HasLineOfSight = () => true
): boolean {
  const sourceCenter = getCenterTile(x, y, size);
  const targetCenter = getCenterTile(x2, y2, size2);
  const sourceScanTiles = isOddSize(size) ? [sourceCenter] : getAllTiles(x, y, size);
  const targetTiles = getAllTiles(x2, y2, size2);

  return (
    sourceScanTiles.some((tile) => isInRadius(tile, targetCenter, BOUNCE_RADIUS)) &&
    targetTiles.some((tile) => isInRadius(sourceCenter, tile, TARGET_TILE_RADIUS)) &&
    hasLineOfSight(sourceCenter, getClosestTile(sourceCenter, x2, y2, size2))
  );
}

function isOddSize(size: number) {
  return size % 2 === 1;
}

export function getCenterTile(x: number, y: number, size: number): Tile {
  switch (size) {
    case 1:
    case 3:
    case 5: {
      const offset = Math.floor(size / 2);
      return [x + offset, y - offset];
    }
    case 2:
      return [x, y];
    case 4: // not that we have any...
      return [x + 2, y - 1];
    default:
      throw new Error(`Unsupported NPC size ${size}`);
  }
}

function getAllTiles(x: number, y: number, size: number): Tile[] {
  const res: Tile[] = [];
  for (let dx = 0; dx < size; ++dx) {
    for (let dy = 0; dy < size; ++dy) {
      res.push([x + dx, y - dy]);
    }
  }
  return res;
}

function getClosestTile([x, y]: Tile, targetX: number, targetY: number, targetSize: number): Tile {
  const closestX = Math.max(targetX, Math.min(targetX + targetSize - 1, x));
  const closestY = Math.max(targetY - targetSize + 1, Math.min(targetY, y));
  return [closestX, closestY];
}
