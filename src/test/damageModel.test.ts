import { describe, expect, test } from "vitest";
import { NPC_TYPES } from "../constants";
import {
  DEFAULT_PLAYER_DEFENCE,
  expectedDamagePerTick,
  hitChance,
  isPrayedAgainst,
} from "../damageModel";

const me = DEFAULT_PLAYER_DEFENCE;

describe("damage model", () => {
  test("hit chance uses both branches of the wiki formula", () => {
    expect(hitChance(100, 50)).toBeCloseTo(1 - 52 / 202);
    expect(hitChance(50, 100)).toBeCloseTo(50 / 202);
  });

  test("the prayer blocks its whole style", () => {
    expect(expectedDamagePerTick(NPC_TYPES.SERPENT_SHAMAN, me, "magic")).toBe(0);
    expect(expectedDamagePerTick(NPC_TYPES.SHOCKWAVE_COLOSSUS, me, "magic")).toBe(0);
    expect(expectedDamagePerTick(NPC_TYPES.JAGUAR_WARRIOR, me, "melee")).toBe(0);
    expect(expectedDamagePerTick(NPC_TYPES.MINOTAUR, me, "melee")).toBe(0);
    expect(expectedDamagePerTick(NPC_TYPES.JAGUAR_WARRIOR, me, "magic")).toBeGreaterThan(0);
  });

  // The javelin special lands on the tile you were on, so running dodges it and range prayer blocks
  // everything else.
  test("praying range blocks the javelin on the run", () => {
    expect(expectedDamagePerTick(NPC_TYPES.JAVELIN_COLOSSUS, me, "ranged")).toBe(0);
    expect(expectedDamagePerTick(NPC_TYPES.JAVELIN_COLOSSUS, me, "magic")).toBeGreaterThan(0);
    expect(isPrayedAgainst(NPC_TYPES.JAVELIN_COLOSSUS, "ranged")).toBe(true);
  });

  test("a manticore is never fully prayed against", () => {
    for (const prayer of ["magic", "ranged", "melee"] as const) {
      expect(isPrayedAgainst(NPC_TYPES.MANTICORE, prayer)).toBe(false);
      expect(expectedDamagePerTick(NPC_TYPES.MANTICORE, me, prayer)).toBeGreaterThan(0);
    }
  });

  test("more defence, the Justiciar set and Piety all mean less damage", () => {
    const javelin = (player: typeof me) => expectedDamagePerTick(NPC_TYPES.JAVELIN_COLOSSUS, player, "magic");
    expect(javelin({ ...me, ranged: 200 })).toBeGreaterThan(javelin(me));
    expect(javelin({ ...me, justiciar: false })).toBeGreaterThan(javelin(me));
    expect(javelin({ ...me, piety: true })).toBeLessThan(javelin(me));

    const shaman = (player: typeof me) => expectedDamagePerTick(NPC_TYPES.SERPENT_SHAMAN, player, "ranged");
    expect(shaman({ ...me, piety: true })).toBeLessThan(shaman(me));
  });
});
