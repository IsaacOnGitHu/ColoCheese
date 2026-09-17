import { Coordinates } from "./types";

// The order the OSRS player pathfinder expands neighbours in (west, east, south, north, then the
// diagonals south-west, south-east, north-west, north-east). Because the search is breadth-first
// from the player and the first tile to reach a neighbour becomes its parent, this order is what
// decides which of several equally short routes a click actually walks - it produces the
// "straight first, diagonal last" shape. This map draws North at the top, so OSRS south (y-1)
// is +1 here.
const DIRECTIONS: ReadonlyArray<Coordinates> = [
  [-1, 0],
  [1, 0],
  [0, 1],
  [0, -1],
  [-1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
];

export type PathTree = {
  width: number;
  parent: Int32Array;
};

/**
 * Breadth-first search from `start` over the whole map. One tree answers "what route does a
 * click on tile X walk from here" for every X at once, since stopping the search early at X
 * wouldn't change any parent already assigned.
 */
export function buildPathTree(
  start: Coordinates,
  width: number,
  height: number,
  isBlocked: (x: number, y: number) => boolean,
): PathTree {
  return search(start, width, height, isBlocked).tree;
}

/**
 * Route to the first tile in search order that satisfies `isGoal` (the start tile excluded), e.g.
 * the tile you walk to when you click a monster to attack it. Null if none is reachable.
 */
export function pathToFirst(
  start: Coordinates,
  width: number,
  height: number,
  isBlocked: (x: number, y: number) => boolean,
  isGoal: (x: number, y: number) => boolean,
): Coordinates[] | null {
  const { tree, found } = search(start, width, height, isBlocked, isGoal);
  return found === null ? null : pathTo(tree, found);
}

function search(
  start: Coordinates,
  width: number,
  height: number,
  isBlocked: (x: number, y: number) => boolean,
  isGoal?: (x: number, y: number) => boolean,
): { tree: PathTree; found: Coordinates | null } {
  const parent = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  const startIndex = start[1] * width + start[0];
  parent[startIndex] = startIndex;
  let head = 0;
  let tail = 0;
  queue[tail++] = startIndex;

  while (head < tail) {
    const current = queue[head++];
    const cx = current % width;
    const cy = (current - cx) / width;
    for (const [dx, dy] of DIRECTIONS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (parent[next] !== -1 || isBlocked(nx, ny)) continue;
      // players can't cut a corner: a diagonal step needs both orthogonal neighbours open
      if (dx !== 0 && dy !== 0 && (isBlocked(cx + dx, cy) || isBlocked(cx, cy + dy))) continue;
      parent[next] = current;
      queue[tail++] = next;
      if (isGoal?.(nx, ny)) return { tree: { width, parent }, found: [nx, ny] };
    }
  }
  return { tree: { width, parent }, found: null };
}

/** Tile-by-tile route a click on `dest` walks, including the starting tile; null if unreachable. */
export function pathTo(tree: PathTree, dest: Coordinates): Coordinates[] | null {
  const { width, parent } = tree;
  let index = dest[1] * width + dest[0];
  if (parent[index] === -1) return null;
  const route: Coordinates[] = [];
  for (;;) {
    route.push([index % width, Math.floor(index / width)]);
    if (parent[index] === index) break;
    index = parent[index];
  }
  return route.reverse();
}

/** Positions after each tick of running (2 tiles per tick) along a route that includes its start. */
export function runTicks(route: Coordinates[]): Coordinates[] {
  const ticks: Coordinates[] = [];
  for (let i = 2; i < route.length; i += 2) ticks.push(route[i]);
  if (route.length > 1 && (route.length - 1) % 2 === 1) ticks.push(route[route.length - 1]);
  return ticks;
}
