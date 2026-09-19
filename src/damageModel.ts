import { NPC_TYPES } from "./constants";

export type PrayerStyle = "magic" | "ranged" | "melee";
type HitStyle = "stab" | "slash" | "crush" | "melee" | "magic" | "ranged";

export type PlayerDefence = {
  stab: number;
  slash: number;
  crush: number;
  magic: number;
  ranged: number;
  defenceLevel: number;
  magicLevel: number;
  justiciar: boolean;
  piety: boolean;
};

export const DEFAULT_PLAYER_DEFENCE: PlayerDefence = {
  stab: 467,
  slash: 468,
  crush: 452,
  magic: -21,
  ranged: 545,
  defenceLevel: 99,
  magicLevel: 99,
  justiciar: true,
  piety: false,
};

export const PRAYER_LABELS: Record<PrayerStyle, string> = {
  magic: "Mage",
  ranged: "Range",
  melee: "Melee",
};

// Invocation tiers, 0 = off. Higher tiers include the lower ones, as in game.
export type InvocationTier = 0 | 1 | 2 | 3;
export type Invocations = { relentless: InvocationTier; mantimayhem: InvocationTier };
export const NO_INVOCATIONS: Invocations = { relentless: 0, mantimayhem: 0 };
export const TIER_LABELS = ["Off", "I", "II", "III"] as const;

// Relentless: enemy attacks bypass part of your Defence level and have higher max hits. Tier III
// skips the accuracy roll altogether, so every attack lands.
const RELENTLESS = [
  { defenceBypass: 0, maxHitBonus: 0, alwaysHits: false },
  { defenceBypass: 0.33, maxHitBonus: 1, alwaysHits: false },
  { defenceBypass: 0.66, maxHitBonus: 3, alwaysHits: false },
  { defenceBypass: 1, maxHitBonus: 6, alwaysHits: true },
];

type Hit = { style: HitStyle; level: number; bonus: number; maxHit: number; count?: number };
type NpcAttack = { speed: number; hits: Hit[] };

const SHAMAN: NpcAttack = { speed: 5, hits: [{ style: "magic", level: 220, bonus: 50, maxHit: 28 }] };

// Base stats from the OSRS Wiki, with no invocations active.
const NPC_ATTACKS: Record<number, NpcAttack> = {
  [NPC_TYPES.SERPENT_SHAMAN]: SHAMAN,
  [NPC_TYPES.REINFORCEMENT_SHAMAN]: SHAMAN,
  // Its prayer-ignoring special lands on the tile you were standing on, so it can't hit you mid-run
  // and isn't part of the route estimate.
  [NPC_TYPES.JAVELIN_COLOSSUS]: { speed: 5, hits: [{ style: "ranged", level: 360, bonus: 0, maxHit: 48 }] },
  // Three separate slashes per attack, each rolled on its own.
  [NPC_TYPES.JAGUAR_WARRIOR]: { speed: 5, hits: [{ style: "slash", level: 200, bonus: 25, maxHit: 47, count: 3 }] },
  // One orb of each style per attack. The wiki doesn't say which melee type the last orb is, so it's
  // rolled against your weakest melee defence.
  [NPC_TYPES.MANTICORE]: {
    speed: 10,
    hits: [
      { style: "ranged", level: 350, bonus: 0, maxHit: 36 },
      { style: "magic", level: 300, bonus: 0, maxHit: 31 },
      { style: "melee", level: 300, bonus: 0, maxHit: 31 },
    ],
  },
  [NPC_TYPES.MINOTAUR]: { speed: 5, hits: [{ style: "crush", level: 300, bonus: 15, maxHit: 74 }] },
  [NPC_TYPES.SHOCKWAVE_COLOSSUS]: { speed: 5, hits: [{ style: "magic", level: 350, bonus: 55, maxHit: 56 }] },
};

export function hitChance(attackRoll: number, defenceRoll: number) {
  return attackRoll > defenceRoll
    ? 1 - (defenceRoll + 2) / (2 * (attackRoll + 1))
    : attackRoll / (2 * (defenceRoll + 1));
}

const covers = (prayer: PrayerStyle, style: HitStyle) =>
  prayer === "melee" ? style !== "magic" && style !== "ranged" : prayer === style;

/** True when the prayer blocks every hit this NPC's normal attack does. */
export function isPrayedAgainst(type: number, prayer: PrayerStyle) {
  const attack = NPC_ATTACKS[type];
  return !!attack && attack.hits.every((hit) => covers(prayer, hit.style));
}

function defenceBonus(style: HitStyle, player: PlayerDefence) {
  if (style === "melee") return Math.min(player.stab, player.slash, player.crush);
  return player[style];
}

/** Average damage per tick this NPC deals while it can hit you, with `prayer` up. */
export function expectedDamagePerTick(
  type: number,
  player: PlayerDefence,
  prayer: PrayerStyle,
  invocations: Invocations = NO_INVOCATIONS,
) {
  const attack = NPC_ATTACKS[type];
  if (!attack) return 0;
  return attackDamage(type, player, (style) => covers(prayer, style), invocations) / attack.speed;
}

/**
 * Average damage of the part of one attack that `style`'s prayer would block - what that attack
 * costs you if you're praying something else when it lands. For a Manticore that's its one orb of
 * that style.
 */
export function expectedAttackDamage(
  type: number,
  style: PrayerStyle,
  player: PlayerDefence,
  invocations: Invocations = NO_INVOCATIONS,
) {
  if (!NPC_ATTACKS[type]) return 0;
  return attackDamage(type, player, (hitStyle) => !covers(style, hitStyle), invocations);
}

// Average damage of one attack, skipping the hits `blocked` says are prayed against.
function attackDamage(
  type: number,
  player: PlayerDefence,
  blocked: (style: HitStyle) => boolean,
  invocations: Invocations,
) {
  const attack = NPC_ATTACKS[type];
  const relentless = RELENTLESS[invocations.relentless] ?? RELENTLESS[0];

  // Piety boosts Defence by 25%, which also feeds the 30% Defence share of magic defence.
  // Relentless then bypasses part of that Defence level.
  const boosted = player.piety ? Math.floor(player.defenceLevel * 1.25) : player.defenceLevel;
  const defenceLevel = Math.floor(boosted * (1 - relentless.defenceBypass));

  let perAttack = 0;
  for (const hit of attack.hits) {
    if (blocked(hit.style)) continue;

    const bonus = defenceBonus(hit.style, player);
    const effectiveDefence =
      hit.style === "magic"
        ? Math.floor(0.7 * player.magicLevel + 0.3 * defenceLevel) + 8
        : defenceLevel + 8;
    const attackRoll = (hit.level + 9) * (hit.bonus + 64);
    const defenceRoll = effectiveDefence * Math.max(0, bonus + 64);

    let averageHit = (hit.maxHit + relentless.maxHitBonus) / 2;
    if (player.justiciar) {
      averageHit = Math.max(0, averageHit - Math.max(1, (averageHit * Math.max(0, bonus)) / 3000));
    }
    const chance = relentless.alwaysHits ? 1 : hitChance(attackRoll, defenceRoll);
    perAttack += (hit.count ?? 1) * chance * averageHit;
  }
  // Mantimayhem gives every orb a second projectile.
  if (type === NPC_TYPES.MANTICORE && invocations.mantimayhem > 0) perAttack *= 2;
  return perAttack;
}
