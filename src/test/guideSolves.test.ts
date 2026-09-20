import { describe, expect, test } from "vitest";
import { LineOfSight } from "../lineOfSight";
import { DEFAULT_WEAPON_MODE, NPC_TYPES as N } from "../constants";
import { GUIDE_SOLVES, matchGuideSolve } from "../guideSolves";
import type { Mob, MobExtra } from "../types";

const mob = (x: number, y: number, type: number, extra: MobExtra = null): Mob => [x, y, type, x, y, 0, extra];

describe("the community guide's own advice", () => {
  test("every entry has a stack and something to say", () => {
    expect(GUIDE_SOLVES.length).toBeGreaterThan(50);
    for (const solve of GUIDE_SOLVES) {
      expect(solve.mobs.length).toBeGreaterThan(1);
      expect(solve.label).not.toBe("");
      expect(solve.steps.length > 0 || solve.unwinnable).toBe(true);
    }
  });

  test("matches a stack by its shape, wherever it sits on the map", () => {
    // "Range + shaman" in the guide: a Javelin Colossus with a Serpent Shaman three tiles east.
    const here = matchGuideSolve([mob(14, 10, N.SERPENT_SHAMAN), mob(11, 10, N.JAVELIN_COLOSSUS)]);
    expect(here?.label).toBe("Range + shaman");
    const moved = matchGuideSolve([mob(24, 25, N.SERPENT_SHAMAN), mob(21, 25, N.JAVELIN_COLOSSUS)]);
    expect(moved?.label).toBe("Range + shaman");
    // Same tiles, but stretched apart - a different stack, so no advice rather than wrong advice.
    expect(matchGuideSolve([mob(15, 10, N.SERPENT_SHAMAN), mob(11, 10, N.JAVELIN_COLOSSUS)])).toBeNull();
  });

  test("a Manticore's orb pattern is part of the match", () => {
    const mage = matchGuideSolve([mob(11, 10, N.JAVELIN_COLOSSUS), mob(14, 10, N.MANTICORE, "m" as MobExtra)]);
    expect(mage?.label).toBe("Range + manticore(mage)");
    expect(matchGuideSolve([mob(11, 10, N.JAVELIN_COLOSSUS), mob(14, 10, N.MANTICORE, "r" as MobExtra)])?.label).not.toBe(
      "Range + manticore(mage)",
    );
    // An uncharged Manticore could still turn out either way, so the guide has nothing to offer yet.
    expect(matchGuideSolve([mob(11, 10, N.JAVELIN_COLOSSUS), mob(14, 10, N.MANTICORE, "u" as MobExtra)])).toBeNull();
  });

  test("carries the guide's verdict on the stacks it calls unsolvable", () => {
    const doomed = GUIDE_SOLVES.filter((s) => s.unwinnable);
    expect(doomed.length).toBeGreaterThan(0);
    for (const solve of doomed) expect(solve.label).not.toBe("");
  });

  test("a solve shows the guide's advice for that stack", () => {
    const los = new LineOfSight() as any;
    los.weaponMode = DEFAULT_WEAPON_MODE;
    for (const [x, y, type] of [
      [11, 10, N.JAVELIN_COLOSSUS],
      [14, 10, N.SERPENT_SHAMAN],
    ]) {
      los._setSelected([x, y], type, null);
      los.place();
    }
    los._setSelected([7, 9], 0);
    los.solveMeta();
    expect(los.guideNote?.label).toBe("Range + shaman");
    expect(los.guideNote?.steps.join(" ")).toContain("praying mage");
    expect(los.getUiState().guideNote).toEqual(los.guideNote);
  });

  test("with no meta solve it sends you to the tank path", () => {
    const los = new LineOfSight() as any;
    los.weaponMode = DEFAULT_WEAPON_MODE;
    // The guide's "range + mage + range" Z-stack. Its solve is a movement loop that never settles on
    // one tile, which is not something a route of clicks can express, so we have nothing to offer.
    for (const [x, y, type] of [
      [11, 10, N.JAVELIN_COLOSSUS],
      [17, 10, N.JAVELIN_COLOSSUS],
      [14, 10, N.SHOCKWAVE_COLOSSUS],
    ]) {
      los._setSelected([x, y], type, null);
      los.place();
    }
    los._setSelected([7, 9], 0);
    los.solveMeta();
    expect(los.suggestedPath).toBeNull();
    expect(los.solveSummary).toContain("Solve Tank Path");
    expect(los.solveTone).toBe("bad");
    // The guide still has its own answer for it.
    expect(los.guideNote?.label).toBe("range + mage + range");
  });
});
