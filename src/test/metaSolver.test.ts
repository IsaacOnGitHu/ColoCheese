import { describe, expect, test } from "vitest";
import { LineOfSight } from "../lineOfSight";
import { DEFAULT_WEAPON_MODE, NPC_INFO, NPC_TYPES as N, WEAPON_MODES } from "../constants";
import { describeRhythm, flickPlan, readTimeline, tickPrayer, type TimelineAttack } from "../metaSolver";

const attack = (mob: number, style: TimelineAttack["style"], extra: Partial<TimelineAttack> = {}): TimelineAttack => ({
  mob,
  type: N.SERPENT_SHAMAN,
  style,
  orb: false,
  knownStyle: true,
  ...extra,
});

describe("meta solve: reading and judging the attack timeline", () => {
  test("reads attacks and Manticore orb styles off the engine tape", () => {
    // bit 0 = attacked; for a Manticore bits 8-15 are the orb (0 range, 1 mage, 2 melee); high bits are position
    const idle = (5 << 16) | (7 << 24);
    const tape = [
      [1 | idle, idle],
      [idle, 1 | (1 << 8) | idle],
    ];
    const timeline = readTimeline(tape, [N.JAVELIN_COLOSSUS, N.MANTICORE], [true, true]);
    expect(timeline[0]).toEqual([{ mob: 0, type: N.JAVELIN_COLOSSUS, style: "ranged", orb: false, knownStyle: true }]);
    expect(timeline[1]).toEqual([{ mob: 1, type: N.MANTICORE, style: "magic", orb: true, knownStyle: true }]);
  });

  test("one style per tick flicks; two styles on a tick clash", () => {
    expect(tickPrayer([])).toEqual({ prayer: null, clash: false });
    expect(tickPrayer([attack(0, "magic"), attack(1, "magic")])).toEqual({ prayer: "magic", clash: false });
    expect(tickPrayer([attack(0, "magic"), attack(1, "ranged")]).clash).toBe(true);
    // a known orb landing with a same-style attack is covered by one prayer
    expect(tickPrayer([attack(0, "ranged", { orb: true }), attack(1, "ranged")]).clash).toBe(false);
  });

  test("an orb of unknown style can't share a tick with anything", () => {
    const unknownOrb = attack(0, "melee", { orb: true, knownStyle: false, type: N.MANTICORE });
    expect(tickPrayer([unknownOrb])).toEqual({ prayer: "orbs", clash: false });
    expect(tickPrayer([unknownOrb, attack(1, "melee")]).clash).toBe(true);
  });

  test("counts prayer switches, and which ones need a 1-tick flick", () => {
    const at = (entries: Array<[number, TimelineAttack]>) => {
      const timeline: TimelineAttack[][] = Array.from({ length: 12 }, () => []);
      for (const [tick, a] of entries) timeline[tick].push(a);
      return timeline;
    };
    const relaxed = flickPlan(
      at([
        [0, attack(0, "ranged")],
        [2, attack(1, "magic")],
        [5, attack(0, "ranged")],
        [7, attack(1, "magic")],
      ]),
      0,
      12,
    );
    expect(relaxed).toMatchObject({ clashes: 0, switches: 3, tightSwitches: 0 });

    const tight = flickPlan(
      at([
        [0, attack(0, "ranged")],
        [1, attack(1, "magic")],
      ]),
      0,
      12,
    );
    expect(tight.tightSwitches).toBe(1);

    // A Manticore's own orbs come on consecutive ticks by design: that's flicking its orbs, not a
    // 1-tick flick between mobs.
    const orb = (style: TimelineAttack["style"]) => attack(2, style, { orb: true, type: N.MANTICORE });
    const orbs = flickPlan(
      at([
        [0, orb("ranged")],
        [1, orb("magic")],
        [2, orb("melee")],
      ]),
      0,
      12,
    );
    expect(orbs).toMatchObject({ switches: 2, tightSwitches: 0 });
  });

  test("describes the rhythm plainly", () => {
    const seq = (items: Array<[number, "magic" | "ranged" | "melee" | "orbs"]>) =>
      items.map(([tick, prayer]) => ({ tick, prayer, mobs: [0] }));
    expect(
      describeRhythm(
        seq([
          [0, "ranged"],
          [2, "magic"],
          [5, "ranged"],
          [7, "magic"],
        ]),
        5,
      ),
    ).toBe("Flick: Range → Mage (+2) → repeats every 5 ticks.");
    expect(
      describeRhythm(
        seq([
          [0, "magic"],
          [3, "magic"],
        ]),
        5,
      ),
    ).toBe("Pray Mage the whole time.");
    expect(describeRhythm(seq([[0, "orbs"]]), 10)).toBe("Flick the Manticore's orbs.");
  });
});

type Placement = [number, number, number, (string | null)?];

function meta(placements: Placement[], start: [number, number]) {
  const los = new LineOfSight() as any;
  los.weaponMode = DEFAULT_WEAPON_MODE;
  for (const [x, y, type, extra] of placements) {
    los._setSelected([x, y], type, extra ?? null);
    los.place();
  }
  los._setSelected(start, 0);
  const mobsAtStart = JSON.parse(JSON.stringify(los.mobs));
  los.solveMeta();
  return { los, mobsAtStart };
}

// Deliberately separate from metaSolver.ts: its own style table and its own tape decoding, so a bug
// there can't hide itself here.
const STYLE: Record<number, string> = {
  [N.SERPENT_SHAMAN]: "magic",
  [N.REINFORCEMENT_SHAMAN]: "magic",
  [N.SHOCKWAVE_COLOSSUS]: "magic",
  [N.JAVELIN_COLOSSUS]: "ranged",
  [N.JAGUAR_WARRIOR]: "melee",
  [N.MINOTAUR]: "melee",
};
const ORB = ["ranged", "magic", "melee"];

/** Replays a solve through a fresh engine and reports what actually happens after arrival. */
function replay(los: any, mobsAtStart: any[]) {
  const routeLength = los.replay.length - 15; // the solver appends 15 display ticks after arrival
  const path = los.replay.slice(0, routeLength);
  for (let i = 0; i < 40; i++) path.push(path[routeLength - 1]);
  const sim = new LineOfSight() as any;
  sim.mobs = JSON.parse(JSON.stringify(mobsAtStart));
  sim.replay = path;
  sim.replayTick = 0;
  sim.selected = [...path[0]];
  for (let i = 0; i < path.length; i++) sim.step();

  const known = mobsAtStart.map((m: any) => m[2] !== N.MANTICORE || (m[6] && m[6] !== "u"));
  let clashes = 0;
  const attackedAfterArrival = new Set<number>();
  for (let t = routeLength - 1 + 5; t < sim.tape.length; t++) {
    const tokens = new Set<string>();
    let count = 0;
    sim.tape[t].forEach((v: number, i: number) => {
      if (!(v & 1)) return;
      count++;
      attackedAfterArrival.add(i);
      const type = mobsAtStart[i][2];
      tokens.add(type === N.MANTICORE ? (known[i] ? ORB[(v >> 8) & 0xff] : "orb?") : STYLE[type]);
    });
    if (tokens.size > 1 || (tokens.has("orb?") && count > 1)) clashes++;
  }
  const [px, py] = sim.selected;
  const { reach, diagonals } = WEAPON_MODES[DEFAULT_WEAPON_MODE];
  const inReach = sim.mobs.filter((m: any) =>
    sim.hasLOS(m[0], m[1], px, py, NPC_INFO[m[2]].size, reach, true, diagonals),
  );
  return { clashes, inReach, attackedAfterArrival };
}

const STACKS: Array<[string, Placement[], [number, number]]> = [
  ["ranger+mage", [[12, 10, N.JAVELIN_COLOSSUS], [12, 12, N.SERPENT_SHAMAN]], [6, 9]],
  ["ranger+shockwave", [[12, 10, N.JAVELIN_COLOSSUS], [16, 10, N.SHOCKWAVE_COLOSSUS]], [6, 9]],
  ["melee+ranger", [[12, 10, N.JAVELIN_COLOSSUS], [12, 12, N.JAGUAR_WARRIOR]], [6, 9]],
  ["minotaur+mage", [[12, 10, N.MINOTAUR], [12, 12, N.SERPENT_SHAMAN]], [6, 9]],
  ["triple mage", [[12, 9, N.SERPENT_SHAMAN], [12, 11, N.SERPENT_SHAMAN], [13, 10, N.SERPENT_SHAMAN]], [6, 9]],
  ["jaguar pair", [[12, 9, N.JAGUAR_WARRIOR], [12, 12, N.JAGUAR_WARRIOR]], [6, 9]],
  ["mino+ranger+mage", [[12, 10, N.MINOTAUR], [16, 10, N.JAVELIN_COLOSSUS], [12, 12, N.SERPENT_SHAMAN]], [6, 9]],
  [
    "4-stack",
    [[12, 8, N.JAVELIN_COLOSSUS], [12, 10, N.SERPENT_SHAMAN], [12, 12, N.JAGUAR_WARRIOR], [15, 11, N.MANTICORE, "r"]],
    [6, 9],
  ],
  [
    "ranger+melee+2 mages",
    [[12, 8, N.JAVELIN_COLOSSUS], [12, 12, N.JAGUAR_WARRIOR], [15, 9, N.SERPENT_SHAMAN], [15, 13, N.SHOCKWAVE_COLOSSUS]],
    [6, 9],
  ],
  ["timing NW", [[8, 11, N.REINFORCEMENT_SHAMAN], [9, 13, N.JAVELIN_COLOSSUS], [9, 16, N.MANTICORE, "r"]], [9, 7]],
  ["wall nook", [[22, 22, N.MANTICORE, "r"], [25, 20, N.REINFORCEMENT_SHAMAN], [25, 22, N.JAGUAR_WARRIOR]], [24, 26]],
];

describe("meta solve through the engine", () => {
  // The promise every meta solve makes: once you've arrived, every tick is flickable with one prayer
  // and there's something you can hit. Checked by replaying it through a fresh engine.
  test.each(STACKS)("what it promises is what the engine does (%s)", (_label, stack, start) => {
    const { los, mobsAtStart } = meta(stack, start);
    expect(los.suggestedPath).not.toBeNull();
    const { clashes, inReach } = replay(los, mobsAtStart);
    expect(clashes).toBe(0);
    expect(inReach.length).toBeGreaterThan(0);
    // The route may begin by walking to a hidden tile; either way the replay covers the whole thing.
    expect(los.replay[0]).toEqual(start);
  });

  test("goes for the Minotaur and off-ticks the rest", () => {
    const { los } = meta([[12, 10, N.MINOTAUR], [16, 10, N.JAVELIN_COLOSSUS], [12, 12, N.SERPENT_SHAMAN]], [6, 9]);
    expect(los.solveSummary).toContain("off-ticked");
    expect(los.solveSummary).toContain("Attack the Minotaur");
  });

  test("three mages need no flicking at all", () => {
    const { los } = meta([[12, 9, N.SERPENT_SHAMAN], [12, 11, N.SERPENT_SHAMAN], [13, 10, N.SERPENT_SHAMAN]], [6, 9]);
    expect(los.solveSummary).toContain("on you");
    expect(los.solveSummary).toContain("Pray Mage the whole time");
  });

  // Some stacks only come apart if you step out, let something fire, and step back - the shape the
  // community guide calls a Z-stack. One click can't do it.
  test("builds a route of several clicks when one won't do", () => {
    const stack: Placement[] = [
      [11, 11, N.JAVELIN_COLOSSUS],
      [11, 8, N.JAVELIN_COLOSSUS],
      [14, 10, N.MANTICORE, "m"],
    ];
    const { los, mobsAtStart } = meta(stack, [7, 9]);
    expect(los.suggestedPath).not.toBeNull();
    expect(los.suggestedClicks.length).toBeGreaterThan(1);
    const { clashes, inReach } = replay(los, mobsAtStart);
    expect(clashes).toBe(0);
    expect(inReach.length).toBeGreaterThan(0);
  });

  // Melee mobs can't hit diagonally, but a halberd can. The solver uses that to fight a Jaguar it
  // never has to pray against - check the Jaguar really never lands an attack.
  test("diagonal safespot: fights the Jaguar without it ever attacking", () => {
    const stack: Placement[] = [
      [12, 8, N.JAVELIN_COLOSSUS],
      [12, 12, N.JAGUAR_WARRIOR],
      [15, 9, N.SERPENT_SHAMAN],
      [15, 13, N.SHOCKWAVE_COLOSSUS],
    ];
    const { los, mobsAtStart } = meta(stack, [6, 9]);
    expect(los.solveSummary).toContain("Attack the Jaguar Warrior");
    const { attackedAfterArrival, inReach } = replay(los, mobsAtStart);
    const jaguar = mobsAtStart.findIndex((m: any) => m[2] === N.JAGUAR_WARRIOR);
    expect(attackedAfterArrival.has(jaguar)).toBe(false);
    expect(inReach.some((m: any) => m[2] === N.JAGUAR_WARRIOR)).toBe(true);
  });
});
