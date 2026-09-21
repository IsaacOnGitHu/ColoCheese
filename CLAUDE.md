# Working notes for Colo Cheese

Context an agent needs before touching the solvers. Kept in the repo on purpose: it should outlive
any one chat.

## What this is

A tank-path solver for the OSRS Fortis Colosseum, live at [colocheese.com](https://colocheese.com).
Built on the line-of-sight simulator from [los.colosim.com](https://los.colosim.com) (Backseat and
iFreedive), with the solvers added on top.

The method it serves is the no-flick Justiciar / Dinh's tank: rather than praying against a stack,
you walk somewhere only **one** NPC can see you, put that NPC's protection prayer on, and fight it.
Meta Solve is the opposite, for players who flick.

The audience is players mid-run, under time pressure, on a second monitor. Advice must be short,
concrete and clickable: which tiles, in which order, what to pray. Not a lecture.

## Game mechanics the engine models

Everything runs on game ticks (0.6s).

- **Attacks.** Each mob has a cooldown (`mob[5]`) that ticks down every tick. It attacks the moment
  it has line of sight *and* the cooldown is at or below zero, then resets to `NPC_INFO[type].cd` -
  5 ticks for everything except the Manticore's 10.
- **Movement.** A mob that can't see you walks toward you; one that can see you stands and attacks.
  This is what makes hiding behind a pillar pull mobs to you, and what "destacking" exploits.
- **Manticore.** Charges for `MANTICORE_CHARGE_TIME` (10) ticks on first sight, then fires three orbs
  on consecutive ticks. The order of styles comes from its pattern (`r` = starts ranged, `m` = mage,
  `u` = unknown until it fires). Only one Manticore volley can be in the air per tick: when one
  fires, every other ready Manticore is pushed back `MANTICORE_DELAY` (5) ticks.
- **Melee and diagonals.** Melee NPCs (range 1) cannot attack diagonally, which is what makes corner
  safespots work. A halberd under Myopia is still reach 1 but *can* hit diagonally, so it takes the
  generic line-of-sight path (`allowDiagonal`). The weapon mode matters to nearly every solve.
- **Player movement.** Running covers 2 tiles per tick. Pathing is the game's own: BFS in the order
  W, E, S, N, SW, SE, NW, NE, no corner cutting (`playerPathing.ts`). Solvers must walk candidate
  routes through this, never draw straight lines, or the click count and timing are fiction.
- **Minotaur** heals other NPCs within `MINOTAUR_HEAL_RANGE` (7), so it's almost always the right
  thing to kill first.
- **Solarflare** is one orb circling each pillar, so every tile touching a pillar is in its path.

### Off-ticking (what Meta Solve is for)

Two mobs on the same 5-tick cycle that gain sight of you on the same tick will attack together
forever, and one prayer can't cover two styles. Step to a tile where one sees you a tick before the
other and their cycles stagger permanently - then a single prayer, flicked, covers everything. The
community calls the repeating out-and-back version a **Z-stack**.

### Damage model (`damageModel.ts`)

Standard OSRS rolls: attack `(level + 9) * (bonus + 64)`, defence `effectiveLevel * (bonus + 64)`.
Magic defence is `floor(0.7 * Magic + 0.3 * Defence) + 8`. Piety multiplies defence level by 1.25.
Justiciar reduces each hit by `bonus / 3000` (minimum 1). A protection prayer blocks its style
entirely. Invocations: **Relentless** I/II/III bypasses 33%/66%/100% of defence level and adds
+1/+3/+6 max hit, with III always hitting; **Mantimayhem** doubles Manticore damage.

## Code map

- `lineOfSight.ts` - the engine (`step`, `moveMobs`, `handleManticoreCharging`, `processAttacks`)
  plus both solvers. Large, but the engine and solvers genuinely need each other.
- `metaSolver.ts` - pure logic over the tape: `readTimeline`, `tickPrayer`, `flickPlan`,
  `describeRhythm`. No engine, so it's cheap to test.
- `playerPathing.ts` - `buildPathTree`, `pathTo`, `pathToFirst`, `runTicks`.
- `damageModel.ts` - hit chance, expected damage, invocations.
- `guideSolves.ts` - the community stack guide's own advice, matched by stack *shape*.
- `constants.ts` - NPC stats, weapon modes, Manticore patterns.

**Tape format.** Each tick, per mob: bit 0 = attacked, bits 8-15 = the Manticore orb's style
(0 ranged, 1 magic, 2 melee), bits 16+ = position. Both solvers read fights back out of this.

**Both solvers work the same way**: generate candidate click routes, walk each through a throwaway
copy of the real engine, score the outcome, take the best. Judging a route on anything other than a
real simulation has gone wrong every time it's been tried.

### Solve Tank Path

`solveAndDrawTankPath` → `findTankPlan` per start tile. `hiddenMoves` first: you can start from any
tile you can walk to unseen, so it ranks those and solves from the best one. `isWorthMoving` stops
it swapping a good solve for a sideways one - moving must buy a fight instead of hiding, a Minotaur,
a dropped warning, fewer clicks, or 5+ less damage.

Scoring starts at 100000 and adds: click 1000, tick 10, damage ×50, stacked threat 500, ending on a
Solarflare orbit 20000, Minotaur able to heal the target 40000, target is the Minotaur −5000 (other
target +5000, none −2000), out of reach 10000/tile, exposed after the kill 8000, Javelin you can't
dodge 8000, outer wall 3000, fragile 20000, hiding 30000, two or more visible 80000+, stepping under
a mob 500000.

### Meta Solve

`solveMeta` → candidate routes → `runEngine` → `readTimeline`/`flickPlan`. Candidates are: stay put,
one click nearby, out-and-back, and a **beam search** for longer routes that branches only to tiles
which change who can see you. It stops early when a short route already flicks cleanly for no
damage, which keeps the common case at ~35ms.

A route is rejected outright if any tick after arrival needs two prayers at once, or if nothing ends
up in reach to attack. Scoring: click 1000, tick 10, damage ×50, prayer switch 300, a switch on
consecutive ticks between different mobs 1500 (this is what people actually fumble), Solarflare
20000, Minotaur ∓5000. `holdsUp` re-checks the plan with each click a tick early or late; plans that
don't survive are shown with a "tight timing" warning.

**Known gap:** the guide's true Z-stacks are a repeating dance with no final tile. Our routes arrive
somewhere and hold, so we can't express them, and those stacks fall back to the guide's own text.

## How changes get verified

The solves are the product. Assume any change breaks something until shown otherwise.

1. **Independent re-simulation.** Replay the solve through a fresh engine with its *own* tape
   decoding and style table (see `metaSolver.test.ts`), and assert the promise actually holds: no
   clashing ticks, something in reach, never standing under a mob. Never verify with the same code
   that produced the answer.
2. **Fingerprint before and after.** Solve ~90 seeded random stacks on both versions (git stash or a
   worktree) and diff the output. "Tank solves byte-identical" is the bar for any change that isn't
   meant to touch them.
3. **The guide corpus.** The community guide has 85 real stacks in this tool's URL format - the best
   regression set there is. Meta Solve currently solves 47 of them.
4. A test that can silently pass when no solve is found is not a test. Assert `suggestedPath` is not
   null.

## Conventions

- **Deploy** is `git push origin master` → Cloudflare Workers Builds → colocheese.com. Config in
  `wrangler.jsonc`; `dist` is gitignored and built by CI.
- **No personal name in the repo**, and commits use the GitHub noreply address.
- Source files are **CRLF**. Exact-match patching fails unless you normalise to LF first and write
  the original endings back.
- `.claude/launch.json` (gitignored) starts the dev server on port 5174.
- Tests are vitest: `npm run test`.
- Comments explain *why* a weight or rule exists, in plain language. Match that voice.
