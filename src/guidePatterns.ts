// Movements lifted from the community guide's own recorded solves (see guideSolves.ts for the
// guide itself). Each is the author playing a stack out tick by tick, stored as offsets from the
// centre tile of the pillar they were standing at, so the same movement can be laid over any of the
// four pillars.
//
// These matter more than the stacks they were recorded on. The Colosseum has a limited number of
// shapes, so the same handful of out-and-back dances keep working: eleven of these solve 147 of 150
// random stacks the guide never wrote about. Trying them is also how the tool gives back the move a
// player has already practised, instead of inventing an equally valid but unfamiliar one.
import type { Coordinates } from "./types";

export type GuidePattern = {
  /** Where you stand on each tick, as offsets from the pillar's centre tile. */
  rel: [number, number][];
  /** Tiles it actually moves to, ignoring how long you stand still - a rough cost. */
  moves: number;
  /** A guide stack it was recorded on, so the source can be found again. */
  from: string;
};

export const GUIDE_PATTERNS: GuidePattern[] = [
  { moves: 3, from: "17091.14092.11094m", rel: [[-2, 0],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2],[-3, 2]] },
  { moves: 3, from: "11112.14102.11084m.17104m", rel: [[-8, 1],[-8, 2],[-8, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2]] },
  { moves: 3, from: "11112.11082.17094m.14096", rel: [[-8, 0],[-8, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2],[-6, 2]] },
  { moves: 4, from: "14094r.11096.17096", rel: [[-4, 0],[-4, 0],[-4, 2],[-2, 0],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2]] },
  { moves: 4, from: "11082.17104r.11116.14106", rel: [[-8, 1],[-8, 2],[-6, 0],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2],[-4, -2]] },
  { moves: 4, from: "11112.17092.11084r.14075.14106", rel: [[-6, -2],[-4, -4],[-4, -4],[-4, -4],[-4, -2],[-2, 0],[-2, 0],[-2, 0],[-2, 0],[-2, 0],[-2, 0],[-2, 0],[-2, 0]] },
  { moves: 4, from: "17102.20102.11114m.11086.14106", rel: [[-8, 1],[-8, 2],[-6, 2],[-6, 2],[-6, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2],[-4, 2]] },
  { moves: 4, from: "11112.14082.11084m.14114m", rel: [[-2, 0],[-2, -2],[-2, 0],[-2, 0],[-2, 0],[-2, 0],[-2, 0],[-2, -2],[-2, -2],[-2, -2],[-2, -2],[-2, -2],[-2, -2],[-2, -2],[-2, -2],[-2, -2],[-2, -2],[-2, -2]] },
  { moves: 6, from: "17092.11094r.14096", rel: [[-4, 0],[-4, 0],[-4, 2],[-2, 0],[-2, 2],[-2, 2],[-2, 1],[-2, 1],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2]] },
  { moves: 6, from: "14092.11094m.17096", rel: [[-4, 0],[-4, 0],[-4, 2],[-2, 0],[-2, 2],[-2, 2],[-2, 2],[-2, 1],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3],[-2, 3]] },
  { moves: 6, from: "14112.11084r.14084r.11116.17106", rel: [[-2, 1],[-2, 2],[-2, 0],[-2, -2],[-1, -2],[-1, -2],[-1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2],[1, -2]] },
  { moves: 8, from: "10222.10194r.10134r.10166", rel: [[1, 23],[3, 23],[4, 24],[4, 24],[3, 23],[1, 23],[1, 21],[1, 19],[1, 17],[1, 17],[1, 17],[1, 17],[1, 17],[1, 17],[1, 17],[1, 17],[1, 17],[1, 17],[1, 17],[1, 17]] },
  { moves: 9, from: "11112.11082.17104m.14106", rel: [[-8, 1],[-8, 3],[-9, 4],[-9, 4],[-8, 3],[-8, 1],[-8, 1],[-8, 1],[-6, 1],[-4, 1],[-2, 0],[-2, 0],[-2, 0],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2],[-2, 2]] },
  { moves: 10, from: "11112.11082.14084m.14114m", rel: [[-7, 0],[-7, 2],[-7, 4],[-7, 6],[-6, 8],[-4, 10],[-3, 12],[-2, 14],[-2, 16],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17]] },
  { moves: 10, from: "14082.14112.11114m.11084m", rel: [[-7, 0],[-7, 2],[-7, 4],[-7, 6],[-7, 8],[-6, 10],[-5, 12],[-3, 14],[-2, 16],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17]] },
  { moves: 10, from: "11082.14114r.11116.14086", rel: [[-2, 0],[-2, 2],[-2, 4],[-2, 6],[-2, 8],[-2, 10],[-2, 12],[-2, 14],[-2, 16],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17]] },
  { moves: 10, from: "11082.14112.14084m.11116", rel: [[-2, 1],[-2, 3],[-2, 5],[-2, 7],[-2, 9],[-2, 11],[-2, 13],[-2, 15],[-2, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17],[-1, 17]] },
];

/** The centre tile of each pillar. */
export const PILLAR_CENTRES: Coordinates[] = [
  [9, 9],
  [24, 9],
  [9, 24],
  [24, 24],
];

/** A movement laid over one pillar. Mirroring covers the pillars on the far side of the arena,
 *  where the same shape is flipped; anything that lands somewhere silly simply fails to simulate. */
export function placePattern(
  pattern: GuidePattern,
  [cx, cy]: Coordinates,
  flipX: boolean,
  flipY: boolean,
): Coordinates[] {
  const tiles = pattern.rel.map(
    ([dx, dy]) => [cx + (flipX ? -dx : dx), cy + (flipY ? -dy : dy)] as Coordinates,
  );
  // The recordings run on for a while after the last step so the rhythm can be watched. That tail is
  // the author standing still, not part of the movement, and keeping it would show up as a long wait.
  let end = tiles.length - 1;
  while (end > 0 && tiles[end][0] === tiles[end - 1][0] && tiles[end][1] === tiles[end - 1][1]) end--;
  return tiles.slice(0, end + 1);
}

/** The out-and-back dances, without the guide's long "run south and pray" escapes: those are what it
 *  tells you to do when a stack has no answer, and as a route they are a trek across the arena. */
export const OFF_TICK_PATTERNS = GUIDE_PATTERNS.filter((p) => p.moves <= 6);
