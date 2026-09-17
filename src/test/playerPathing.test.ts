import { describe, expect, test } from "vitest";
import { buildPathTree, pathTo, runTicks } from "../playerPathing";
import { Coordinates } from "../types";

const SIZE = 34;

function route(start: Coordinates, dest: Coordinates, blocked: Coordinates[] = []) {
  const isBlocked = (x: number, y: number) => blocked.some(([bx, by]) => bx === x && by === y);
  return pathTo(buildPathTree(start, SIZE, SIZE, isBlocked), dest);
}

describe("player pathing", () => {
  test("a straight click walks a straight line", () => {
    expect(route([10, 10], [14, 10])).toEqual([[10, 10], [11, 10], [12, 10], [13, 10], [14, 10]]);
  });

  // The pathfinder expands west, east, south, north before any diagonal, so a click that isn't in a
  // straight line walks straight first and cuts the diagonal at the end - unlike NPCs, which step
  // diagonally first. This is what makes a bend in the route NOT need its own click.
  test("an off-axis click walks straight first, diagonal last", () => {
    expect(route([10, 10], [13, 11])).toEqual([[10, 10], [11, 10], [12, 10], [13, 11]]);
    expect(route([10, 10], [11, 13])).toEqual([[10, 10], [10, 11], [10, 12], [11, 13]]);
  });

  test("a diagonal step can't cut a blocked corner", () => {
    expect(route([10, 10], [11, 11], [[11, 10]])).toEqual([[10, 10], [10, 11], [11, 11]]);
  });

  test("an unreachable tile has no route", () => {
    const walledIn: Coordinates[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) walledIn.push([20 + dx, 20 + dy]);
    expect(route([10, 10], [20, 20], walledIn)).toBeNull();
  });

  test("running covers 2 tiles a tick, with a 1-tile final tick on odd routes", () => {
    const five: Coordinates[] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
    expect(runTicks(five)).toEqual([[2, 0], [4, 0], [5, 0]]);
    expect(runTicks(five.slice(0, 5))).toEqual([[2, 0], [4, 0]]);
    expect(runTicks([[0, 0]])).toEqual([]);
  });
});
