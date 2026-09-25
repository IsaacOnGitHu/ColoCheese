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

  test("solves the guide's Z-stack by walking west first, and still shows its advice", () => {
    const los = new LineOfSight() as any;
    los.weaponMode = DEFAULT_WEAPON_MODE;
    // The guide's "range + mage + range". Its written solve begins "move 2 tiles west", and we only
    // find it because Meta Solve looks for a better hidden tile before solving.
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
    expect(los.suggestedPath).not.toBeNull();
    expect(los.suggestedStartHidden).toBe(true);
    expect(los.solveRoute).toContain("Start on S");
    // and it gives back the movement the guide's author recorded, not one of our own
    expect(los.solveRoute).toContain("community guide's own move");
    expect(los.suggestedClicks.map((c: any) => c.tile)).toEqual([
      [5, 9],
      [5, 11],
      [7, 9],
      [7, 11],
      [10, 11],
    ]);
    expect(los.guideNote?.label).toBe("range + mage + range");
  });

  test("with nothing to fight it sends you to the tank path", () => {
    const los = new LineOfSight() as any;
    los.weaponMode = DEFAULT_WEAPON_MODE;
    los._setSelected([7, 9], 0);
    los.solveMeta();
    expect(los.suggestedPath).toBeNull();
    expect(los.solveSummary).toContain("Solve Tank Path");
    expect(los.solveTone).toBe("bad");
  });
});
