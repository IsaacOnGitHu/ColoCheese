# 🧀 Colo Cheese

Tank path solver for the OSRS Fortis Colosseum — **[colocheese.com](https://colocheese.com)**

No-flick tank paths: load your stack, hit Solve, get a safe 1v1.

## What it does

Survive the spawn, get safe behind a pillar, then load your stack (paste a RuneLite plugin link, or
drag the mobs and yourself onto the map) and hit **Solve Tank Path**. It works out a click route
that pulls exactly one NPC onto you, so you can fight it 1v1 without flicking.

It goes for, in order:

1. Minotaurs first, unless the other NPC is out of its healing range
2. A target that's actually in melee reach (halberd, halberd + myopia, or normal melee)
3. Fewest clicks
4. Least damage

**Meta Solve** does the opposite: instead of isolating one NPC it off-ticks the stack, so every
attack lands on a different tick and one prayer, flicked, covers all of them. Where the community
stack guide covers your stack, its own advice is shown alongside.

The whole plan can be stepped through tick by tick to see how the NPCs react.

## Credit

Built on the Colosseum line of sight tool ([los.colosim.com](https://los.colosim.com)), originally
written by [Backseat](https://bistools.github.io/inferno.html) and
[iFreedive](https://ifreedive-osrs.github.io/). Further built upon for cheese tanking.

Off-tick rhythms follow the community guide
[Colosseum Stack Solves](https://docs.google.com/document/d/e/2PACX-1vR3IqdspMrEAbH60-Z9cOKpM8-H5U49q6ZgqU8wTFSXIj_kAx69qyKakuyMOm2oLRvdV2cGNK2B0kmZ/pub)
by Help Me RNG, with ro0b0 and ItzSynpah, which is also what Meta Solve is tested against.

## Development

    npm install
    npm run dev     # http://localhost:5173
    npm run test
    npm run build   # output in dist/
