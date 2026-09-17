import { describe, expect, test } from "vitest";
import { LineOfSight } from "../lineOfSight";
import { buildPathTree, pathTo, pathToFirst, runTicks } from "../playerPathing";
import { DEFAULT_WEAPON_MODE, NPC_INFO, NPC_TYPES, WEAPON_MODES, WeaponMode } from "../constants";
import { isPrayedAgainst } from "../damageModel";

type Placement = [number, number, number, (string | null)?];

function solve(
  placements: Placement[],
  start: [number, number],
  mode: WeaponMode = DEFAULT_WEAPON_MODE,
  solarflare = false,
) {
  const los = new LineOfSight() as any;
  los.setWeaponMode(mode);
  los.setSolarflare(solarflare);
  for (const [x, y, type, extra] of placements) {
    los._setSelected([x, y], type, extra ?? null);
    los.place();
  }
  los._setSelected([start[0], start[1]], 0);
  los.solveAndDrawTankPath();
  return { los, solved: los.suggestedPath !== null };
}

function visibleFrom(los: any, px: number, py: number) {
  return los._getMobs().filter((m: any) => {
    const t = m[2];
    if (t === 0 || t >= 8) return false;
    const info = NPC_INFO[t];
    return los.hasLOS(m[0], m[1], px, py, info.size, info.range, true);
  });
}

/** Protect from Magic is up while moving, so only ranged/melee mobs hurt you on the way. */
const threatsOf = (mobs: any[]) => mobs.filter((m) => !isPrayedAgainst(m[2], "magic"));

/** play the solved replay through the real engine, then hold the tile so stragglers settle */
function settle(los: any) {
  // exactly replay.length steps consumes every recorded position; one fewer leaves the player
  // mid-path on short replays.
  const replay = los.replay as [number, number][];
  for (let i = 0; i < replay.length; i++) los.step();
  const [px, py] = los.selected;
  los.replay = null;
  los.replayTick = null;
  for (let i = 0; i < 30; i++) {
    los._setSelected([px, py], 0);
    los.step();
  }
  return { px, py, visible: visibleFrom(los, px, py) };
}

describe("tank path solver", () => {
  // Reported stack: a 1v1 on the Jaguar in the wall nook east of the SE pillar worked, but once it
  // died the Reinforcement Shaman was out of reach, and clicking it walked you into the Manticore's
  // view. The kill tile has to leave you hidden or with a next fight you can take alone.
  // You can start from any tile you can walk to unseen. From the west of the NW pillar with this
  // 4-stack, a couple of tiles over gives an easier fight than staying put.
  test("can start from a nearby hidden tile, and nothing sees the walk there", () => {
    const start: [number, number] = [6, 9];
    const { los, solved } = solve(
      [
        [12, 8, NPC_TYPES.JAVELIN_COLOSSUS],
        [12, 10, NPC_TYPES.SERPENT_SHAMAN],
        [12, 12, NPC_TYPES.JAGUAR_WARRIOR],
        [15, 11, NPC_TYPES.MANTICORE, "r"],
      ],
      start,
    );
    expect(solved).toBe(true);
    expect(los.suggestedStartHidden).toBe(true);
    expect(los.solveRoute).toContain("Start on S.");

    const first = los.suggestedClicks[0];
    const walk = runTicks(pathTo(buildPathTree(start, 34, 34, (x, y) => los.isPillar(x, y)), first.tile)!);
    for (let i = 0; i < 1 + walk.length + first.wait; i++) {
      los.step();
      expect(visibleFrom(los, los.selected[0], los.selected[1])).toHaveLength(0);
    }

    const { reach, diagonals } = WEAPON_MODES[DEFAULT_WEAPON_MODE];
    const { px, py, visible } = settle(los);
    expect(visible).toHaveLength(1);
    const [x, y, t] = visible[0];
    expect(los.hasLOS(x, y, px, py, NPC_INFO[t].size, reach, true, diagonals)).toBe(true);
  });

  // Reported in game: a 1v1 against a Javelin Colossus on an outer-wall safespot. The javelins force
  // you off your tile, and here every tile you can step to is one the Manticore can see, so dodging
  // makes it a 2v1. (31,11) with these mobs is exactly that spot - the solver has to go elsewhere.
  test("doesn't fight a Javelin in a wall nook with nowhere to dodge", () => {
    const { los, solved } = solve(
      [
        [28, 10, NPC_TYPES.JAVELIN_COLOSSUS],
        [28, 14, NPC_TYPES.MANTICORE, "r"],
      ],
      [31, 11],
    );
    expect(solved).toBe(true);
    const { px, py, visible } = settle(los);
    expect([px, py]).not.toEqual([31, 11]);
    expect(visible).toHaveLength(1);
    const { reach, diagonals } = WEAPON_MODES[DEFAULT_WEAPON_MODE];
    const [x, y, t] = visible[0];
    expect(los.hasLOS(x, y, px, py, NPC_INFO[t].size, reach, true, diagonals)).toBe(true);
  });

  test("the 1v1 doesn't leave you exposed once the target is dead", () => {
    const { los, solved } = solve(
      [
        [22, 22, NPC_TYPES.MANTICORE, "r"],
        [25, 20, NPC_TYPES.REINFORCEMENT_SHAMAN],
        [25, 22, NPC_TYPES.JAGUAR_WARRIOR],
      ],
      [24, 26],
    );
    expect(solved).toBe(true);
    const { px, py, visible } = settle(los);
    expect(visible).toHaveLength(1);

    const { reach, diagonals } = WEAPON_MODES[DEFAULT_WEAPON_MODE];
    los.removeMob(los._getMobs().indexOf(visible[0]));
    // Charge state is keyed by mob index, which the removal shifts. Only movement matters here.
    los.manticoreTicksRemaining = {};
    const holdFor = (x: number, y: number, ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        los._setSelected([x, y], 0);
        los.step();
      }
    };
    holdFor(px, py, 8);
    const left = visibleFrom(los, px, py);
    expect(left.length).toBeLessThanOrEqual(1);
    if (left.length === 0) return;

    const next = left[0];
    const canHit = (x: number, y: number) =>
      los.hasLOS(next[0], next[1], x, y, NPC_INFO[next[2]].size, reach, true, diagonals);
    if (canHit(px, py)) return;
    const walk = pathToFirst([px, py], 34, 34, (x, y) => los.isPillar(x, y), canHit)!;
    expect(walk).not.toBeNull();
    for (const [x, y] of runTicks(walk)) holdFor(x, y, 1);
    const [ax, ay] = walk[walk.length - 1];
    holdFor(ax, ay, 8);
    expect(visibleFrom(los, ax, ay)).toEqual([next]);
  });

  // The whole point of the tool. On arrival you switch prayer to protect against the one mob you're
  // fighting, so a second mob of ANY style (a mage too) that can see the end tile is unsafe. Every
  // point-system tweak has to keep this true.
  test.each([
    ["ranger+mage", [[12, 10, NPC_TYPES.JAVELIN_COLOSSUS], [12, 12, NPC_TYPES.SERPENT_SHAMAN]]],
    ["ranger+shockwave", [[12, 10, NPC_TYPES.JAVELIN_COLOSSUS], [16, 10, NPC_TYPES.SHOCKWAVE_COLOSSUS]]],
    ["melee+ranger", [[12, 10, NPC_TYPES.JAVELIN_COLOSSUS], [12, 12, NPC_TYPES.JAGUAR_WARRIOR]]],
    ["minotaur+mage", [[12, 10, NPC_TYPES.MINOTAUR], [12, 12, NPC_TYPES.SERPENT_SHAMAN]]],
    ["shockwave+mage", [[12, 10, NPC_TYPES.SHOCKWAVE_COLOSSUS], [12, 12, NPC_TYPES.SERPENT_SHAMAN]]],
    ["triple mage", [[12, 9, NPC_TYPES.SERPENT_SHAMAN], [12, 11, NPC_TYPES.SERPENT_SHAMAN], [13, 10, NPC_TYPES.SERPENT_SHAMAN]]],
    ["jaguar pair", [[12, 9, NPC_TYPES.JAGUAR_WARRIOR], [12, 12, NPC_TYPES.JAGUAR_WARRIOR]]],
    ["2 manticores+javelin", [[11, 11, NPC_TYPES.MANTICORE, "u"], [11, 8, NPC_TYPES.MANTICORE, "m"], [14, 10, NPC_TYPES.JAVELIN_COLOSSUS]]],
    ["minotaur+ranger+mage", [[12, 10, NPC_TYPES.MINOTAUR], [16, 10, NPC_TYPES.JAVELIN_COLOSSUS], [12, 12, NPC_TYPES.SERPENT_SHAMAN]]],
    ["4-stack", [[12, 8, NPC_TYPES.JAVELIN_COLOSSUS], [12, 10, NPC_TYPES.SERPENT_SHAMAN], [12, 12, NPC_TYPES.JAGUAR_WARRIOR], [15, 11, NPC_TYPES.MANTICORE, "r"]]],
    ["ranger+melee+2 mages", [[12, 8, NPC_TYPES.JAVELIN_COLOSSUS], [12, 12, NPC_TYPES.JAGUAR_WARRIOR], [15, 9, NPC_TYPES.SERPENT_SHAMAN], [15, 13, NPC_TYPES.SHOCKWAVE_COLOSSUS]]],
  ] as Array<[string, Placement[]]>)("never ends with more than one mob able to hit you (%s)", (_label, stack) => {
    const { los, solved } = solve(stack, [6, 9]);
    if (!solved) return;
    expect(settle(los).visible.length).toBeLessThanOrEqual(1);
  });

  // The player is melee-only, so an isolated fight is worthless unless the target is actually in
  // reach. Two separate bugs produced unwinnable solves: scoring a distant ranged mob as a clean 1v1,
  // and ignoring the weapon's reach when deciding what counts as attackable.
  test.each(Object.keys(WEAPON_MODES) as WeaponMode[])(
    "isolates a ranger+mage 2-stack into a target reachable with %s",
    (mode) => {
      const { reach, diagonals } = WEAPON_MODES[mode];
      const { los, solved } = solve(
        [
          [12, 10, NPC_TYPES.JAVELIN_COLOSSUS],
          [12, 12, NPC_TYPES.SERPENT_SHAMAN],
        ],
        [6, 9],
        mode,
      );
      expect(solved).toBe(true);

      const { px, py, visible } = settle(los);
      expect(visible).toHaveLength(1);
      const target = visible[0];
      expect(los.hasLOS(target[0], target[1], px, py, NPC_INFO[target[2]].size, reach, true, diagonals)).toBe(true);
      expect(los.solveEndAttackable).toBe(true);
    },
  );

  // Myopia keeps the halberd's diagonal attack while cutting it to 1 tile, so it must accept
  // diagonal kill tiles that a standard 1-tile weapon cannot use.
  test("myopia halberd can attack diagonally, standard melee cannot", () => {
    const mob = [15, 15, NPC_TYPES.SERPENT_SHAMAN] as const;
    const diagonalTile: [number, number] = [14, 14]; // open ground, clear of every pillar
    const los = new LineOfSight() as any;
    los._setSelected([mob[0], mob[1]], mob[2]);
    los.place();

    const reachOf = (mode: WeaponMode) => {
      const { reach, diagonals } = WEAPON_MODES[mode];
      return los.hasLOS(mob[0], mob[1], diagonalTile[0], diagonalTile[1], 1, reach, true, diagonals);
    };

    expect(reachOf("halberdMyopia")).toBe(true);
    expect(reachOf("halberd")).toBe(true);
    expect(reachOf("standard")).toBe(false);
  });

  // Pillar running: the payoff only shows up tens of ticks after a short route has merely broken
  // line of sight, so an over-weighted path-length penalty made standing still always win. With Myopia
  // the Javelin settles 2 tiles away and no step-in stays a 1v1, so this uses full halberd reach.
  test("does not degenerate to a stand-still path when pillar running is the answer", () => {
    const { los, solved } = solve(
      [
        [11, 11, NPC_TYPES.MANTICORE, "u"],
        [11, 8, NPC_TYPES.MANTICORE, "m"],
        [14, 10, NPC_TYPES.JAVELIN_COLOSSUS],
      ],
      [6, 9],
      "halberd",
    );
    expect(solved).toBe(true);
    expect(los.suggestedPath.length).toBeGreaterThan(1);

    const { px, py, visible } = settle(los);
    expect(Math.abs(px - 6) + Math.abs(py - 9)).toBeGreaterThan(4);
    expect(visible.length).toBeLessThanOrEqual(1);
  });

  // The numbered dots are only useful if clicking exactly those tiles, in order, walks the route the
  // solver simulated - with the game's own pathing filling in everything between clicks.
  test.each([
    ["pillar run", [[11, 11, NPC_TYPES.MANTICORE, "u"], [11, 8, NPC_TYPES.MANTICORE, "m"], [14, 10, NPC_TYPES.JAVELIN_COLOSSUS]]],
    ["4-stack", [[12, 8, NPC_TYPES.JAVELIN_COLOSSUS], [12, 10, NPC_TYPES.SERPENT_SHAMAN], [12, 12, NPC_TYPES.JAGUAR_WARRIOR], [15, 11, NPC_TYPES.MANTICORE, "r"]]],
  ] as Array<[string, Placement[]]>)("clicking the dots reproduces the solved replay (%s)", (_label, stack) => {
    const start: [number, number] = [6, 9];
    const { los, solved } = solve(stack, start, "halberd");
    expect(solved).toBe(true);

    const expected: [number, number][] = [start];
    let at = start;
    for (const { tile, wait } of los.suggestedClicks) {
      const leg = pathTo(buildPathTree(at, 34, 34, (x, y) => los.isPillar(x, y)), tile)!;
      expected.push(...(runTicks(leg) as [number, number][]));
      for (let i = 0; i < wait; i++) expected.push(tile);
      at = tile;
    }

    expect(los.replay.slice(0, expected.length)).toEqual(expected);
    expect(los.suggestedPath[los.suggestedPath.length - 1]).toEqual(at);
  });

  // Several threats hitting on the same tick is what kills a no-flick tank. Saving a click by running
  // straight through this stack faced all three at once. The lure it picks instead can have a couple of
  // ticks with two threats: the lure that never did fell apart if you clicked back a tick early.
  test("doesn't run through stacked threats to save a click", () => {
    const { los, solved } = solve(
      [
        [12, 8, NPC_TYPES.JAVELIN_COLOSSUS],
        [12, 10, NPC_TYPES.SERPENT_SHAMAN],
        [12, 12, NPC_TYPES.JAGUAR_WARRIOR],
        [15, 11, NPC_TYPES.MANTICORE, "r"],
      ],
      [6, 9],
    );
    expect(solved).toBe(true);

    let peak = 0;
    for (let i = 0; i < los.replay.length; i++) {
      los.step();
      const [px, py] = los.selected;
      peak = Math.max(peak, threatsOf(visibleFrom(los, px, py)).length);
    }
    expect(peak).toBeLessThanOrEqual(2);
  });

  // Once the route runs out you keep stepping from the end tile to watch the fight play out, instead of
  // the replay snapping back to the start.
  test("stepping past the end of a solve holds the end tile", () => {
    const { los, solved } = solve(
      [
        [12, 10, NPC_TYPES.JAVELIN_COLOSSUS],
        [12, 12, NPC_TYPES.SERPENT_SHAMAN],
      ],
      [6, 9],
    );
    expect(solved).toBe(true);

    const replay = los.replay as [number, number][];
    for (let i = 0; i < replay.length; i++) los.step();
    const end = [...los.selected];

    for (let i = 0; i < 10; i++) los.step();
    expect(los.selected).toEqual(end);
    expect(los.replayTick).toBe(replay.length + 10);
    expect(los.tickCount).toBe(replay.length + 10);
  });

  // Minotaurs heal other NPCs, so killing one first is almost always correct.
  test("prioritises the minotaur over the mob it would heal", () => {
    const { los, solved } = solve(
      [
        [12, 12, NPC_TYPES.SERPENT_SHAMAN],
        [13, 10, NPC_TYPES.MINOTAUR],
      ],
      [6, 9],
    );
    expect(solved).toBe(true);

    const { visible } = settle(los);
    expect(visible).toHaveLength(1);
    expect(visible[0][2]).toBe(NPC_TYPES.MINOTAUR);
  });

  // Solarflare's orb circles every pillar. A few timed ticks on a pillar tile are fine, but the fight
  // itself shouldn't happen there when an off-pillar 1v1 exists.
  test("with Solarflare on, doesn't end the solve next to a pillar", () => {
    const stack: Placement[] = [
      [12, 10, NPC_TYPES.JAVELIN_COLOSSUS],
      [12, 12, NPC_TYPES.SERPENT_SHAMAN],
    ];
    const off = solve(stack, [6, 9]);
    const on = solve(stack, [6, 9], DEFAULT_WEAPON_MODE, true);
    expect(off.solved && on.solved).toBe(true);

    const offEnd = settle(off.los);
    expect(off.los.isOnSolarflareOrbit(offEnd.px, offEnd.py)).toBe(true);

    const onEnd = settle(on.los);
    expect(on.los.isOnSolarflareOrbit(onEnd.px, onEnd.py)).toBe(false);
    expect(onEnd.visible).toHaveLength(1);
  });

  // Here every tile in 1-tile reach of the Javelin, walked to straight from where it first settles,
  // pulls another mob into view. "Step in" used to be recommended anyway.
  test("never recommends a step-in that pulls another mob into view", () => {
    const { los, solved } = solve(
      [
        [11, 11, NPC_TYPES.MANTICORE, "u"],
        [11, 8, NPC_TYPES.MANTICORE, "m"],
        [14, 10, NPC_TYPES.JAVELIN_COLOSSUS],
      ],
      [6, 9],
    );
    expect(solved).toBe(true);
    expect(los.solveSummary).not.toContain("step in");

    const { px, py, visible } = settle(los);
    expect(visible.length).toBeLessThanOrEqual(1);
    if (visible.length === 1) {
      const [x, y, t] = visible[0];
      const { reach, diagonals } = WEAPON_MODES[DEFAULT_WEAPON_MODE];
      expect(los.hasLOS(x, y, px, py, NPC_INFO[t].size, reach, true, diagonals)).toBe(true);
    }
  });

  // With a 2-tile halberd the Javelin settles just out of reach behind the SE pillar. Standing while it
  // walks in and then shuffling a tile pulls it round the corner into a clean 1v1.
  test("finds a wait-and-shuffle follow-up to bring an out-of-reach target in", () => {
    const { los, solved } = solve(
      [
        [11, 10, NPC_TYPES.JAVELIN_COLOSSUS],
        [14, 10, NPC_TYPES.MANTICORE, "r"],
        [17, 10, NPC_TYPES.SHOCKWAVE_COLOSSUS],
      ],
      [7, 9],
      "halberd",
    );
    expect(solved).toBe(true);
    expect(los.solveTone).toBe("good");
    expect(los.suggestedClicks.length).toBeGreaterThanOrEqual(2);

    const { px, py, visible } = settle(los);
    expect(visible).toHaveLength(1);
    const [x, y, t] = visible[0];
    const { reach, diagonals } = WEAPON_MODES.halberd;
    expect(los.hasLOS(x, y, px, py, NPC_INFO[t].size, reach, true, diagonals)).toBe(true);
  });

  // With a 1-tile weapon the same stack needs the shuffle and then one more step in, which is a
  // follow-up of a follow-up.
  test.each(["halberdMyopia", "standard"] as WeaponMode[])(
    "chains a second follow-up to finish the 1v1 with %s",
    (mode) => {
      const { los, solved } = solve(
        [
          [11, 10, NPC_TYPES.JAVELIN_COLOSSUS],
          [14, 10, NPC_TYPES.MANTICORE, "r"],
          [17, 10, NPC_TYPES.SHOCKWAVE_COLOSSUS],
        ],
        [7, 9],
        mode,
      );
      expect(solved).toBe(true);
      expect(los.solveTone).toBe("good");

      const { px, py, visible } = settle(los);
      expect(visible).toHaveLength(1);
      const [x, y, t] = visible[0];
      const { reach, diagonals } = WEAPON_MODES[mode];
      expect(los.hasLOS(x, y, px, py, NPC_INFO[t].size, reach, true, diagonals)).toBe(true);
    },
  );

  // Both of these solve at 2 tiles with a halberd. With a 1-tile weapon you have to let the target walk
  // over first and then step in one tile, which needs a long wait and enough simulated ticks after it.
  test.each([
    ["2 manticores+javelin", [[11, 11, NPC_TYPES.MANTICORE, "u"], [11, 8, NPC_TYPES.MANTICORE, "m"], [14, 10, NPC_TYPES.JAVELIN_COLOSSUS]]],
    ["javelin+shockwave", [[12, 10, NPC_TYPES.JAVELIN_COLOSSUS], [16, 10, NPC_TYPES.SHOCKWAVE_COLOSSUS]]],
  ] as Array<[string, Placement[]]>)("waits for the target then steps in with a 1-tile weapon (%s)", (_label, stack) => {
    const { los, solved } = solve(stack, [6, 9], "halberdMyopia");
    expect(solved).toBe(true);
    expect(los.solveTone).toBe("good");

    const { px, py, visible } = settle(los);
    expect(visible).toHaveLength(1);
    const [x, y, t] = visible[0];
    const { reach, diagonals } = WEAPON_MODES.halberdMyopia;
    expect(los.hasLOS(x, y, px, py, NPC_INFO[t].size, reach, true, diagonals)).toBe(true);
  });

  // In game a Shaman stepped behind the NW pillar instead of walking round it, because the plan needed
  // the click back to land on the exact tick. The chosen plan has to survive each click being a tick
  // early or late, and the start being a tick late.
  test("picks a solve that survives each click being a tick early or late", () => {
    const stack: Placement[] = [
      [8, 11, NPC_TYPES.REINFORCEMENT_SHAMAN],
      [9, 13, NPC_TYPES.JAVELIN_COLOSSUS],
      [9, 16, NPC_TYPES.MANTICORE, "r"],
    ];
    const start: [number, number] = [9, 7];
    const { los, solved } = solve(stack, start);
    expect(solved).toBe(true);
    expect(los.solveSummary).not.toContain("Tight timing");

    type PlanClick = { tile: [number, number]; wait: number; early?: boolean };
    const clicks = los.suggestedClicks as PlanClick[];
    const variants: Array<{ plan: PlanClick[]; delay: number }> = [];
    if (clicks.length > 0) variants.push({ plan: clicks, delay: 1 });
    for (let i = 0; i < clicks.length - 1; i++) {
      variants.push({ plan: clicks.map((c, j) => (j === i ? { ...c, wait: c.wait + 1 } : c)), delay: 0 });
      variants.push({
        plan: clicks.map((c, j) => (j === i ? (c.wait > 0 ? { ...c, wait: c.wait - 1 } : { ...c, early: true }) : c)),
        delay: 0,
      });
    }

    const { reach, diagonals } = WEAPON_MODES[DEFAULT_WEAPON_MODE];
    for (const { plan, delay } of variants) {
      const engine = new LineOfSight() as any;
      for (const [x, y, type, extra] of stack) {
        engine._setSelected([x, y], type, extra ?? null);
        engine.place();
      }
      const path: [number, number][] = [start];
      for (let d = 0; d < delay; d++) path.push(start);
      let at = start;
      for (const c of plan) {
        let ticks = runTicks(pathTo(buildPathTree(at, 34, 34, (x, y) => engine.isPillar(x, y)), c.tile)!) as [number, number][];
        if (c.early && ticks.length > 1) ticks = ticks.slice(0, -1);
        path.push(...ticks);
        if (ticks.length) at = ticks[ticks.length - 1];
        for (let w = 0; w < c.wait; w++) path.push(at);
      }
      for (let t = 0; t < path.length + 40; t++) {
        engine._setSelected(path[Math.min(t, path.length - 1)], 0);
        engine.step();
      }
      const visible = visibleFrom(engine, at[0], at[1]);
      expect(visible).toHaveLength(1);
      const [mx, my, mt] = visible[0];
      expect(engine.hasLOS(mx, my, at[0], at[1], NPC_INFO[mt].size, reach, true, diagonals)).toBe(true);
    }
  });

  // The banner shows the expected damage on the way for whichever prayer you run with.
  test("shows a damage estimate for either run prayer", () => {
    const stack: Placement[] = [
      [12, 10, NPC_TYPES.JAVELIN_COLOSSUS],
      [12, 12, NPC_TYPES.SERPENT_SHAMAN],
    ];
    const damageOf = (prayer: "magic" | "ranged") => {
      const los = new LineOfSight() as any;
      los.applySettings({
        weaponMode: DEFAULT_WEAPON_MODE,
        solarflare: false,
        runPrayer: prayer,
        defence: { stab: 467, slash: 468, crush: 452, magic: -21, ranged: 545, defenceLevel: 99, magicLevel: 99, justiciar: true, piety: false },
      });
      for (const [x, y, type] of stack) {
        los._setSelected([x, y], type);
        los.place();
      }
      los._setSelected([6, 9], 0);
      los.solveAndDrawTankPath();
      const match = /About (\d+) damage/.exec(los.solveRoute ?? "");
      return match ? Number(match[1]) : null;
    };
    const mage = damageOf("magic");
    const range = damageOf("ranged");
    expect(mage).not.toBeNull();
    expect(range).not.toBeNull();
  });

  // The banner has to say which prayer to switch to, since the route is run on Protect from Magic.
  test("names the protection prayer for the 1v1", () => {
    const { los, solved } = solve([[12, 9, NPC_TYPES.JAGUAR_WARRIOR], [12, 12, NPC_TYPES.JAGUAR_WARRIOR]], [6, 9]);
    expect(solved).toBe(true);
    expect(los.solveSummary).toContain("Pray melee");
  });
});
