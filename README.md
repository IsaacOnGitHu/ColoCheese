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

The whole plan can be stepped through tick by tick to see how the NPCs react.

## Credit

Built on the Colosseum line of sight tool ([los.colosim.com](https://los.colosim.com)), originally
written by [Backseat](https://bistools.github.io/inferno.html) and
[iFreedive](https://ifreedive-osrs.github.io/). Further built upon for cheese tanking.

## Development

    npm install
    npm run dev     # http://localhost:5173
    npm run test
    npm run build   # output in dist/
