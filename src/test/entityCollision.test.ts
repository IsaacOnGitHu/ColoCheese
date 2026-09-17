import { describe, expect, test } from "vitest";
import { LineOfSight } from "../lineOfSight";
import { NPC_TYPES } from "../constants";
import { buildPathTree, pathTo, runTicks } from "../playerPathing";
import { Coordinates } from "../types";

// Seen in game: a Reinforcement Shaman south of the NW pillar wanted to step east behind the pillar,
// but the Javelin Colossus was on that tile. Instead of walking round the Javelin and up the west side
// of the pillar, it waited, then stepped in behind the pillar as soon as the Javelin moved across.
describe("entity collision", () => {
  test("an NPC waits for a tile another NPC is on, then takes it", () => {
    const los = new LineOfSight() as any;
    const stack: Array<[number, number, number, string | null]> = [
      [9, 13, NPC_TYPES.JAVELIN_COLOSSUS, null],
      [9, 16, NPC_TYPES.MANTICORE, "r"],
      [8, 11, NPC_TYPES.REINFORCEMENT_SHAMAN, null],
    ];
    for (const [x, y, type, extra] of stack) {
      los._setSelected([x, y], type, extra);
      los.place();
    }

    const start: Coordinates = [9, 7];
    const clicks: Array<{ tile: Coordinates; wait: number }> = [
      { tile: [6, 4], wait: 0 },
      { tile: [9, 7], wait: 2 },
      { tile: [8, 6], wait: 0 },
    ];
    const path: Coordinates[] = [start];
    let at = start;
    for (const { tile, wait } of clicks) {
      path.push(...runTicks(pathTo(buildPathTree(at, 34, 34, (x, y) => los.isPillar(x, y)), tile)!));
      at = tile;
      for (let i = 0; i < wait; i++) path.push(at);
    }

    for (let t = 0; t < path.length + 40; t++) {
      los._setSelected(path[Math.min(t, path.length - 1)], 0);
      los.step();
    }

    const shaman = los._getMobs().find((m: any) => m[2] === NPC_TYPES.REINFORCEMENT_SHAMAN);
    expect([shaman[0], shaman[1]]).toEqual([8, 11]);
  });
});
