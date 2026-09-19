// Meta Solve: instead of isolating one mob, leave several attacking you on different ticks and flick
// protection prayers so every attack is prayed. This file is the pure part - reading the engine's
// attack timeline and judging whether it can be flicked. The route search lives in LineOfSight.

import { NPC_TYPES } from "./constants";
import type { PrayerStyle } from "./damageModel";

/** One attack launched on a tick, read off the engine's tape. */
export type TimelineAttack = {
  mob: number;
  type: number;
  style: PrayerStyle;
  /** A Manticore orb. Its style is only trustworthy when the Manticore's pattern was known. */
  orb: boolean;
  knownStyle: boolean;
};

// Every mob but the Manticore attacks with one style.
export const MOB_STYLE: Record<number, PrayerStyle> = {
  [NPC_TYPES.SERPENT_SHAMAN]: "magic",
  [NPC_TYPES.REINFORCEMENT_SHAMAN]: "magic",
  [NPC_TYPES.JAVELIN_COLOSSUS]: "ranged",
  [NPC_TYPES.SHOCKWAVE_COLOSSUS]: "magic",
  [NPC_TYPES.JAGUAR_WARRIOR]: "melee",
  [NPC_TYPES.MINOTAUR]: "melee",
};

// The engine stores a Manticore orb as an index into MANTICORE_ATTACKS: lime, blue, red.
const ORB_STYLES: PrayerStyle[] = ["ranged", "magic", "melee"];

/**
 * Attacks launched on each tick. `tape[t][i]` is the engine's record for mob i on tick t: bit 0 set
 * means it attacked, and for a Manticore bits 8-15 hold the orb's style.
 */
export function readTimeline(tape: number[][], types: number[], knownPattern: boolean[]): TimelineAttack[][] {
  return tape.map((line) => {
    const attacks: TimelineAttack[] = [];
    line.forEach((value, mob) => {
      if (!(value & 1)) return;
      const type = types[mob];
      if (type === NPC_TYPES.MANTICORE) {
        attacks.push({ mob, type, style: ORB_STYLES[(value >> 8) & 0xff] ?? "magic", orb: true, knownStyle: knownPattern[mob] });
      } else if (MOB_STYLE[type]) {
        attacks.push({ mob, type, style: MOB_STYLE[type], orb: false, knownStyle: true });
      }
    });
    return attacks;
  });
}

/**
 * The prayer a tick needs. It clashes when no single prayer covers everything landing on it: two
 * different styles, or a Manticore orb of unknown style alongside anything else.
 */
export function tickPrayer(attacks: TimelineAttack[]): { prayer: PrayerStyle | "orbs" | null; clash: boolean } {
  if (attacks.length === 0) return { prayer: null, clash: false };
  const unknownOrb = attacks.some((a) => a.orb && !a.knownStyle);
  if (unknownOrb) return attacks.length === 1 ? { prayer: "orbs", clash: false } : { prayer: null, clash: true };
  const styles = new Set(attacks.map((a) => a.style));
  if (styles.size > 1) return { prayer: null, clash: true };
  return { prayer: attacks[0].style, clash: false };
}

export type FlickPlan = {
  clashes: number;
  /** Prayer changes needed across the window. */
  switches: number;
  /** Changes between different mobs on consecutive ticks - a Manticore's own orbs don't count. */
  tightSwitches: number;
  /** Each tick an attack lands, and the prayer it needs. */
  sequence: Array<{ tick: number; prayer: PrayerStyle | "orbs"; mobs: number[] }>;
};

/** How the ticks from `from` up to (not including) `to` would be flicked. */
export function flickPlan(timeline: TimelineAttack[][], from: number, to: number): FlickPlan {
  const plan: FlickPlan = { clashes: 0, switches: 0, tightSwitches: 0, sequence: [] };
  let last: { tick: number; prayer: PrayerStyle | "orbs"; mobs: number[] } | null = null;
  for (let tick = from; tick < Math.min(to, timeline.length); tick++) {
    const attacks = timeline[tick];
    const { prayer, clash } = tickPrayer(attacks);
    if (clash) {
      plan.clashes++;
      continue;
    }
    if (!prayer) continue;
    const entry = { tick, prayer, mobs: attacks.map((a) => a.mob) };
    if (last && last.prayer !== prayer) {
      plan.switches++;
      const sameManticore = entry.mobs.length === 1 && last.mobs.length === 1 && entry.mobs[0] === last.mobs[0];
      if (tick - last.tick === 1 && !sameManticore) plan.tightSwitches++;
    }
    plan.sequence.push(entry);
    last = entry;
  }
  return plan;
}

const PRAYER_NAMES: Record<PrayerStyle | "orbs", string> = {
  magic: "Mage",
  ranged: "Range",
  melee: "Melee",
  orbs: "Manticore orbs",
};

/**
 * One cycle of the steady rhythm, e.g. "Range → Mage (+2) → repeats every 5 ticks". Repeated
 * attacks of the same prayer are folded together, since you just leave it on.
 */
export function describeRhythm(sequence: FlickPlan["sequence"], cycle: number): string {
  if (sequence.length === 0) return "Nothing attacks you here.";
  const first = sequence[0].tick;
  const inCycle = sequence.filter((s) => s.tick < first + cycle);
  const prayers = new Set(inCycle.map((s) => s.prayer));
  if (prayers.size === 1) {
    const only = inCycle[0].prayer;
    return only === "orbs" ? "Flick the Manticore's orbs." : `Pray ${PRAYER_NAMES[only]} the whole time.`;
  }
  const steps: string[] = [];
  let previous: (typeof inCycle)[number] | null = null;
  for (const s of inCycle) {
    if (previous && previous.prayer === s.prayer) continue;
    steps.push(previous ? `${PRAYER_NAMES[s.prayer]} (+${s.tick - previous.tick})` : PRAYER_NAMES[s.prayer]);
    previous = s;
  }
  return `Flick: ${steps.join(" → ")} → repeats every ${cycle} ticks.`;
}
