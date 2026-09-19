import { describe, expect, test } from "vitest";
import { NPC_TYPES } from "../constants";
import {
  DEFAULT_PLAYER_DEFENCE,
  expectedDamagePerTick,
  NO_INVOCATIONS,
  type InvocationTier,
  type PrayerStyle,
} from "../damageModel";

const MOBS = Object.values(NPC_TYPES).filter((t) => t !== NPC_TYPES.PLAYER);
const PRAYERS: PrayerStyle[] = ["magic", "ranged", "melee"];
const TIERS: InvocationTier[] = [0, 1, 2, 3];

describe("invocations", () => {
  // Everyone who doesn't touch the new settings must get exactly the numbers they got before.
  test("with both off, every estimate is unchanged", () => {
    for (const mob of MOBS) {
      for (const prayer of PRAYERS) {
        expect(expectedDamagePerTick(mob, DEFAULT_PLAYER_DEFENCE, prayer, NO_INVOCATIONS)).toBe(
          expectedDamagePerTick(mob, DEFAULT_PLAYER_DEFENCE, prayer),
        );
      }
    }
  });

  test("each Relentless tier hurts more than the one below", () => {
    for (const mob of [NPC_TYPES.JAVELIN_COLOSSUS, NPC_TYPES.MINOTAUR, NPC_TYPES.JAGUAR_WARRIOR]) {
      const damage = TIERS.map((relentless) =>
        expectedDamagePerTick(mob, DEFAULT_PLAYER_DEFENCE, "magic", { relentless, mantimayhem: 0 }),
      );
      for (let i = 1; i < damage.length; i++) expect(damage[i]).toBeGreaterThan(damage[i - 1]);
    }
  });

  test("Relentless III skips the accuracy roll: every attack lands", () => {
    // One ranged javelin a 5-tick attack, max hit 48 + 6, average half of that. Justiciar off so
    // the average isn't reduced.
    const player = { ...DEFAULT_PLAYER_DEFENCE, justiciar: false };
    expect(
      expectedDamagePerTick(NPC_TYPES.JAVELIN_COLOSSUS, player, "magic", { relentless: 3, mantimayhem: 0 }),
    ).toBeCloseTo((48 + 6) / 2 / 5, 9);
  });

  test("prayer still blocks everything under Relentless", () => {
    for (const relentless of TIERS) {
      expect(
        expectedDamagePerTick(NPC_TYPES.JAVELIN_COLOSSUS, DEFAULT_PLAYER_DEFENCE, "ranged", { relentless, mantimayhem: 0 }),
      ).toBe(0);
    }
  });

  test("Mantimayhem doubles Manticore damage and nothing else", () => {
    const manticore = expectedDamagePerTick(NPC_TYPES.MANTICORE, DEFAULT_PLAYER_DEFENCE, "magic");
    for (const mantimayhem of [1, 2, 3] as const) {
      expect(
        expectedDamagePerTick(NPC_TYPES.MANTICORE, DEFAULT_PLAYER_DEFENCE, "magic", { relentless: 0, mantimayhem }),
      ).toBeCloseTo(manticore * 2, 9);
      for (const mob of MOBS.filter((m) => m !== NPC_TYPES.MANTICORE)) {
        expect(
          expectedDamagePerTick(mob, DEFAULT_PLAYER_DEFENCE, "magic", { relentless: 0, mantimayhem }),
        ).toBe(expectedDamagePerTick(mob, DEFAULT_PLAYER_DEFENCE, "magic"));
      }
    }
  });
});
