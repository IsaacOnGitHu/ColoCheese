import { Coordinates, Mob, MobExtra, MobSpec, ReplayData, TapeEntry } from "./types";
import { blockedTileRanges, DEFAULT_WEAPON_MODE, DELAY_FIRST_ATTACK_TICKS, MANTICORE, MANTICORE_ATTACKS, MANTICORE_CHARGE_TIME, MANTICORE_DELAY, MANTICORE_PATTERNS, MINOTAUR, MINOTAUR_HEAL_COLOR, MINOTAUR_HEAL_RANGE, MM3_PATTERNS, MODE_PLAYER, NPC_DISPLAY_NAME, NPC_INFO, NPC_PROTECT_PRAYER, NPC_TYPES, NpcType, STANDARD_PATTERNS, WEAPON_MODES, WeaponMode } from "./constants";

import { canBounce, getCenterTile } from "./venator";
import { buildPathTree, pathTo, pathToFirst, runTicks, type PathTree } from "./playerPathing";
import { matchGuideSolve } from "./guideSolves";
import {
  DEFAULT_PLAYER_DEFENCE,
  expectedAttackDamage,
  expectedDamagePerTick,
  isPrayedAgainst,
  NO_INVOCATIONS,
  type Invocations,
  type PlayerDefence,
  type PrayerStyle,
} from "./damageModel";
import { describeRhythm, flickPlan, readTimeline, tickPrayer } from "./metaSolver";
import { computeReplayBounds, convertMobSpecToMob, copyQ, decodeURL, encodeCoordinate, extendBounds, getMobSpec, getReplayURL, getSpawnUrl, record } from "./utils";

/** One click in a solved route: the tile to click, and how many ticks to stand on it afterwards. */
export type SolveClick = { tile: Coordinates; wait: number; early?: boolean };
/** `steps` is the tile-by-tile walk (for drawing); `ticks` is the position after each tick. */
type SolveRoute = { clicks: SolveClick[]; steps: Coordinates[]; ticks: Coordinates[] };

const PILLAR_COORDS = [
  [8, 10],
  [23, 10],
  [8, 25],
  [23, 25],
];

const SPAWNS: Coordinates[] = [
  [3, 19],
  [9, 17],
  [3, 14],
  [13, 14],
  [19, 14],
  [17, 9],
  [13, 20],
  [19, 20],
  [16, 24],
  [24, 16],
  [28, 14],
  [28, 19],
];
const B5_ORIGIN_TILE: Coordinates = [7, 15];

const MAX_EXPORT_LENGTH = 128;
const TILE_SIZE = 20;
const MAP_WIDTH = 34;
const MAP_HEIGHT = 34;
// Max range tested for venator LOS (note that this is a post-filter over the venator geometry rules)
const VENATOR_LOS_RANGE = 10;
const TICKER_WIDTH = 9;
const TICKER_START_X = MAP_WIDTH * TILE_SIZE;
const CANVAS_WIDTH = TICKER_START_X + TICKER_WIDTH * TILE_SIZE;
const CANVAS_HEIGHT = TILE_SIZE * MAP_HEIGHT;

const CHECKER = true;

export class LineOfSight {

  /**
   * Current selection mode.
   */
  mode: NpcType = NPC_TYPES.PLAYER;
  // only used for manticore at the moment
  modeExtra: MobExtra = null;

  /**
   * The location of the actual cursor.
   */
  cursorLocation: Coordinates | null = null;
  /**
   * The location of the player.
   */
  selected: Coordinates = [...B5_ORIGIN_TILE];
  stepStartPosition: Coordinates | null = null;
  mousedOverNpc: number | null = null;

  mobs: Mob[] = [];
  // tape for mobs
  tape: TapeEntry[] = [];
  playerTape: Coordinates[] = [];
  tapeSelectionRange: number[] | null = null; // tape selection, [start, end. TODO remove

  tickCount = 0;

  // Visualisation settings
  showSpawns = true;
  showPlayerLoS = true;
  fromWaveStart: boolean = false;
  mantimayhem3: boolean = false;
  showVenatorBounce: boolean = false;

  // Which weapon the solve assumes, which decides whether an isolated 1v1 is actually winnable.
  weaponMode: WeaponMode = DEFAULT_WEAPON_MODE;

  // Outcome of the last solve, surfaced in the sidebar. Kept as primitives so getUiState()'s
  // shallow change-detection keeps working.
  solveSummary: string | null = null;
  solveTone: "good" | "warn" | "bad" | null = null;
  solveRoute: string | null = null;
  solveEndAttackable: boolean = false;
  /** The community guide's own advice for this stack, when it covers one like it. */
  guideNote: { label: string; steps: string[]; unwinnable: boolean } | null = null;

  // Solarflare invocation: an orb orbits every pillar, so solves should avoid ending next to one.
  solarflare: boolean = false;

  // Your defences for the damage estimate, and the prayer you keep up while running a route.
  playerDefence: PlayerDefence = { ...DEFAULT_PLAYER_DEFENCE };
  runPrayer: PrayerStyle = "magic";
  // Relentless and Mantimayhem tiers, which change how hard enemies hit.
  invocations: Invocations = { ...NO_INVOCATIONS };

  replay: Coordinates[] | null = null;
  replayTick: number | null = null;
  replayAuto: ReturnType<typeof setTimeout> | null = null;

  draggingNpcIndex: number | null = null;
  draggingNpcOffset: Coordinates | null = null;

  manticoreTicksRemaining: { [mobIndex: number]: number } = {};

  mapElement: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  subscribers: VoidFunction[] = [];
  
  images: (HTMLImageElement | null)[] = [];
  
  hasLoadedSpawns = false;

  public initDOM(mapElement: HTMLCanvasElement) {
    this.mapElement = mapElement;
    this.ctx = mapElement.getContext('2d')!;
    this.mapElement.width = CANVAS_WIDTH;
    this.mapElement.height = CANVAS_HEIGHT;
    this.loadSpawns();
    this.drawWave();

    // Preload images
    Object.values(NPC_INFO).forEach(({ img }, i) => {
      if (img.length === 0) {
        return null;
      }
      const image = new Image();
      image.src = img;
      image.onload = () => {
        this.images[i] = image;
        this.drawWave();
      };
    });
  }

  private doAutoTick() {
    if (!this.replayAuto) {
      return;
    }
    this.step();
    this.drawWave();
  }

  public toggleAutoReplay() {
    if (this.replayAuto) {
      clearTimeout(this.replayAuto);
      this.replayAuto = null;
    } else {
      this.replayAuto = setTimeout(() => this.doAutoTick(), 600);
    }
    this.updateUi();
  }

  public exportReplay() {
    if (!this.mapElement) {
      return;
    }
    const { playerPositions, mobSpecs } = this.getReplayData();
    const rawBounds = computeReplayBounds({ playerPositions, mobSpecs }, NPC_INFO);
    const bounds = extendBounds(rawBounds, 4, MAP_WIDTH, MAP_HEIGHT); // extend visible area by 4 tiles
    const playAreaWidth = (bounds.maxX - bounds.minX + 1) * TILE_SIZE;
    const playAreaHeight = (bounds.maxY - bounds.minY + 1) * TILE_SIZE;

    const sourceContext = this.mapElement.getContext('2d')!;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = playAreaWidth + TICKER_WIDTH * TILE_SIZE;
    exportCanvas.height = playAreaHeight;

    this.reset();
    this.mobs = mobSpecs.map(convertMobSpecToMob);
    this.replay = playerPositions;
    this.replayTick = 0;
    this.selected = this.replay[0];

    record(exportCanvas, () => {
      if (this.replayTick === null || !this.replay) {
        return true;
      }
      if (this.replayTick >= this.replay.length) {
        // need to draw the wave one more time to be included in the video
        this.drawWave();
        return true;
      }
      this.step(true);
      // copy relevant play area to exportCanvas
      const imageContent = sourceContext.getImageData(bounds.minX * TILE_SIZE, bounds.minY * TILE_SIZE, playAreaWidth, playAreaHeight);
      exportCanvas.getContext('2d')?.putImageData(imageContent, 0, 0);
      // copy ticker to exportCanvas
      const tickerContent = sourceContext.getImageData(TICKER_START_X, 0, TICKER_WIDTH * TILE_SIZE, CANVAS_HEIGHT);
      exportCanvas.getContext('2d')?.putImageData(tickerContent, playAreaWidth, 0);
      return false;
    }, () => {
        this.replay = null;
        this.replayTick = null;
        this.reset();
        // Would be nice to set the state back to the original here.
    });
  }

  /**
   * Subscribe to changes in the state exposed by this LOS instance.
   */
  public subscribe(callback: VoidFunction) {
    this.subscribers.push(callback);
  }

  /**
   * Subscribe to changes in the state exposed by this LOS instance.
   */
  public unsubscribe(callback: VoidFunction) {
    this.subscribers = this.subscribers.filter((c) => c !== callback);
  }

  private onUpdateSubscribers() {
    this.subscribers.forEach((callback) => callback());
  }

  public setFromWaveStart = (val: boolean) => {
    this.fromWaveStart = val;
    this.onUpdateSubscribers();
  };

  public setMantimayhem3 = (val: boolean) => {
    this.mantimayhem3 = val;
    this.onUpdateSubscribers();
  };

  public setShowVenatorBounce = (show: boolean) => {
    this.showVenatorBounce = show;
    this.onUpdateSubscribers();
  };

  public setWeaponMode = (mode: WeaponMode) => {
    this.weaponMode = mode;
    this.clearSolveResult();
    this.onUpdateSubscribers();
  };

  public applySettings = (settings: {
    weaponMode: WeaponMode;
    solarflare: boolean;
    runPrayer: PrayerStyle;
    defence: PlayerDefence;
    // Optional so older callers still work: anything missing counts as off.
    invocations?: Partial<Invocations>;
  }) => {
    this.weaponMode = settings.weaponMode;
    this.solarflare = settings.solarflare;
    this.runPrayer = settings.runPrayer;
    this.playerDefence = { ...settings.defence };
    this.invocations = { ...NO_INVOCATIONS, ...settings.invocations };
    this.clearSolveResult();
    this.drawWave();
    this.onUpdateSubscribers();
  };

  public setSolarflare = (on: boolean) => {
    this.solarflare = on;
    this.clearSolveResult();
    this.drawWave();
    this.onUpdateSubscribers();
  };

  private clearSolveResult() {
    this.solveSummary = null;
    this.solveTone = null;
    this.solveRoute = null;
    this.solveEndAttackable = false;
    this.suggestedStartHidden = false;
    this.guideNote = null;
  }

  // The Solarflare orb is one tile circling each pillar, so every tile touching a pillar (diagonals
  // included) is in its path.
  private isOnSolarflareOrbit(x: number, y: number) {
    if (this.isPillar(x, y)) return false;
    return PILLAR_COORDS.some(([px, py]) => x >= px - 1 && x <= px + 3 && y >= py - 3 && y <= py + 1);
  }
  
  private updateUi() {
    // currently, we always fire subscriber events
    this.onUpdateSubscribers();
  }

  private _lastUiState: any = null;
  public getUiState() {
    const uiState = {
      mantimayhem3: this.mantimayhem3,
      fromWaveStart: this.fromWaveStart,
      isReplaying: !!this.replayAuto,
      hasReplay: !!this.replay && this.replayTick !== null && !!this.replay[this.replayTick],
      replayLength: this.replay?.length ?? null,
      canSaveReplay: !this.replayAuto && this.tape.length > 0 && this.tape.length <= 32,
      replayTick: this.replayTick ?? 0,
      weaponMode: this.weaponMode,
      solveSummary: this.solveSummary,
      solveTone: this.solveTone,
      solveRoute: this.solveRoute,
      startHidden: this.suggestedStartHidden,
      guideNote: this.guideNote,
      solarflare: this.solarflare,
    }
    // check if any UI state has changed
    if (!this._lastUiState || Object.entries(uiState).some(([k, v]) => this._lastUiState[k] !== v)) {
      this._lastUiState = uiState;
      return uiState;
    }
    return this._lastUiState;
  }

  public handleKeyDown(e: KeyboardEvent) {
    switch (e.keyCode) {
      case 38:
        this.step(true);
        break;
      case 40:
        this.reset();
        break;
    }
  };

  public onCanvasMouseDown(e: React.MouseEvent) {
    var x = e.nativeEvent.offsetX;
    var y = e.nativeEvent.offsetY;
    var selectedNpcIndex = null;
    x = Math.floor(x / TILE_SIZE);
    y = Math.floor(y / TILE_SIZE);
    if (x < MAP_WIDTH) {
      if (this.replay) {
        this.stopReplay();
      }
      for (var i = 0; i < this.mobs.length; i++) {
        if (this.doesCollide(x, y, 1, this.mobs[i][0], this.mobs[i][1], NPC_INFO[this.mobs[i][2]].size)) {
          selectedNpcIndex = i;
          break;
        }
      }
      if (selectedNpcIndex === null) {
        if (this.mode === MODE_PLAYER) {
          // move player
          this.selected = [x, y];
        }
        this.cursorLocation = [x, y];
      } else {
        // start drag
        this.draggingNpcIndex = selectedNpcIndex;
        this.draggingNpcOffset = [
          x - this.mobs[selectedNpcIndex][0],
          y - this.mobs[selectedNpcIndex][1],
        ];
        this.cursorLocation = null;
      }
    } else if (x <= CANVAS_WIDTH && y >= 0 && y <= this.tape.length + 1) {
      const tapeIndex = Math.floor(y);
      this.tapeSelectionRange = [tapeIndex];
    }
    this.drawWave();
  };

  public onCanvasMouseUp(e: React.MouseEvent) {
    var x = e.nativeEvent.offsetX;
    var y = e.nativeEvent.offsetY;
    x = Math.floor(x / TILE_SIZE);
    y = Math.floor(y / TILE_SIZE);
    if (this.tapeSelectionRange?.length === 1) {
      if (x >= MAP_WIDTH && x <= CANVAS_WIDTH && y >= 0 && y <= CANVAS_HEIGHT) {
        const endY = Math.min(y + 1, this.tape.length);
        this.tapeSelectionRange = [this.tapeSelectionRange[0], endY];
      }
    }
    if (this.draggingNpcIndex !== null) {
       this.suggestedPath = null; 
    }
    this.draggingNpcIndex = null;
    this.draggingNpcOffset = null;
    this.drawWave();
  };

  public onCanvasDblClick(e: React.MouseEvent) {
    var x = e.nativeEvent.offsetX;
    var y = e.nativeEvent.offsetY;
    x = Math.floor(x / TILE_SIZE);
    y = Math.floor(y / TILE_SIZE);
    if (x < MAP_WIDTH) {
      for (var i = 0; i < this.mobs.length; i++) {
        if (this.doesCollide(x, y, 1, this.mobs[i][0], this.mobs[i][1], NPC_INFO[this.mobs[i][2]].size)) {
          this.removeMob(i);
          break;
        }
      }
      this.drawWave();
    }
  };

  public onCanvasRightClick(e: React.MouseEvent) {
    e.preventDefault();
    var x = e.nativeEvent.offsetX;
    var y = e.nativeEvent.offsetY;
    x = Math.floor(x / TILE_SIZE);
    y = Math.floor(y / TILE_SIZE);
    if (x < MAP_WIDTH) {
      for (var i = 0; i < this.mobs.length; i++) {
        if (this.doesCollide(x, y, 1, this.mobs[i][0], this.mobs[i][1], NPC_INFO[this.mobs[i][2]].size)) {
          // Only toggle charged state for manticores
          if (this.mobs[i][2] === MANTICORE) {
            const currentExtra = this.mobs[i][6];
            const originalExtra = this.mobs[i][7];

            // Don't toggle unknown manticores
            if (currentExtra === null || originalExtra === "u") {
              break;
            }

            // Toggle between charged and uncharged
            const isCurrentlyUncharged = currentExtra.startsWith("u");
            if (isCurrentlyUncharged) {
              // Switch to charged: remove 'u' prefix
              this.mobs[i][6] = currentExtra.substring(1) as MobExtra;
              this.mobs[i][7] = currentExtra.substring(1) as MobExtra; // Update originalExtra too
            } else {
              // Switch to uncharged: add 'u' prefix
              const uncharged = ("u" + currentExtra) as MobExtra;
              this.mobs[i][6] = uncharged;
              this.mobs[i][7] = uncharged; // Update originalExtra too
            }
            this.mobs[i][5] = 0; // Reset attack delay
          }
          break;
        }
      }
      this.drawWave();
    }
    return false;
  };

  public onCanvasMouseWheel(e: React.WheelEvent) {
    if (e.deltaY > 0) {
      this.step();
      this.drawWave();
    } else {
      this.reset();
      this.drawWave();
    }
  };

  public onCanvasMouseOut() {
    // delete dragged npc if out of map
    if (this.draggingNpcIndex !== null) {
      this.removeMob(this.draggingNpcIndex);
      this.draggingNpcIndex = null;
      this.drawWave();
    }
  };

  public onCanvasMouseMove(e: React.MouseEvent) {
    // dragging
    var x = e.nativeEvent.offsetX;
    var y = e.nativeEvent.offsetY;
    x = Math.floor(x / TILE_SIZE);
    y = Math.floor(y / TILE_SIZE);
    if (x < 0 || x >= MAP_WIDTH || y < 0 || y > MAP_HEIGHT) {
      return;
    }
    var mouseIcon = "auto";
    var dirty = false;
    var wasMousedOverNpc = this.mousedOverNpc;
    this.mousedOverNpc = null;
    for (var i = 0; i < this.mobs.length; i++) {
      if (this.doesCollide(x, y, 1, this.mobs[i][0], this.mobs[i][1], NPC_INFO[this.mobs[i][2]].size)) {
        mouseIcon = "move";
        this.mousedOverNpc = i;
        break;
      }
    }
    dirty ||= this.mousedOverNpc !== wasMousedOverNpc;

    this.mapElement!.style.cursor = mouseIcon;
    if (e.buttons & 0x1) {
      // holding left button
      if (this.draggingNpcIndex !== null && this.draggingNpcOffset !== null) {
        this.mobs[this.draggingNpcIndex][0] = x - this.draggingNpcOffset[0];
        this.mobs[this.draggingNpcIndex][1] = y - this.draggingNpcOffset[1];
        this.mobs[this.draggingNpcIndex][3] = x - this.draggingNpcOffset[0];
        this.mobs[this.draggingNpcIndex][4] = y - this.draggingNpcOffset[1];
        this.cursorLocation = null;
      } else if (this.mode > MODE_PLAYER) {
        this.cursorLocation = [x, y];
      } else {
        this.cursorLocation = [x, y];
        this.selected = [x, y];
      }
      dirty = true;
    }
    if (dirty) {
      this.drawWave();
    }
  };

  private loadSpawns() {
    if (this.hasLoadedSpawns) {
      return;
    }
    this.hasLoadedSpawns = true;
    const { mobs: decodedMobs, isFromWaveStart, isMantiMayhem3, playerCoordinates, isReplay } = decodeURL(new URL(window.location.toString()));
    this.mobs = decodedMobs;
    this.sortMobs();
    this.setFromWaveStart(isFromWaveStart);
    this.setMantimayhem3(isMantiMayhem3);
    if (!playerCoordinates) {
      return;
    }

    if (isReplay) {
      // This is a replay URL - start the replay
      this.replay = playerCoordinates;
      this.replayTick = 0;
      this.selected = this.replay[0];
      this.step();
      this.replayAuto = setTimeout(() => this.doAutoTick(), 600);
    } else {
      // This is a spawn URL with just a player position - set position without starting replay
      this.selected = playerCoordinates[0];
    }
  }

  public copySpawnURL() {
    // TODO: this should be unified with copyReplayURL (perhaps if there's nothing in the ticker, we just copy the spawn URL)
    const mobSpecs = this.mobs.filter((mob) => mob[2] > MODE_PLAYER).map(getMobSpec);
    var url = getSpawnUrl(mobSpecs);

    // Check if player has been moved from starting position
    const playerMoved = this.selected[0] !== B5_ORIGIN_TILE[0] || this.selected[1] !== B5_ORIGIN_TILE[1];

    // Build hash fragments
    const hashParts = [];

    // Add player position if moved
    if (playerMoved) {
      hashParts.push(encodeCoordinate(this.selected));
    }

    // Add flags if enabled  
    if (this.fromWaveStart) {
      hashParts.push("_ws");
    }
    if (this.mantimayhem3) {
      hashParts.push("_mm3");
    }

    // Add hash if there are any parts
    if (hashParts.length > 0) {
      url = url.concat("#" + hashParts.join(""));
    }

    copyQ(url);
    alert("Spawn URL Copied!");
  }

  private getReplayData(): ReplayData {
    let lowerBound, upperBoundInclusive;
    if (this.tapeSelectionRange?.length === 2) {
      // TODO: remove tapeSelectionRange
      lowerBound = this.tapeSelectionRange[0];
      upperBoundInclusive = Math.min(
        this.tapeSelectionRange[1] + 1,
        this.tapeSelectionRange[0] + MAX_EXPORT_LENGTH
      );
    } else {
      lowerBound = 0;
      upperBoundInclusive = Math.min(this.tape.length, MAX_EXPORT_LENGTH);
    }
    var mobTicks = this.tape.slice(lowerBound, upperBoundInclusive);
    var playerPositions = this.playerTape.slice(lowerBound, upperBoundInclusive);

    // get the mob positions/specs at the start of the selection
    const mobSpecs = mobTicks[0].map(
      (value, mobIdx) =>
        [
          (value >> 16) & 0xff,
          (value >> 24) & 0xff,
          this.mobs[mobIdx][2],
          // Use original extra value for manticores if available
          this.mobs[mobIdx][2] === MANTICORE && this.mobs[mobIdx][7] !== undefined
            ? this.mobs[mobIdx][7]
            : this.mobs[mobIdx][6],
        ] as MobSpec
    );
    return { playerPositions, mobSpecs };
  }

  public copyReplayURL() {
    var url = getReplayURL(this.getReplayData(), this.fromWaveStart);
    copyQ(url);
    alert("Replay URL Copied!");
  }

  public togglePlayerLoS() {
    this.showPlayerLoS = !this.showPlayerLoS;
    this.drawWave();
  }

  private isPillar(x: number, y: number) {
    var isPillar = false;
    for (var j = 0; j < PILLAR_COORDS.length; j++) {
      isPillar = this.doesCollide(x, y, 1, PILLAR_COORDS[j][0], PILLAR_COORDS[j][1], 3) || isPillar;
    }
    if (y >= 0 && y < blockedTileRanges.length) {
      const ranges = blockedTileRanges[y];
      for (var j = 0; j < ranges.length; ++j) {
        const range = ranges[j];
        if (x >= range[0] && x < range[1]) {
          return true;
        }
      }
    }
    return isPillar;
  }

  private removeMob(index: number) {
    this.suggestedPath = null;
    this.mobs.splice(index, 1);
    this.tape = this.tape.map((entries) => {
      return entries.filter((_mobData, i) => i !== index);
    });
  }

  private hasLOS(
    x1: number,
    y1: number,
    // target x, y
    x2: number,
    y2: number,
    s = 1,
    r = 1,
    isNPC = false,
    // Range 1 normally means the strict orthogonal melee rule. A halberd under Myopia is still
    // reach 1 but can attack diagonally, so it takes the generic line-of-sight path instead,
    // which treats range as chebyshev distance and so covers all 8 surrounding tiles.
    allowDiagonal = false
  ): boolean {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (
      this.isPillar(x1, y1) ||
      this.isPillar(x2, y2) ||
      this.doesCollide(x1, y1, s, x2, y2, 1)
    ) {
      return false;
    }
    //assume range 1 is melee
    if (r == 1 && !allowDiagonal) {
      return (
        (dx < s && dx >= 0 && (dy == 1 || dy == -s)) ||
        (dy > -s && dy <= 0 && (dx == -1 || dx == s))
      );
    }
    if (isNPC) {
      var tx = Math.max(x1, Math.min(x1 + s - 1, x2));
      var ty = Math.max(y1 - s + 1, Math.min(y1, y2));
      return this.hasLOS(x2, y2, tx, ty, 1, r, false, allowDiagonal);
    }
    const dxAbs = Math.abs(dx);
    const dyAbs = Math.abs(dy);
    if (dxAbs > r || dyAbs > r) {
      return false;
    } //iFreedive
    if (dxAbs > dyAbs) {
      let xTile = x1;
      let y = (y1 << 16) + 0x8000;
      const slope = Math.trunc((dy << 16) / dxAbs); // Integer division
      const xInc = dx > 0 ? 1 : -1;
      if (dy < 0) {
        y -= 1; // For correct rounding
      }
      while (xTile !== x2) {
        xTile += xInc;
        const yTile = y >>> 16;
        if (this.isPillar(xTile, yTile)) {
          return false;
        }
        y += slope;
        const newYTile = y >>> 16;
        if (newYTile !== yTile && this.isPillar(xTile, newYTile)) {
          return false;
        }
      }
    } else {
      let yTile = y1;
      let x = (x1 << 16) + 0x8000;
      const slope = Math.trunc((dx << 16) / dyAbs); // Integer division
      const yInc = dy > 0 ? 1 : -1;
      if (dx < 0) {
        x -= 1; // For correct rounding
      }
      while (yTile !== y2) {
        yTile += yInc;
        const xTile = x >>> 16;
        if (this.isPillar(xTile, yTile)) {
          return false;
        }
        x += slope;
        const newXTile = x >>> 16;
        if (newXTile !== xTile && this.isPillar(newXTile, yTile)) {
          return false;
        }
      }
    }
    return true;
  }

  private doesCollide(
    x: number,
    y: number,
    s: number,
    x2: number,
    y2: number,
    s2: number
  ) {
    if (x > x2 + s2 - 1 || x + s - 1 < x2 || y - s + 1 > y2 || y < y2 - s2 + 1) {
      return false;
    }
    return true;
  }

  private sortMobs() {
    this.mobs = this.mobs.sort(function (a, b) {
      const aId = NPC_INFO[a[2]].id;
      const bId = NPC_INFO[b[2]].id;
      return aId - bId;
    });
  }

  public place() {
    this.suggestedPath = null;
    this.clearSolveResult();
    if (this.cursorLocation) {
      if (this.mode > 0) {
        //x y mode ox oy cooldown extra
        //prevent 2 mobs on same tile
        for (var i = 0; i < this.mobs.length; i++) {
          if (
            this.mobs[i][3] == this.cursorLocation[0] &&
            this.mobs[i][4] == this.cursorLocation[1]
          ) {
            return;
          }
        }
        // Create mob array
        const newMob: Mob = [
          this.cursorLocation[0],
          this.cursorLocation[1],
          this.mode,
          this.cursorLocation[0],
          this.cursorLocation[1],
          0,
          this.modeExtra,
        ];

        // Store original extra for manticores
        if (this.mode === MANTICORE && this.modeExtra) {
          newMob.push(this.modeExtra);
        }

        this.mobs.push(newMob);
        this.sortMobs();
        // Only reset mode after successfully placing an NPC
        this.mode = 0;
        this.modeExtra = null;
      } else {
        this.selected = [...this.cursorLocation];
      }
      this.cursorLocation = null;
      this.drawWave();
    }
  }

  private advanceReplay() {
    if (this.replay && this.replayTick !== null) {
      // Past the end of the route the player holds the last tile, so you can keep stepping to watch
      // the fight once you've arrived. Reset is what starts the route again.
      this.selected = this.replay[Math.min(this.replayTick, this.replay.length - 1)];
      this.replayTick++;
      if (this.replayAuto) {
        clearTimeout(this.replayAuto);
        // Play pauses the moment the route finishes; pressing it again keeps going from the end tile.
        this.replayAuto = this.replayTick === this.replay.length ? null : setTimeout(() => this.doAutoTick(), 600);
        if (!this.replayAuto) this.updateUi();
      }
    }
  }

  private moveMobs(canMove: boolean, canGainLos: boolean) {
    for (var i = 0; i < this.mobs.length; i++) {
      if (this.mobs[i][2] < 8) {
        var mob = this.mobs[i];
          mob[5]--; // Decrement cooldown
          var x = mob[0];
          var y = mob[1];
          var t = mob[2];
          const { size: s, range: r } = NPC_INFO[t];

        if (canMove && !(canGainLos && this.hasLOS(x, y, this.selected[0], this.selected[1], s, r, true))) {
          var dx = x + Math.sign(this.selected[0] - x);
          var dy = y + Math.sign(this.selected[1] - y);
          //allows corner safespotting
          if (this.doesCollide(dx, dy, s, this.selected[0], this.selected[1], 1)) {
            dy = mob[1];
          }
          const step = this.npcStep(x, y, s, i, dx, dy, this.mobs);
          if (step) {
            mob[0] = step[0];
            mob[1] = step[1];
          }
        }
      }
    }
  }

  private handleManticoreCharging(canAttack: boolean) {
    // Find manticores that should start charging
    let manticoresStartingToCharge: number[] = [];
    for (var i = 0; i < this.mobs.length; i++) {
      if (this.mobs[i][2] === MANTICORE) {
        const mob = this.mobs[i];
        const currentExtra = mob[6];
        const x = mob[0];
        const y = mob[1];

        const isUncharged = currentExtra?.startsWith('u') ?? false;

        if (isUncharged && canAttack && this.hasLOS(x, y, this.selected[0], this.selected[1], NPC_INFO[MANTICORE].size, NPC_INFO[MANTICORE].range, true)) {
          manticoresStartingToCharge.push(i);
        }
      }
    }

    if (manticoresStartingToCharge.length === 0) {
      return;
    }

    // Check if there's already a charged/charging manticore to inherit from
    let establishedStyle: string | null = null;
    for (var i = 0; i < this.mobs.length; i++) {
      if (this.mobs[i][2] === MANTICORE && !manticoresStartingToCharge.includes(i)) {
        const mob = this.mobs[i];
        const currentExtra = mob[6];

        const isChargedOrCharging = currentExtra && !currentExtra.startsWith('u');

        if (isChargedOrCharging) {
          establishedStyle = currentExtra;
          break;
        }
      }
    }

    // Determine styles for the charging manticores
    let knownStyles: string[] = [];
    if (!establishedStyle) {
      for (const idx of manticoresStartingToCharge) {
        const originalExtra = this.mobs[idx][7];
        if (originalExtra && originalExtra !== "u") {
          const baseStyle = originalExtra.startsWith("u") ? originalExtra.substring(1) : originalExtra;
          if (!knownStyles.includes(baseStyle)) {
            knownStyles.push(baseStyle);
          }
        }
      }
    }

    let groupSelectedStyle: MobExtra | null = null;
    if (knownStyles.length > 1) {
      groupSelectedStyle = knownStyles[Math.floor(Math.random() * knownStyles.length)] as MobExtra;
    }

    let randomStyleForUnknowns: MobExtra | null = null;

    for (const idx of manticoresStartingToCharge) {
      const mob = this.mobs[idx];
      const originalExtra = mob[7];
      const currentExtra = mob[6];

      let chargedStyle: MobExtra = null;

      if (establishedStyle) {
        chargedStyle = establishedStyle as MobExtra;
      } else if (groupSelectedStyle) {
        chargedStyle = groupSelectedStyle;
      } else if (currentExtra && currentExtra.startsWith("u") && currentExtra.length > 1) {
        chargedStyle = currentExtra.substring(1) as MobExtra;
      } else if (currentExtra === "u") {
        if (knownStyles.length === 1) {
          chargedStyle = knownStyles[0] as MobExtra;
        } else if (knownStyles.length > 1) {
          chargedStyle = groupSelectedStyle;
        } else {
          if (!randomStyleForUnknowns) {
            const patterns = this.mantimayhem3 ? MM3_PATTERNS : STANDARD_PATTERNS;
            randomStyleForUnknowns = patterns[Math.floor(Math.random() * patterns.length)] as MobExtra;
          }
          chargedStyle = randomStyleForUnknowns;
        }
      }

      if (chargedStyle) {
        mob[6] = chargedStyle;
        mob[5] = MANTICORE_CHARGE_TIME;
      }

      if (originalExtra === "u" && chargedStyle &&
        !establishedStyle && knownStyles.length === 0) {
        mob[7] = ("u" + chargedStyle) as MobExtra;
      }
    }
  }

  private processAttacks(canAttack: boolean): { line: TapeEntry, manticoreFired: boolean } {
    let line: TapeEntry = [];
    let manticoreFiredThisTick = false;

    for (var i = 0; i < this.mobs.length; i++) {
      if (this.mobs[i][2] < 8) {
        var mob = this.mobs[i];
        var x = mob[0];
        var y = mob[1];
        var t = mob[2];
        const { size: s, range: r } = NPC_INFO[t];
        var attacked = 0;

        if (canAttack && this.hasLOS(x, y, this.selected[0], this.selected[1], s, r, true)) {
          if (mob[2] === MANTICORE) {
            const currentExtra = mob[6];
            const isCharged = currentExtra && !currentExtra.startsWith('u');

            if (isCharged && mob[5] <= 0 && !manticoreFiredThisTick) {
              this.manticoreTicksRemaining[i] = 3;
              attacked = 1;
              mob[5] = NPC_INFO[t].cd;
              manticoreFiredThisTick = true;
            }
          } else {
            if (mob[5] <= 0) {
              attacked = 1;
              mob[5] = NPC_INFO[t].cd;
            }
          }
        }
        const value = attacked | ((x & 0xff) << 16) | ((y & 0xff) << 24);
        line.push(value);
      }
    }

    return { line, manticoreFired: manticoreFiredThisTick };
  }

  private recordManticoreOrbSequence(line: TapeEntry) {
    Object.entries(this.manticoreTicksRemaining).forEach(([idx, ticks]) => {
      const index = Number(idx);
      if (ticks > 0 && this.mobs[index]) {
        const manticoreMode = this.mobs[index][6]!;
        const manticoreStyles = MANTICORE_PATTERNS[manticoreMode];
        const currentStyle = manticoreStyles[3 - ticks];
        const prevLine = line[index];
        line[index] = 1 | (currentStyle << 8) | (prevLine & 0xffff0000);
        this.manticoreTicksRemaining[index] = ticks - 1;
      } else {
        delete this.manticoreTicksRemaining[index];
      }
    });
  }

  public step(draw: boolean = false) {
    // Capture the player's position when stepping begins
    if (this.tickCount === 0 && !this.replay) {
      this.stepStartPosition = [...this.selected];
    }

    this.advanceReplay();

    if (this.mode == 0 && this.mobs.length > 0) {
      const canAttack = this.fromWaveStart ? this.tickCount >= DELAY_FIRST_ATTACK_TICKS : true;
      const canMove = this.fromWaveStart ? this.tickCount > 0 : true;
      const canGainLos = this.fromWaveStart ? this.tickCount > 1 : true;

      // Move all mobs
      this.moveMobs(canMove, canGainLos);

      // Handle manticore charging
      this.handleManticoreCharging(canAttack);

      // Process attacks
      const { line, manticoreFired } = this.processAttacks(canAttack);

      // Record manticore orb progression in attack tape
      this.recordManticoreOrbSequence(line);

      if (manticoreFired) {
        this.delayAllReadyMantis();
      }

      // Record this tick's player position and mob actions to history
      this.playerTape.push([this.selected[0], this.selected[1]]);
      this.tape.push(line);
    }
    this.tickCount++;
    if (draw) {
      this.drawWave();
    }
  }

  private delayAllReadyMantis() {
    this.mobs
      .filter((mob) => {
        if (mob[2] !== MANTICORE || mob[5] > 0) return false;
        const currentExtra = mob[6];
        // Check if charged (not starting with 'u')
        return currentExtra && !currentExtra.startsWith('u');
      })
      .forEach((mob) => {
        mob[5] = MANTICORE_DELAY;
      });
  }

  private stopReplay() {
    this.replay = null;
    this.replayTick = null;
    if (this.replayAuto) {
      clearTimeout(this.replayAuto);
    }
    this.replayAuto = null;
    this.updateUi();
  }

  public remove() {
    this.suggestedPath = null;
    this.clearSolveResult();
    this.mobs = [];
    this.stopReplay();
    this.selected = [...B5_ORIGIN_TILE];
    this.stepStartPosition = null;
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    window.location.href = url.toString();
    this.reset();
    this.drawWave();
  }

  public reset() {
    for (var i = 0; i < this.mobs.length; i++) {
      this.mobs[i][0] = this.mobs[i][3];
      this.mobs[i][1] = this.mobs[i][4];
      this.mobs[i][5] = 0;

      // Reset manticores to their original state
      if (this.mobs[i][2] === MANTICORE) {
        const originalExtra = this.mobs[i][7];
        if (originalExtra !== undefined) {
          // Restore the original extra value
          this.mobs[i][6] = originalExtra;
        }
      }
    }
    this.manticoreTicksRemaining = {};
    this.tape = [];
    this.playerTape = [];
    this.tapeSelectionRange = null;
    this.tickCount = 0;
    if (this.replay) {
      this.replayTick = 0;
      this.selected = this.replay[0];
    } else if (this.stepStartPosition) {
      // Reset player to position at start of stepping (like replay mode does)
      this.selected = [...this.stepStartPosition];
    }
    this.draggingNpcIndex = null;
    this.draggingNpcOffset = null;
    this.cursorLocation = null;
    this.drawWave();
  }

  public setMode(m: number, extra?: MobExtra, initPosition: boolean = false) {
    if (initPosition && this.cursorLocation === null) {
      this.cursorLocation = [...this.selected];
    }
    this.mode = m;
    this.modeExtra = extra ?? null;
    this.drawWave();
  }

  private drawLOS(
    x: number,
    y: number,
    s: number,
    r: number,
    isNPC: boolean,
    color = "red"
  ) {
    if (!this.ctx) {
      return;
    }
    if (this.showPlayerLoS) {
      this.ctx.globalAlpha = 0.15;
    } else {
      this.ctx.globalAlpha = 0;
    }

    for (var i = 0; i < MAP_WIDTH * MAP_HEIGHT; i++) {
      this.ctx.fillStyle = color;

      var x2 = i % MAP_WIDTH;
      var y2 = Math.floor(i / MAP_HEIGHT);

      if (this.hasLOS(x, y, x2, y2, s, r, isNPC)) {
        this.ctx.fillRect(x2 * TILE_SIZE, y2 * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
    this.ctx.globalAlpha = 1;
  }

  public drawWave() {
    this.updateUi();
    if (!this.ctx || !this.mapElement) {
      return;
    }
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.mapElement.width, this.mapElement.height);

    const scale = (p: number) => p * TILE_SIZE;
    function drawManticorePattern(pattern: number[], x: number, y: number, isTransparent: boolean = false) {
      pattern.forEach((colorIndex, index) => {
        if (!ctx) {
          return;
        }
        const color = MANTICORE_ATTACKS[colorIndex];
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        if (isTransparent) {
          ctx.globalAlpha = 0.35;
        }
        ctx.beginPath();
        ctx.arc(scale(x + 2.5), scale(y - index + 0.5), TILE_SIZE / 2, 0, Math.PI * 2);
        ctx.fill();
        if (isTransparent) {
          ctx.globalAlpha = 1;
        }
      });
    }

    function drawVenatorCenterTile(x: number, y: number, size: number, isSource: boolean) {
      const [centerX, centerY] = getCenterTile(x, y, size);
      const tileCenterX = scale(centerX + 0.5);
      const tileCenterY = scale(centerY + 0.5);
      const markerRadius = TILE_SIZE * 0.26;

      ctx.save();
      ctx.fillStyle = isSource ? "#ffd400" : "#ff69b4";
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tileCenterX, tileCenterY - markerRadius);
      ctx.lineTo(tileCenterX + markerRadius, tileCenterY);
      ctx.lineTo(tileCenterX, tileCenterY + markerRadius);
      ctx.lineTo(tileCenterX - markerRadius, tileCenterY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    const checkerColor = CHECKER ? "#eee" : "#fff";
    for (var i = 0; i < MAP_WIDTH * MAP_HEIGHT; i++) {
      const x = i % MAP_WIDTH;
      const y = Math.floor(i / MAP_WIDTH);
      ctx.fillStyle = (i + (y % 2)) % 2 ? "#fff" : checkerColor;
      ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
    // colosseum border
    ctx.fillStyle = "#000";
    blockedTileRanges.forEach((ranges, y) => {
      ranges.forEach((range) => {
        if (!ctx) {
          return;
        }
        ctx.fillRect(
          scale(range[0]),
          scale(y),
          scale(range[1] - range[0]),
          scale(1)
        );
      });
    });

    //pillars
    ctx.fillStyle = "#222";
    for (var i = 0; i < PILLAR_COORDS.length; i++) {
      ctx.fillRect(
        PILLAR_COORDS[i][0] * TILE_SIZE,
        (PILLAR_COORDS[i][1] + 1) * TILE_SIZE,
        3 * TILE_SIZE,
        -3 * TILE_SIZE
      );
    }
    if (this.showSpawns) {
      ctx.globalAlpha = 0.35;
    } else {
      ctx.globalAlpha = 0;
    }
    ctx.fillStyle = "#999";
    for (var i = 0; i < SPAWNS.length; i++) {
      ctx.fillRect(
        SPAWNS[i][0] * TILE_SIZE,
        (SPAWNS[i][1] + 1) * TILE_SIZE,
        3 * TILE_SIZE,
        -3 * TILE_SIZE
      );
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#9F9";
    ctx.fillRect(scale(B5_ORIGIN_TILE[0]), scale(B5_ORIGIN_TILE[1]), TILE_SIZE, TILE_SIZE);
    ctx.globalAlpha = 1;
    //mobs
    for (var i = 0; i < this.mobs.length; i++) {
      var x = this.mobs[i][0];
      var y = this.mobs[i][1];
      const t = this.mobs[i][2];
      var { size: s, range: r, color: c } = NPC_INFO[t];
      ctx.fillStyle = ctx.strokeStyle = c;
      if (t < 8) {
        ctx.fillRect(x * TILE_SIZE, (y + 1) * TILE_SIZE, 1 * TILE_SIZE, -1 * TILE_SIZE);
        ctx.strokeRect(x * TILE_SIZE + 1, (y + 1) * TILE_SIZE - 1, s * TILE_SIZE, -s * TILE_SIZE);
      }
      if (this.mode == 0 && this.hasLOS(x, y, this.selected[0], this.selected[1], s, r, true)) {
        ctx.fillStyle = "black";
        ctx.fillRect(x * TILE_SIZE, (y + 1) * TILE_SIZE, (1 * TILE_SIZE) / 4, (-1 * TILE_SIZE) / 4);
      }
    }
    if (this.draggingNpcIndex !== null) {
      // currently dragging an NPC, draw its LOS
      const t = this.mobs[this.draggingNpcIndex][2];
      this.drawLOS(
        this.mobs[this.draggingNpcIndex][0],
        this.mobs[this.draggingNpcIndex][1],
        NPC_INFO[t].size,
        NPC_INFO[t].range,
        t > 0,
        NPC_INFO[t].color
      );
      // draw minotaur line-of-sight (from center tile as if it were a player)
      if (t === MINOTAUR) {
        this.drawLOS(
          this.mobs[this.draggingNpcIndex][0] + 1,
          this.mobs[this.draggingNpcIndex][1] - 1,
          1,
          MINOTAUR_HEAL_RANGE,
          false,
          MINOTAUR_HEAL_COLOR
        );
      }
    } else if (this.cursorLocation) {
      // currently placing an NPC, draw its LOS
      var { size: s, range: r, color: c } = NPC_INFO[this.mode];
      this.drawLOS(this.cursorLocation[0], this.cursorLocation[1], s, r, this.mode > 0, c);

      // draw minotaur line-of-sight (from center tile as if it were a player)
      if (this.mode === MINOTAUR) {
        this.drawLOS(
          this.cursorLocation[0] + 1,
          this.cursorLocation[1] - 1,
          1,
          MINOTAUR_HEAL_RANGE,
          false,
          MINOTAUR_HEAL_COLOR
        );
      }
    }

    var { size: s, range: r, color: c } = NPC_INFO[NPC_TYPES.PLAYER];

    // draw player
    ctx.fillStyle = ctx.strokeStyle = c;
    ctx.fillRect(
      this.selected[0] * TILE_SIZE,
      (this.selected[1] + 1) * TILE_SIZE,
      1 * TILE_SIZE,
      -1 * TILE_SIZE
    );
    ctx.strokeRect(
      this.selected[0] * TILE_SIZE,
      (this.selected[1] + 1) * TILE_SIZE,
      s * TILE_SIZE,
      -s * TILE_SIZE
    );
    if (this.images[0]) {
      ctx.drawImage(
        this.images[0]!,
        this.selected[0] * TILE_SIZE,
        (this.selected[1] - s + 1) * TILE_SIZE,
        s * TILE_SIZE,
        s * TILE_SIZE
      );
    }

    if (this.cursorLocation) {
      var { size: s, range: r, color: c } = NPC_INFO[this.mode];
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = ctx.strokeStyle = c;
      ctx.fillRect(
        this.cursorLocation[0] * TILE_SIZE,
        (this.cursorLocation[1] + 1) * TILE_SIZE,
        1 * TILE_SIZE,
        -1 * TILE_SIZE
      );
      ctx.strokeRect(
        this.cursorLocation[0] * TILE_SIZE,
        (this.cursorLocation[1] + 1) * TILE_SIZE,
        s * TILE_SIZE,
        -s * TILE_SIZE
      );
      // draw image for anything that's not a player
      if (this.images[this.mode] && this.mode !== 0 && this.mode !== MODE_PLAYER) {
        ctx.drawImage(
          this.images[this.mode]!,
          this.cursorLocation[0] * TILE_SIZE,
          (this.cursorLocation[1] - s + 1) * TILE_SIZE,
          s * TILE_SIZE,
          s * TILE_SIZE
        );
      }
      if (this.mode === MANTICORE && this.modeExtra) {
        // Don't draw orbs for unknown manticores
        if (this.modeExtra !== "u") {
          const colorPattern = MANTICORE_PATTERNS[this.modeExtra];
          const isUncharged = this.modeExtra.startsWith("u");
          drawManticorePattern(colorPattern, this.cursorLocation[0], this.cursorLocation[1], isUncharged);
        }
      }
      ctx.globalAlpha = 1;
    }
    // ticker tape
    const offset = TICKER_START_X;
    const tickerStartY = (idx: number) => TILE_SIZE * idx;
    for (var i = 0; i < this.tape.length; i++) {
      if (this.fromWaveStart && i < DELAY_FIRST_ATTACK_TICKS) {
        ctx.fillStyle = i % 2 == 0 ? "#666" : "#777";
      } else {
        ctx.fillStyle = i % 2 == 0 ? "#ddd" : "#eee";
      }
      ctx.fillRect(offset, TILE_SIZE * i, TILE_SIZE * TICKER_WIDTH, TILE_SIZE);
      for (var j = 0; j < this.tape[i].length; j++) {
        const value = this.tape[i][j];
        var attacked = value & 0xff;
        var t = this.mobs[j][2];
        if (t > 0 && attacked) {
          ctx.fillStyle = NPC_INFO[t].color;
          ctx.fillRect(offset + TILE_SIZE * j, tickerStartY(i), TILE_SIZE, TILE_SIZE);
        }
        if (attacked && t === MANTICORE) {
          const pattern = (value >> 8) & 0xff;
          ctx.fillStyle = MANTICORE_ATTACKS[pattern];
          ctx.beginPath();
          ctx.arc(
            offset + TILE_SIZE * (j + 0.5),
            TILE_SIZE * (i + 0.5),
            TILE_SIZE / 2,
            0,
            Math.PI * 2
          );
          ctx.fill();
          ctx.strokeStyle = "white";
          ctx.stroke();
        }
      }
    }
    // ticker tape selection
    if (this.tapeSelectionRange?.length) {
      ctx.fillStyle = "yellow";
      ctx.globalAlpha = 0.25;
      const tapeStartY = this.tapeSelectionRange[0];
      const tapeEndY =
        this.tapeSelectionRange.length >= 2 ? this.tapeSelectionRange[1] : tapeStartY + 1;
      ctx.fillRect(
        offset,
        tickerStartY(tapeStartY),
        TILE_SIZE * TICKER_WIDTH,
        (tapeEndY - tapeStartY) * TILE_SIZE
      );
      ctx.globalAlpha = 1;
    }
    if (this.solarflare) {
      ctx.fillStyle = "#ff9800";
      ctx.globalAlpha = 0.3;
      for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
          if (this.isOnSolarflareOrbit(x, y)) {
            ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    // mobs
    const minotaurs = this.mobs.filter((m) => m[2] === MINOTAUR);
    for (var i = 0; i < this.mobs.length; i++) {
      const [x, y, t] = this.mobs[i];
      const s = NPC_INFO[this.mobs[i][2]].size;
      // Skip player (type 0) - should never be in mobs array
      if (!t || t === 0 || t === MODE_PLAYER) {
        continue;
      }
      if (this.images[t] && t !== 0) {
        ctx.drawImage(
          this.images[t],
          x * TILE_SIZE,
          (y - s + 1) * TILE_SIZE,
          s * TILE_SIZE,
          s * TILE_SIZE
        );
      }
      const mobExtra = this.mobs[i][6];
      if (t === MANTICORE && mobExtra && mobExtra !== "u") {
        const colorPattern = MANTICORE_PATTERNS[mobExtra];
        // Check if uncharged by looking at the extra string
        const isUncharged = mobExtra.startsWith('u');
        drawManticorePattern(colorPattern, x, y, isUncharged);
      }

      // only odd-size npcs are healable for now
      if (s % 2 == 1) {
        const centerOffset = (s - 1) / 2;
        ctx.lineWidth = 3;
        for (const [mX, mY] of minotaurs) {
          if (
            this.hasLOS(
              mX + 1,
              mY - 1,
              x + centerOffset,
              y - centerOffset,
              1,
              MINOTAUR_HEAL_RANGE,
              false
            )
          ) {
            ctx.strokeStyle = MINOTAUR_HEAL_COLOR;
            ctx.beginPath();
            ctx.moveTo((mX + 1.5) * TILE_SIZE, (mY - 0.5) * TILE_SIZE);
            ctx.lineTo((x + s / 2) * TILE_SIZE, (y - s / 2 + 1) * TILE_SIZE);
            ctx.stroke();
          }
        }
        ctx.lineWidth = 1;
      }

      if (this.showVenatorBounce && this.mousedOverNpc !== null && this.mousedOverNpc !== i) {
        // venator bounce candidate
        ctx.strokeStyle = "#ff69b4";
        ctx.lineWidth = 5;
        const [sX, sY, sT] = this.mobs[this.mousedOverNpc];
        if (
          canBounce(sX, sY, NPC_INFO[sT].size, this.mobs[i][0], this.mobs[i][1], s, (from, to) =>
            this.hasLOS(from[0], from[1], to[0], to[1], 1, VENATOR_LOS_RANGE, false)
          )
        ) {
          ctx.strokeRect(x * TILE_SIZE, (y - s + 1) * TILE_SIZE, TILE_SIZE * s, TILE_SIZE * s);
        }
        ctx.lineWidth = 1;
      }
      if (this.showVenatorBounce) {
        drawVenatorCenterTile(x, y, s, this.mousedOverNpc === i);
      }
    }

    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "red";
    ctx.fillText("North", (MAP_WIDTH / 2) * TILE_SIZE, 4);
    ctx.fillStyle = "white";
  ctx.fillText("South", (MAP_WIDTH / 2) * TILE_SIZE, (MAP_HEIGHT - 1) * TILE_SIZE + 4);
    
    // Hook to draw the predictive path on the canvas
    this.drawSuggestedPath();
  }

  public suggestedPath: Coordinates[] | null = null;
  public suggestedClicks: SolveClick[] = [];
  // The first click is a walk to a hidden tile to start the route from, drawn as "S".
  public suggestedStartHidden = false;

  public solveAndDrawTankPath() {
    const start: Coordinates = [this.selected[0], this.selected[1]];
    // The guide's advice is about off-ticking, so it belongs with a meta solve, not this one.
    this.guideNote = null;
    // A fragile plan still beats hiding (30000), but a sturdy one from a tile over beats it.
    const FRAGILE_COST = 20000;
    const FULL_SOLVES_FROM_MOVES = 1;
    let best = this.findTankPlan(start, this.mobs);
    let bestTotal = best ? best.score + (best.fragile ? FRAGILE_COST : 0) : Infinity;
    let lead: ReturnType<LineOfSight["hiddenMoves"]>[number] | null = null;

    // You don't have to start from the tile you're on. Any tile you can walk to without being seen is
    // just as good a start, and one tile over can turn a tricky solve into an easy one. A quick solve
    // from each hidden tile ranks them, then the best one gets a full solve. Staying put wins ties.
    if (!this.fromWaveStart) {
      const ranked = this.hiddenMoves(start)
        .map((move) => ({ move, quick: this.findTankPlan(move.at, move.mobs, true) }))
        .filter((r) => r.quick !== null)
        .sort((a, b) => a.quick!.score + a.move.cost - (b.quick!.score + b.move.cost));
      for (const { move, quick } of ranked.slice(0, FULL_SOLVES_FROM_MOVES)) {
        // The full solve only adds follow-ups and timing checks, so a start whose quick plan doesn't
        // already beat staying put isn't worth one.
        if (quick!.score + move.cost >= bestTotal) break;
        const plan = this.findTankPlan(move.at, move.mobs);
        if (!plan) continue;
        const total = plan.score + move.cost + (plan.fragile ? FRAGILE_COST : 0);
        if (total < bestTotal && (!best || this.isWorthMoving(best, plan))) {
          best = plan;
          bestTotal = total;
          lead = move;
        }
      }
    }

    if (best) {
      const route = best.route;
      // The plan from the hidden tile starts by standing there one tick, so the first click's wait
      // absorbs it.
      const clicks: SolveClick[] = lead
        ? [{ tile: lead.at, wait: route.clicks.length ? lead.wait + 1 : 0 }, ...route.clicks]
        : route.clicks;
      const steps = lead ? [...lead.steps, ...route.steps.slice(1)] : route.steps;
      const ticks = lead ? [...lead.ticks, ...route.ticks] : route.ticks;
      this.suggestedPath = steps;
      this.suggestedClicks = clicks;
      this.suggestedStartHidden = lead !== null;
      // The walk to S isn't counted: nothing can see you and the mobs have settled, so there's no
      // timing to it. Clicks and ticks are counted from S.
      const timed = lead ? route : { clicks, ticks };
      const clickCount = timed.clicks.length;
      const routeTicks = timed.ticks.length - 1;
      const walkToStart = lead ? "Start on S. " : "";
      this.solveRoute =
        clickCount === 0
          ? lead
            ? `${walkToStart}Then stay put.`
            : "Stay where you are."
          : `${walkToStart}${lead ? "Then " : ""}${clickCount} click${clickCount === 1 ? "" : "s"}, ${routeTicks} tick${routeTicks === 1 ? "" : "s"}.` +
            (timed.clicks.some((c) => c.wait > 0) ? " Wait where it says." : "") +
            ` About ${Math.round(best.damage)} damage on the way.`;
      this.replay = lead ? [...lead.ticks, ...best.replayPath] : best.replayPath;
      this.replayTick = 0;
      this.solveEndAttackable = best.attackable;

      const orbitWarning = best.onOrbit ? " You'll be next to a pillar, watch the Solarflare." : "";
      if (best.targetType < 0) {
        this.solveSummary = `No safe 1v1 yet - stay hidden here.${orbitWarning}`;
        this.solveTone = "warn";
      } else {
        const name = NPC_DISPLAY_NAME[best.targetType] ?? "target";
        const prayer = NPC_PROTECT_PRAYER[best.targetType];
        const prayerTip = prayer
          ? ` Pray ${prayer} when you get there.`
          : best.targetType === MANTICORE
            ? " Flick its orbs when you get there."
            : "";
        const healWarning = best.healed ? " A Minotaur can heal it." : "";
        const timingWarning = best.fragile ? " Tight timing - click right on the tick." : "";
        const afterKillWarning = best.exposedAfterKill ? " After the kill the others can reach you, so get back behind a pillar." : "";
        const dodgeWarning = best.noJavelinDodge ? " Nowhere safe to dodge its javelins." : "";
        this.solveSummary = `1v1 vs ${name}.${prayerTip}${healWarning}${orbitWarning}${timingWarning}${afterKillWarning}${dodgeWarning}`;
        this.solveTone =
          !best.healed && !best.onOrbit && !best.fragile && !best.exposedAfterKill && !best.noJavelinDodge ? "good" : "warn";
      }
      this.reset();
    } else {
      this.suggestedPath = null;
      this.suggestedClicks = [];
      this.solveRoute = null;
      this.solveEndAttackable = false;
      this.solveSummary = "No safe 1v1 from here. Step under or freeze.";
      this.solveTone = "bad";
      this.updateUi();
      this.drawWave();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Meta Solve: rather than isolating one mob, leave several attacking you on different ticks and
  // flick protection prayers so every attack is prayed. Each candidate route is played through a
  // fresh copy of the real engine, so the attack timing it judges - cooldowns, Manticore charging,
  // one Manticore volley at a time - is exactly what the replay then shows.
  // ---------------------------------------------------------------------------------------------

  // Plays `ticks`, then holds the last tile for `hold` more, through a fresh copy of the engine.
  private runEngine(ticks: Coordinates[], hold: number) {
    const sim = new LineOfSight();
    sim.mobs = JSON.parse(JSON.stringify(this.mobs));
    sim.mantimayhem3 = this.mantimayhem3;
    sim.manticoreTicksRemaining = { ...this.manticoreTicksRemaining };
    const path = [...ticks];
    for (let i = 0; i < hold; i++) path.push(ticks[ticks.length - 1]);
    sim.replay = path;
    sim.replayTick = 0;
    sim.selected = [...path[0]];
    for (let i = 0; i < path.length; i++) sim.step();
    return sim;
  }

  public solveMeta() {
    const start: Coordinates = [this.selected[0], this.selected[1]];
    const { reach, diagonals } = WEAPON_MODES[this.weaponMode];
    // Ticks simulated after the route ends, and how many of those to let settle before judging.
    const HOLD = 40;
    const SETTLE = 5;
    // A click still matters; a prayer switch is cheap for someone who flicks, but switching on
    // consecutive ticks between different mobs is what goes wrong in practice.
    const CLICK_PENALTY = 1000;
    const SWITCH_PENALTY = 300;
    const TIGHT_SWITCH_PENALTY = 1500;
    const SOLARFLARE_END_PENALTY = 20000;

    const types = this.mobs.map((m) => m[2]);
    const knownPattern = this.mobs.map((m) => m[2] !== MANTICORE || (!!m[6] && m[6] !== "u"));
    const minotaurAlive = types.includes(MINOTAUR);
    const guide = matchGuideSolve(this.mobs);
    this.guideNote = guide
      ? { label: guide.label, steps: guide.steps, unwinnable: !!guide.unwinnable }
      : null;

    const treeCache = new Map<string, PathTree>();
    const treeFrom = (from: Coordinates) => {
      const key = `${from[0]},${from[1]}`;
      let tree = treeCache.get(key);
      if (!tree) {
        tree = buildPathTree(from, MAP_WIDTH, MAP_HEIGHT, (x, y) => this.isPillar(x, y));
        treeCache.set(key, tree);
      }
      return tree;
    };
    const buildRoute = (clicks: SolveClick[], startDelay = 0): SolveRoute | null => {
      const steps: Coordinates[] = [start];
      const ticks: Coordinates[] = [start];
      for (let d = 0; d < startDelay; d++) ticks.push(start);
      let at = start;
      for (const { tile, wait, early } of clicks) {
        const leg = pathTo(treeFrom(at), tile);
        if (!leg) return null;
        let legTicks = runTicks(leg);
        if (early && legTicks.length > 1) legTicks = legTicks.slice(0, -1);
        steps.push(...leg.slice(1));
        ticks.push(...legTicks);
        if (legTicks.length) at = legTicks[legTicks.length - 1];
        for (let w = 0; w < wait; w++) ticks.push(at);
      }
      return { clicks, steps, ticks };
    };
    const open = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT && !this.isPillar(x, y);

    const evaluate = (route: SolveRoute) => {
      const sim = this.runEngine(route.ticks, HOLD);
      const [px, py] = sim.selected;
      if (sim.mobs.some((m) => m[2] < 8 && this.doesCollide(px, py, 1, m[0], m[1], NPC_INFO[m[2]].size))) return null;

      const timeline = readTimeline(sim.tape as number[][], types, knownPattern);
      const from = route.ticks.length - 1 + SETTLE;
      const plan = flickPlan(timeline, from, timeline.length);
      // Every tick has to be flickable once you've arrived. Nothing attacking at all is fine - that's
      // a safespot, e.g. hitting a melee mob diagonally when it can't hit you back.
      if (plan.clashes > 0) return null;
      // You're melee, so something has to be in your reach to fight.
      const inReach = sim.mobs.filter(
        (m) => m[2] < 8 && this.hasLOS(m[0], m[1], px, py, NPC_INFO[m[2]].size, reach, true, diagonals),
      );
      if (inReach.length === 0) return null;

      // Damage before the rhythm settles: ticks where two styles land at once, so you pray the one
      // that would have hurt most and take the rest.
      let damage = 0;
      for (let tick = 0; tick < from && tick < timeline.length; tick++) {
        const attacks = timeline[tick];
        if (!tickPrayer(attacks).clash) continue;
        const byStyle = new Map<PrayerStyle, number>();
        for (const a of attacks) {
          const cost = expectedAttackDamage(a.type, a.style, this.playerDefence, this.invocations);
          byStyle.set(a.style, (byStyle.get(a.style) ?? 0) + cost);
        }
        const costs = [...byStyle.values()];
        damage += costs.reduce((sum, c) => sum + c, 0) - Math.max(...costs);
      }

      const fightingMinotaur = inReach.some((m) => m[2] === MINOTAUR);
      const onOrbit = this.solarflare && this.isOnSolarflareOrbit(px, py);
      let score =
        route.clicks.length * CLICK_PENALTY +
        (route.ticks.length - 1) * 10 +
        damage * 50 +
        plan.switches * SWITCH_PENALTY +
        plan.tightSwitches * TIGHT_SWITCH_PENALTY;
      if (minotaurAlive) score += fightingMinotaur ? -5000 : 5000;
      if (onOrbit) score += SOLARFLARE_END_PENALTY;
      const attackers = [...new Set(plan.sequence.flatMap((s) => s.mobs))];
      return { route, score, plan, damage, inReach, attackers, onOrbit };
    };

    type MetaResult = NonNullable<ReturnType<typeof evaluate>>;
    const results: MetaResult[] = [];
    const routeKey = (route: SolveRoute) => route.ticks.map(([x, y]) => `${x},${y}`).join(">");
    const tried = new Set<string>();
    const consider = (route: SolveRoute | null) => {
      if (!route) return;
      const result = evaluate(route);
      if (result) results.push(result);
    };
    const add = (clicks: SolveClick[]) => consider(buildRoute(clicks));

    // Candidates: stay put, one click to anywhere close, and A/B steps - out to a nearby tile, wait,
    // then back - which is how you get two mobs to see you on different ticks.
    add([]);
    for (let y = start[1] - 6; y <= start[1] + 6; y++) {
      for (let x = start[0] - 6; x <= start[0] + 6; x++) {
        if ((x === start[0] && y === start[1]) || !open(x, y)) continue;
        add([{ tile: [x, y], wait: 0 }]);
      }
    }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const out: Coordinates = [start[0] + dx, start[1] + dy];
        if ((dx === 0 && dy === 0) || !open(out[0], out[1])) continue;
        for (let wait = 0; wait <= 4; wait++) add([{ tile: out, wait }, { tile: start, wait: 0 }]);
      }
    }

    // Longer routes: the community guide calls these "Z-stacks" - step out, drop back behind the
    // pillar, step out again - and they are how you stagger three mobs that all attack on the same
    // cycle. Every sequence of clicks is far too much to enumerate, so this keeps a beam of the
    // prefixes closest to a clean rhythm and only branches to tiles that change who can see you.
    const DEEP_CLICKS = 4;
    const BEAM = 20;
    const BRANCH_RADIUS = 4;
    const TILES_PER_VIEW = 2;
    const PROBE_HOLD = 18;
    const DEEP_BUDGET_MS = 1500;

    // A cheap read on a prefix: how far it is from a flickable rhythm, without the full hold.
    const rank = (route: SolveRoute) => {
      const sim = this.runEngine(route.ticks, PROBE_HOLD);
      const [px, py] = sim.selected;
      if (sim.mobs.some((m) => m[2] < 8 && this.doesCollide(px, py, 1, m[0], m[1], NPC_INFO[m[2]].size))) return null;
      const timeline = readTimeline(sim.tape as number[][], types, knownPattern);
      const plan = flickPlan(timeline, route.ticks.length - 1 + SETTLE, timeline.length);
      const inReach = sim.mobs.some(
        (m) => m[2] < 8 && this.hasLOS(m[0], m[1], px, py, NPC_INFO[m[2]].size, reach, true, diagonals),
      );
      return plan.clashes * 1000 + (inReach ? 0 : 300) + route.ticks.length;
    };

    // Where it is worth clicking next: one tile per way of being seen, nearest first. Two tiles that
    // the same mobs can see play the same, so only the closest of them is worth trying.
    const branchTiles = (route: SolveRoute) => {
      const at = route.ticks[route.ticks.length - 1];
      const mobsThen = this.runEngine(route.ticks, 0).mobs;
      const byView = new Map<string, Coordinates[]>();
      for (let radius = 1; radius <= BRANCH_RADIUS; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const tile: Coordinates = [at[0] + dx, at[1] + dy];
            if (!open(tile[0], tile[1])) continue;
            const view = mobsThen
              .map((m) =>
                m[2] < 8 &&
                this.hasLOS(m[0], m[1], tile[0], tile[1], NPC_INFO[m[2]].size, NPC_INFO[m[2]].range, true)
                  ? "1"
                  : "0",
              )
              .join("");
            const group = byView.get(view) ?? [];
            if (group.length < TILES_PER_VIEW) {
              group.push(tile);
              byView.set(view, group);
            }
          }
        }
      }
      return [...byView.values()].flat();
    };

    // If a short route already flicks cleanly and takes no damage, nothing longer can be worth the
    // extra clicks, so don't spend the time looking.
    const cleanAlready = results.some((r) => r.damage < 1 && r.plan.tightSwitches === 0);
    const deadline = Date.now() + (cleanAlready ? 0 : DEEP_BUDGET_MS);
    let beam = [buildRoute([])].filter((r): r is SolveRoute => r !== null);
    for (let depth = 1; depth <= DEEP_CLICKS && beam.length > 0 && Date.now() < deadline; depth++) {
      const next: Array<{ route: SolveRoute; score: number }> = [];
      for (const prefix of beam) {
        if (Date.now() > deadline) break;
        for (const tile of branchTiles(prefix)) {
          for (let wait = 0; wait <= 4; wait++) {
            const route = buildRoute([...prefix.clicks, { tile, wait }]);
            if (!route) continue;
            const key = routeKey(route);
            if (tried.has(key)) continue;
            tried.add(key);
            const score = rank(route);
            if (score === null) continue;
            // A prefix that already flicks cleanly is a solve in its own right, so judge it properly.
            if (score < 1000) consider(route);
            next.push({ route, score });
          }
        }
      }
      next.sort((a, b) => a.score - b.score);
      beam = next.slice(0, BEAM).map((n) => n.route);
    }

    results.sort((a, b) => a.score - b.score);

    // Off-ticks hinge on timing, so prefer a plan that still flicks with the start a tick late, or
    // any click a tick early or late.
    const holdsUp = (route: SolveRoute) => {
      const { clicks } = route;
      const variants: Array<SolveRoute | null> = [];
      if (clicks.length > 0) variants.push(buildRoute(clicks, 1));
      for (let i = 0; i < clicks.length - 1; i++) {
        variants.push(buildRoute(clicks.map((c, j) => (j === i ? { ...c, wait: c.wait + 1 } : c))));
        variants.push(
          buildRoute(
            clicks.map((c, j) => (j === i ? (c.wait > 0 ? { ...c, wait: c.wait - 1 } : { ...c, early: true }) : c)),
          ),
        );
      }
      return variants.every((v) => !v || evaluate(v) !== null);
    };
    let chosen: MetaResult | null = null;
    let fragile = false;
    for (const result of results.slice(0, 20)) {
      if (holdsUp(result.route)) {
        chosen = result;
        break;
      }
    }
    if (!chosen && results.length > 0) {
      chosen = results[0];
      fragile = true;
    }

    this.suggestedStartHidden = false;
    if (!chosen) {
      this.suggestedPath = null;
      this.suggestedClicks = [];
      this.solveRoute = null;
      this.solveEndAttackable = false;
      this.solveSummary = guide?.unwinnable
        ? "No meta solve - the guide rates this stack unsolvable, you have to tank something. Press Solve Tank Path for the safest way out."
        : "No meta solve from here - nothing settles into a flickable rhythm. Press Solve Tank Path to find a 1v1.";
      this.solveTone = "bad";
      this.updateUi();
      this.drawWave();
      return;
    }

    const { route, plan, damage, inReach, attackers } = chosen;
    this.suggestedPath = route.steps;
    this.suggestedClicks = route.clicks;
    this.solveEndAttackable = true;

    const cycle = attackers.some((i) => types[i] === MANTICORE) ? 10 : 5;
    const counts = new Map<string, number>();
    for (const i of attackers) {
      const name = NPC_DISPLAY_NAME[types[i]] ?? "mob";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const plural = (name: string) => (name.endsWith("us") ? `${name.slice(0, -2)}i` : `${name}s`);
    const names = [...counts].map(([name, n]) => (n > 1 ? `${n} ${plural(name)}` : name));
    const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    const target = inReach.find((m) => m[2] === MINOTAUR) ?? inReach[0];
    const onePrayer = new Set(plan.sequence.map((s) => s.prayer)).size === 1;
    const opening =
      attackers.length === 0
        ? "Safespot - nothing can hit you here."
        : attackers.length === 1
          ? `1v1 vs ${who}.`
          : onePrayer
            ? `${who} on you.`
            : `${who} off-ticked.`;
    const warnings =
      (fragile ? " Tight timing - click right on the tick." : "") +
      (plan.tightSwitches > 0 ? " Needs 1-tick flicks." : "") +
      (chosen.onOrbit ? " You'll be next to a pillar, watch the Solarflare." : "");
    this.solveSummary =
      `Meta: ${opening} Attack the ${NPC_DISPLAY_NAME[target[2]] ?? "target"}.` +
      (attackers.length > 0 ? ` ${describeRhythm(plan.sequence, cycle)}` : "") +
      warnings;
    this.solveTone = warnings ? "warn" : "good";

    const clickCount = route.clicks.length;
    const routeTicks = route.ticks.length - 1;
    const damageText = ` About ${Math.round(damage)} damage if you flick perfectly.`;
    this.solveRoute =
      clickCount === 0
        ? `Stay where you are.${damageText}`
        : `${clickCount} click${clickCount === 1 ? "" : "s"}, ${routeTicks} tick${routeTicks === 1 ? "" : "s"}.` +
          (route.clicks.some((c) => c.wait > 0) ? " Wait where it says." : "") +
          damageText;

    // Replay a little past arrival so you can watch the rhythm form on the tick strip.
    const end = route.ticks[route.ticks.length - 1];
    this.replay = [...route.ticks];
    for (let i = 0; i < SETTLE + 10; i++) this.replay.push(end);
    this.replayTick = 0;
    this.reset();
  }

  // Moving first is only worth suggesting when it buys something you'd notice. A plan that scores a
  // little better but plays the same just swaps a good solve for a different one.
  private isWorthMoving(
    stay: NonNullable<ReturnType<LineOfSight["findTankPlan"]>>,
    move: NonNullable<ReturnType<LineOfSight["findTankPlan"]>>,
  ) {
    const warned = (p: typeof stay) => p.fragile || p.healed || p.onOrbit || p.exposedAfterKill || p.noJavelinDodge;
    return (
      (stay.targetType < 0 && move.targetType >= 0) ||
      (move.targetType === MINOTAUR && stay.targetType !== MINOTAUR) ||
      (warned(stay) && !warned(move)) ||
      // the walk to the hidden tile counts as a click
      move.route.clicks.length + 1 < stay.route.clicks.length ||
      stay.damage - move.damage >= 5
    );
  }

  // Tiles a few steps away you can walk to without anything seeing you, with the mobs as they'll be
  // once they've stopped reacting to the move.
  private hiddenMoves(start: Coordinates) {
    const MAX_STEPS = 2;
    const SETTLE_MAX = 15;
    const CALM_TICKS = 3;
    // Much less than a click in the solver (1000): you walk there while hidden with no timing to hit,
    // so it only has to lose ties against staying put.
    const MOVE_COST = 300;
    const tree = buildPathTree(start, MAP_WIDTH, MAP_HEIGHT, (x, y) => this.isPillar(x, y));
    const moves: Array<{ at: Coordinates; mobs: any[]; wait: number; steps: Coordinates[]; ticks: Coordinates[]; cost: number }> = [];
    for (let y = start[1] - MAX_STEPS; y <= start[1] + MAX_STEPS; y++) {
      for (let x = start[0] - MAX_STEPS; x <= start[0] + MAX_STEPS; x++) {
        if ((x === start[0] && y === start[1]) || x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) continue;
        const leg = pathTo(tree, [x, y]);
        if (!leg || leg.length - 1 > MAX_STEPS) continue;

        const mobs = JSON.parse(JSON.stringify(this.mobs));
        if (mobs.some((m: any) => m[2] !== 0 && m[2] < 8 && this.doesCollide(x, y, 1, m[0], m[1], NPC_INFO[m[2]].size))) continue;
        // Tick 0 is the mobs reacting to the start tile, as in the solver's own simulation.
        const ticks: Coordinates[] = [start, ...runTicks(leg)];
        let seen = false;
        const tick = (px: number, py: number) => {
          let moved = false;
          for (let i = 0; i < mobs.length; i++) if (this.simMobStep(mobs, i, px, py)) moved = true;
          if (this.simSeenBy(mobs, px, py).length > 0) seen = true;
          return moved;
        };
        for (const [px, py] of ticks) {
          tick(px, py);
          if (seen) break;
        }
        let wait = 0;
        let calm = 0;
        while (!seen && calm < CALM_TICKS && wait < SETTLE_MAX) {
          calm = tick(x, y) ? 0 : calm + 1;
          ticks.push([x, y]);
          wait++;
        }
        if (seen || calm < CALM_TICKS) continue;
        moves.push({ at: [x, y], mobs, wait, steps: leg, ticks, cost: MOVE_COST });
      }
    }
    return moves;
  }

  // One tick of dumb pathing for a simulated mob towards the player, as moveMobs() does it.
  // Returns whether the mob moved.
  private simMobStep(mobs: any[], i: number, px: number, py: number, canMove = true, canGainLos = true) {
    const mob = mobs[i];
    const t = mob[2];
    if (t === 0 || t >= 8) return false;
    const { size: s, range: r } = NPC_INFO[t];
    if (this.doesCollide(px, py, 1, mob[0], mob[1], s)) return false;
    if (!canMove || (canGainLos && this.hasLOS(mob[0], mob[1], px, py, s, r, true))) return false;
    const dx = mob[0] + Math.sign(px - mob[0]);
    let dy = mob[1] + Math.sign(py - mob[1]);
    // Mirrors moveMobs(): a mob can't step diagonally onto the player's own tile,
    // which is exactly the corner-safespot trick this solver is meant to find.
    // Without this, the preview simulation can predict a mob ends up somewhere
    // different (and less safe) than it actually will when the path is replayed.
    if (this.doesCollide(dx, dy, s, px, py, 1)) dy = mob[1];
    const step = this.npcStep(mob[0], mob[1], s, i, dx, dy, mobs);
    if (!step) return false;
    mob[0] = step[0];
    mob[1] = step[1];
    return true;
  }

  private simSeenBy(mobs: any[], px: number, py: number) {
    const seen: number[] = [];
    mobs.forEach((m, i) => {
      if (m[2] !== 0 && m[2] < 8 && this.hasLOS(m[0], m[1], px, py, NPC_INFO[m[2]].size, NPC_INFO[m[2]].range, true)) seen.push(i);
    });
    return seen;
  }

  // The best plan from `start` with the mobs where `mobs` has them, or null if nothing beats giving
  // up. `quick` skips the follow-up routes and timing checks, for ranking many starts cheaply.
  private findTankPlan(start: Coordinates, mobs: any[], quick = false) {
    let minotaurAlive = mobs.some((m: any) => m[2] === MINOTAUR);
    const { reach: weaponReach, diagonals: weaponDiagonals } = WEAPON_MODES[this.weaponMode];

    // Expected damage each mob type deals per tick while it can hit you, with your run prayer up.
    const damagePerTick: Record<number, number> = {};
    const prayedTypes = new Set<number>();
    for (const type of Object.values(NPC_TYPES)) {
      damagePerTick[type] = expectedDamagePerTick(type, this.playerDefence, this.runPrayer, this.invocations);
      if (isPrayedAgainst(type, this.runPrayer)) prayedTypes.add(type);
    }
    const SIM_TICKS = 45;
    // Long routes (a wait, then a late step in) still need time for the mobs to walk over and settle
    // before the end state is judged, so every route gets at least this many ticks after it ends.
    const SETTLE_TICKS = 25;

    // A second click is worth it only when it buys a materially better fight: this is roughly 100
    // ticks of running or 40 points of modelled damage, and far below one tile of lost reach.
    const CLICK_PENALTY = 1000;
    // Two threats able to hit you on the same tick is what kills a no-flick tank, and the per-mob
    // expected damage only adds hits up without seeing them land together. Mobs your run prayer blocks
    // don't count here. Each extra simultaneous threat on a route tick costs half a click: a couple of
    // stacked ticks is enough to justify a second click.
    const STACKED_THREAT_PENALTY = 500;
    // Solarflare's orb is a single tile circling each pillar. A few ticks on a pillar tile can be
    // timed around it, so only ending there - standing in its path for the whole fight - costs.
    // Any off-pillar 1v1 within a tile of reach beats this, but it still beats hiding (30000).
    const SOLARFLARE_END_PENALTY = 20000;

    // Every candidate is a list of clicks walked with the game's own player pathing, so the replay
    // is what actually happens when you click those tiles and the click count is exact.
    const treeCache = new Map<string, PathTree>();
    const treeFrom = (from: Coordinates) => {
      const key = `${from[0]},${from[1]}`;
      let tree = treeCache.get(key);
      if (!tree) {
        tree = buildPathTree(from, MAP_WIDTH, MAP_HEIGHT, (x, y) => this.isPillar(x, y));
        treeCache.set(key, tree);
      }
      return tree;
    };
    // `early` and `startDelay` only exist to replay a plan with human timing slips: `early` means the
    // next click lands one tick before you reach this tile, `startDelay` holds the start a few ticks.
    const buildRoute = (clicks: SolveClick[], startDelay = 0): SolveRoute | null => {
      const steps: Coordinates[] = [start];
      const ticks: Coordinates[] = [start];
      for (let d = 0; d < startDelay; d++) ticks.push(start);
      let at = start;
      for (const { tile, wait, early } of clicks) {
        const leg = pathTo(treeFrom(at), tile);
        if (!leg) return null;
        let legTicks = runTicks(leg);
        if (early && legTicks.length > 1) legTicks = legTicks.slice(0, -1);
        steps.push(...leg.slice(1));
        ticks.push(...legTicks);
        if (legTicks.length) at = legTicks[legTicks.length - 1];
        for (let w = 0; w < wait; w++) ticks.push(at);
      }
      return { clicks, steps, ticks };
    };

    const routes: SolveRoute[] = [buildRoute([])!];

    // 1. ONE-CLICK RUNS: click any reachable tile and let the game path there.
    const startTree = treeFrom(start);
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        if (x === start[0] && y === start[1]) continue;
        if (startTree.parent[y * MAP_WIDTH + x] === -1) continue;
        // Ranking a start only needs the nearby runs; the full solve still tries the whole map.
        if (quick && Math.max(Math.abs(x - start[0]), Math.abs(y - start[1])) > 10) continue;
        routes.push(buildRoute([{ tile: [x, y], wait: 0 }])!);
      }
    }

    // 2. BOOMERANG LURES: click up to 8 tiles out along a straight open line, wait 0-3 ticks,
    // then click back to the starting tile.
    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      for (let dist = 1; dist <= 8; dist++) {
        const out: Coordinates = [start[0] + dx * dist, start[1] + dy * dist];
        if (out[0] < 0 || out[0] >= MAP_WIDTH || out[1] < 0 || out[1] >= MAP_HEIGHT) break;
        if (this.isPillar(out[0], out[1])) break;
        for (let wait = 0; wait <= 3; wait++) {
          const route = buildRoute([{ tile: out, wait }, { tile: start, wait: 0 }]);
          if (route) routes.push(route);
        }
      }
    }

    // 3. SOLARFLARE TRAP AND STEP OFF: you can still trap on a pillar tile for a few ticks by timing
    // the orb, then step off before the fight. Stepping off can drag mobs back into range, which the
    // simulation below catches.
    if (this.solarflare) {
      for (let ty = 0; ty < MAP_HEIGHT; ty++) {
        for (let tx = 0; tx < MAP_WIDTH; tx++) {
          if (!this.isOnSolarflareOrbit(tx, ty) || startTree.parent[ty * MAP_WIDTH + tx] === -1) continue;
          if (quick && Math.max(Math.abs(tx - start[0]), Math.abs(ty - start[1])) > 10) continue;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const off: Coordinates = [tx + dx, ty + dy];
              if (off[0] < 0 || off[1] < 0 || off[0] >= MAP_WIDTH || off[1] >= MAP_HEIGHT) continue;
              if (this.isPillar(off[0], off[1]) || this.isOnSolarflareOrbit(off[0], off[1])) continue;
              for (const wait of [0, 2, 4]) {
                const route = buildRoute([{ tile: [tx, ty], wait }, { tile: off, wait: 0 }]);
                if (route) routes.push(route);
              }
            }
          }
        }
      }
    }


    // An out-of-reach 1v1 is only worth anything if you can work the target into reach and still only
    // be seen by it. The most promising ones get follow-up routes, evaluated later in this same loop:
    // step straight into reach, or stand while it walks in and then shuffle a tile or two so it follows
    // you round a corner where nothing else can see you.
    // Follow-ups can themselves be expanded once more: a shuffle that brings the target to 2 tiles can
    // still need a final step in with a 1-tile weapon.
    const followUpDepth = new WeakMap<SolveRoute, number>();
    const outOfReach: Array<{ route: SolveRoute; score: number; depth: number; target: [number, number, number] }> = [];
    const MAX_STEP_IN = 3;
    const FOLLOW_UP_CANDIDATES = 3;
    const FOLLOW_UP_ROUNDS = 2;
    const FOLLOW_UP_WAITS = [0, 2, 4, 6];
    // Long enough for a target a few tiles off to walk over before you step in. Only single steps get
    // these, to keep the number of simulated routes down.
    const LONG_WAITS = [10, 20, 30];
    const queueFollowUps = () => {
      const open = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT && !this.isPillar(x, y);

      outOfReach.sort((a, b) => a.score - b.score);
      const expand = outOfReach.slice(0, FOLLOW_UP_CANDIDATES);
      outOfReach.length = 0;
      for (const { route, depth, target: [tx, ty, ts] } of expand) {
        const push = (clicks: SolveClick[]) => {
          const followUp = buildRoute(clicks);
          if (followUp) {
            followUpDepth.set(followUp, depth + 1);
            routes.push(followUp);
          }
        };
        const end = route.steps[route.steps.length - 1];
        const last = route.clicks[route.clicks.length - 1];
        const arriveThenWait = (wait: number): SolveClick[] =>
          last
            ? [...route.clicks.slice(0, -1), { tile: last.tile, wait: last.wait + wait }]
            : wait > 0
              ? [{ tile: end, wait }]
              : [];

        // Step straight into reach, either right away or once the target has had time to walk over.
        for (const wait of [0, ...LONG_WAITS]) {
          const arrive = arriveThenWait(wait);
          for (let sy = ty - ts + 1 - weaponReach; sy <= ty + weaponReach; sy++) {
            for (let sx = tx - weaponReach; sx <= tx + ts - 1 + weaponReach; sx++) {
              if (open(sx, sy) && this.hasLOS(tx, ty, sx, sy, ts, weaponReach, true, weaponDiagonals)) {
                push([...arrive, { tile: [sx, sy], wait: 0 }]);
              }
            }
          }
        }

        // Or a single step to any neighbouring tile after a long wait.
        for (const wait of LONG_WAITS) {
          const arrive = arriveThenWait(wait);
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if ((dx === 0 && dy === 0) || !open(end[0] + dx, end[1] + dy)) continue;
              push([...arrive, { tile: [end[0] + dx, end[1] + dy], wait: 0 }]);
            }
          }
        }

        // Or a quick shuffle: wait a little, step a tile, and optionally step again.
        for (const wait of FOLLOW_UP_WAITS) {
          const arrive = arriveThenWait(wait);
          for (let dy1 = -1; dy1 <= 1; dy1++) {
            for (let dx1 = -1; dx1 <= 1; dx1++) {
              const first: Coordinates = [end[0] + dx1, end[1] + dy1];
              if ((dx1 === 0 && dy1 === 0) || !open(first[0], first[1])) continue;
              push([...arrive, { tile: first, wait: 0 }]);
              for (let dy2 = -2; dy2 <= 2; dy2++) {
                for (let dx2 = -2; dx2 <= 2; dx2++) {
                  const second: Coordinates = [first[0] + dx2, first[1] + dy2];
                  if ((dx2 === 0 && dy2 === 0) || !open(second[0], second[1])) continue;
                  push([...arrive, { tile: first, wait: 0 }, { tile: second, wait: 0 }]);
                }
              }
            }
          }
        }
      }
    };

    const moveSimMob = (mobs: any[], i: number, px: number, py: number, canMove = true, canGainLos = true) =>
      this.simMobStep(mobs, i, px, py, canMove, canGainLos);
    const seenBy = (mobs: any[], px: number, py: number) => this.simSeenBy(mobs, px, py);

    let routeIndex = 0;
    let followUpRound = 0;
    const evaluateRoute = (route: SolveRoute) => {
      const tickPath = route.ticks;

      let futureMobs = JSON.parse(JSON.stringify(mobs));
      let damageTaken = 0;
      let stackedThreats = 0;
      // How many mobs can hit you once the route settles - mages included. Your run prayer is only
      // up while you move; on arrival you switch to protect against the one mob you're fighting, so
      // anything else that can see the end tile (a mage too) breaks the 1v1.
      let settledVisible = 0;
      let settledVisibleIndex = -1;

      let paddedPath: Coordinates[] = [];
      let lastMeaningfulTick = tickPath.length - 1;

      // Starts at tick 0, not 1: during a real replay, reset() points this.selected at
      // replay[0] (the starting tile) *before* the first step() call, and that first call's
      // advanceReplay() re-reads replay[0] (tickCount is still 0) before moveMobs() runs -
      // so the mobs get one full reaction tick against the player's starting tile before the
      // player has moved at all. Starting this loop at tick 1 skipped modelling that tick
      // entirely, which left the simulated mobs permanently a tick behind their real
      // counterparts (e.g. a mob that would have already turned a pillar corner for real was
      // still predicted to be approaching it), so the solver could accept a tile as a clean
      // 1v1 that a mob had actually already reached.
      const simTicks = Math.max(SIM_TICKS, tickPath.length - 1 + SETTLE_TICKS);
      for (let tick = 0; tick <= simTicks; tick++) {
        let pIndex = Math.min(tick, tickPath.length - 1);
        let px = tickPath[pIndex][0];
        let py = tickPath[pIndex][1];

        paddedPath.push([px, py] as Coordinates);
        let npcMovedThisTick = false;

        // Mirrors this.tickCount at the point moveMobs()/processAttacks() would run for this
        // same player position during a real replay (call tick+1 has this.tickCount === tick
        // at that point, since tickCount starts at 0 after reset() and only increments at the
        // end of step(), after moveMobs()/processAttacks() have already run). Keeping this in
        // sync with step()'s canMove/canGainLos/canAttack gating is what makes the "From Wave
        // Start" delay behave the same way here as it does when the path is actually played.
        const simTickCount = tick;
        const canMove = this.fromWaveStart ? simTickCount > 0 : true;
        const canGainLos = this.fromWaveStart ? simTickCount > 1 : true;
        const canAttack = this.fromWaveStart ? simTickCount >= DELAY_FIRST_ATTACK_TICKS : true;
        let threatsThisTick = 0;

        for (let i = 0; i < futureMobs.length; i++) {
          let mob = futureMobs[i];
          let t = mob[2];
          if (t === 0 || t >= 8) continue;
          let s = NPC_INFO[t].size;
          let r = NPC_INFO[t].range;

          if (moveSimMob(futureMobs, i, px, py, canMove, canGainLos)) npcMovedThisTick = true;

          let isPlayerMoving = (tick < tickPath.length);
          if (canAttack && this.hasLOS(mob[0], mob[1], px, py, s, r, true)) {
              if (!prayedTypes.has(t)) threatsThisTick++;
              if (isPlayerMoving) damageTaken += damagePerTick[t] ?? 0;
          }
        }

        if (tick < tickPath.length && threatsThisTick > 1) {
            stackedThreats += threatsThisTick - 1;
        }

        if (npcMovedThisTick) {
            lastMeaningfulTick = Math.max(lastMeaningfulTick, tick);
        }

        if (tick >= simTicks - 10) {
           let visibleNow = 0;
           let visibleIndexNow = -1;
           
           for (let i = 0; i < futureMobs.length; i++) {
              let mob = futureMobs[i];
              let t = mob[2];
              if (t === 0 || t >= 8) continue;
              if (this.hasLOS(mob[0], mob[1], px, py, NPC_INFO[t].size, NPC_INFO[t].range, true)) {
                 visibleNow++;
                 visibleIndexNow = i;
              }
           }
           
           // Take the reading from whichever tick we just simulated, not the historical
           // peak across the window. This used to only ratchet upward, so a mob that had
           // fleeting LOS while still approaching (before settling into a clean 1v1) would
           // permanently mark the tile as multi-target even though it settles safely.
           settledVisible = visibleNow;
           settledVisibleIndex = visibleIndexNow;
        }
      }

      let score = 100000; 
      let px = tickPath[tickPath.length - 1][0];
      let py = tickPath[tickPath.length - 1][1];

      let steppedUnder = false;
      for (let i = 0; i < futureMobs.length; i++) {
         let mob = futureMobs[i];
         let t = mob[2];
         if (t === 0 || t >= 8) continue;
         
         let ts = NPC_INFO[t].size;
         let mx = mob[0];
         let my = mob[1];
         
         if (px >= mx && px <= mx + ts - 1 && py >= my - ts + 1 && py <= my) {
             steppedUnder = true;
             break;
         }
      }

      let candTargetType = -1;
      let candAttackable = false;
      let candDist = -1;

      // A 1v1 means exactly one mob, of any style, can hit you once you've arrived.
      const targetIndex = !steppedUnder && settledVisible === 1 ? settledVisibleIndex : -1;

      if (steppedUnder) {
         score = 500000;
      } else if (targetIndex !== -1) {
         let tMob = futureMobs[targetIndex];
         let tId = tMob[2];
         let ts = NPC_INFO[tId].size;

         // Chebyshev tile-distance from the player to the target's hitbox - 1 means adjacent
         // (meleeable), independent of the target's own attack range. The player's loadout
         // (Justiciar/Bulwark) is melee-only, so a "solved" 1v1 against a ranged/mage mob
         // still has to end with you standing next to it - being the only thing it can see
         // from 5 tiles away just means you tank unanswerable chip damage forever, since it
         // won't close the distance once it already has LOS and is in range.
         //
         // Out-of-reach 1v1s are never picked directly (see the step-in routes below), so this
         // penalty only orders them against each other.
         //
         // Distance alone can't decide whether you can actually swing, so ask the engine's own
         // reach rule with this weapon's reach and diagonal capability.
         let dx = Math.max(0, tMob[0] - px, px - (tMob[0] + ts - 1));
         let dy = Math.max(0, tMob[1] - ts + 1 - py, py - tMob[1]);
         let meleeDist = Math.max(dx, dy);
         let canMeleeBack = this.hasLOS(tMob[0], tMob[1], px, py, ts, weaponReach, true, weaponDiagonals);

         candTargetType = tId;
         candAttackable = canMeleeBack;
         candDist = meleeDist;

         score = 0;
         // Penalty scales with how many tiles you'd still have to close. A tile that's within
         // reach but blocked (e.g. a pillar corner clipping the line) costs one unit, same as
         // needing a single step, since either way it's one reposition away from a kill spot.
         if (!canMeleeBack) score += Math.max(1, meleeDist - weaponReach + 1) * 10000;
         if (tId === MINOTAUR) score -= 5000;
         else if (minotaurAlive) score += 5000;
         else score -= 2000;

      } else if (settledVisible === 0) {
         score = 30000;
      } else {
         score = 80000 + (settledVisible * 10000);
      }

      // 50 points per expected HP lost on the way, so a second click (1000) is worth about 20 HP.
      score += damageTaken * 50;
      score += stackedThreats * STACKED_THREAT_PENALTY;
      score += (tickPath.length * 10);

      score += route.clicks.length * CLICK_PENALTY;

      const endsOnOrbit = this.solarflare && this.isOnSolarflareOrbit(px, py);
      if (endsOnOrbit) score += SOLARFLARE_END_PENALTY;

      // --- SMART MINOTAUR HEAL PENALTY ---
      let minotaurHealPenalty = 0;
      if (minotaurAlive && targetIndex !== -1) {
         let targetMob = futureMobs[targetIndex];
         let tId = targetMob[2];
         
         if (tId !== 0 && tId < 8 && tId !== MINOTAUR) {
             let currentMinotaurs = futureMobs.filter((m: any) => m[2] === MINOTAUR);
             for (let mino of currentMinotaurs) {
                 let s = NPC_INFO[tId].size;
                 if (s % 2 === 1) { 
                     let centerOffset = (s - 1) / 2;
                     if (this.hasLOS(mino[0] + 1, mino[1] - 1, targetMob[0] + centerOffset, targetMob[1] - centerOffset, 1, MINOTAUR_HEAL_RANGE, false)) {
                         minotaurHealPenalty += 40000; 
                     }
                 }
             }
         }
      }
      score += minotaurHealPenalty;

      const targetMob = targetIndex !== -1 ? futureMobs[targetIndex] : null;
      return {
        route,
        score,
        targetIndex,
        attackable: candAttackable,
        dist: candDist,
        target: targetMob ? ([targetMob[0], targetMob[1], NPC_INFO[targetMob[2]].size] as [number, number, number]) : null,
        replayPath: paddedPath.slice(0, lastMeaningfulTick + 1),
        targetType: candTargetType,
        healed: minotaurHealPenalty > 0,
        onOrbit: endsOnOrbit,
        damage: damageTaken,
        end: [px, py] as Coordinates,
        endMobs: futureMobs,
        exposedAfterKill: false,
        noJavelinDodge: false,
      };
    };

    type Evaluation = ReturnType<typeof evaluateRoute>;
    const candidates: Evaluation[] = [];
    const isClean = (e: Evaluation) => e.targetIndex !== -1 && e.attackable;

    // What's left once the 1v1 is dead. A kill tile in the middle of the rest of the stack means
    // eating hits to get back behind a pillar. It's fine if nothing else can see you, or if one mob
    // can and it's your next 1v1: already in reach, or still alone once you click it and walk over.
    // Still far better than hiding (30000), so a solve is never lost over this.
    const AFTER_KILL_TICKS = 8;
    const AFTER_KILL_PENALTY = 8000;
    const settleAfterKill = (mobs: any[], px: number, py: number) => {
      for (let tick = 0; tick < AFTER_KILL_TICKS; tick++) {
        for (let i = 0; i < mobs.length; i++) moveSimMob(mobs, i, px, py);
      }
      return seenBy(mobs, px, py);
    };
    const afterKillCache = new Map<string, boolean>();
    const isExposedAfterKill = (e: Evaluation) => {
      const [px, py] = e.end;
      const rest: any[] = e.endMobs.filter((_m: any, i: number) => i !== e.targetIndex).map((m: any) => [...m]);
      const key = `${px},${py}:${rest.map((m) => `${m[0]},${m[1]},${m[2]}`).join(";")}`;
      const cached = afterKillCache.get(key);
      if (cached !== undefined) return cached;

      const canHit = (mob: any, x: number, y: number) =>
        this.hasLOS(mob[0], mob[1], x, y, NPC_INFO[mob[2]].size, weaponReach, true, weaponDiagonals);
      const exposed = (() => {
        const seen = settleAfterKill(rest, px, py);
        if (seen.length === 0) return false;
        if (seen.length > 1) return true;
        const next = seen[0];
        if (canHit(rest[next], px, py)) return false;
        // Clicking it walks the game's route to the nearest tile you can hit it from, which can drag
        // you into view of another mob. A cleaner tile a step to the side doesn't count: nobody
        // finds that mid-fight.
        const walk = pathToFirst([px, py], MAP_WIDTH, MAP_HEIGHT, (x, y) => this.isPillar(x, y), (x, y) =>
          canHit(rest[next], x, y),
        );
        if (!walk) return true;
        let at: Coordinates = [px, py];
        for (const tile of runTicks(walk)) {
          at = tile;
          for (let i = 0; i < rest.length; i++) moveSimMob(rest, i, at[0], at[1]);
        }
        const seenThere = settleAfterKill(rest, at[0], at[1]);
        return !(seenThere.length === 1 && seenThere[0] === next && canHit(rest[next], at[0], at[1]));
      })();
      afterKillCache.set(key, exposed);
      return exposed;
    };

    // The Javelin Colossus throws javelins at your tile, so you have to step off and back. A Javelin
    // 1v1 needs a neighbouring tile you can dodge onto without anything else getting a look at you,
    // otherwise dodging turns it into a 2v1 - an outer-wall safespot is the usual culprit.
    const JAVELIN_DODGE_PENALTY = 8000;
    const DODGE_TICKS = 2;
    const canDodgeJavelin = (e: Evaluation) => {
      const [px, py] = e.end;
      const blocked = (x: number, y: number) => x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT || this.isPillar(x, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = px + dx;
          const y = py + dy;
          if ((dx === 0 && dy === 0) || blocked(x, y)) continue;
          // no cutting corners, same as the player's own pathing
          if (dx !== 0 && dy !== 0 && (blocked(px + dx, py) || blocked(px, py + dy))) continue;
          const mobs: any[] = JSON.parse(JSON.stringify(e.endMobs));
          if (mobs.some((m) => m[2] !== 0 && m[2] < 8 && this.doesCollide(x, y, 1, m[0], m[1], NPC_INFO[m[2]].size))) continue;
          let safe = true;
          const hold = (hx: number, hy: number) => {
            for (let i = 0; i < mobs.length; i++) this.simMobStep(mobs, i, hx, hy);
            if (this.simSeenBy(mobs, hx, hy).some((i) => i !== e.targetIndex)) safe = false;
          };
          for (let t = 0; t < DODGE_TICKS && safe; t++) hold(x, y);
          for (let t = 0; t < DODGE_TICKS && safe; t++) hold(px, py);
          if (safe) return true;
        }
      }
      return false;
    };

    // Outer-wall safespots are hard to judge in game and leave nowhere to go, so they're a last
    // resort: any pillar-side 1v1 that's close to as good wins.
    const OUTER_WALL_PENALTY = 3000;
    const touchesOuterWall = ([px, py]: Coordinates) => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return true;
          if (PILLAR_COORDS.some(([cx, cy]) => this.doesCollide(x, y, 1, cx, cy, 3))) continue;
          if (this.isPillar(x, y)) return true;
        }
      }
      return false;
    };

    for (;;) {
      if (routeIndex >= routes.length) {
        if (quick || followUpRound >= FOLLOW_UP_ROUNDS || outOfReach.length === 0) break;
        followUpRound++;
        queueFollowUps();
        continue;
      }
      const result = evaluateRoute(routes[routeIndex++]);

      // Never pick a fight you can't hit. Out-of-reach 1v1s only seed the follow-up routes above, which
      // are simulated from scratch, so one that drags another mob into view is caught like any other.
      if (result.targetIndex !== -1 && !result.attackable) {
        const depth = followUpDepth.get(result.route) ?? 0;
        if (depth < FOLLOW_UP_ROUNDS && result.dist - weaponReach <= MAX_STEP_IN && result.target) {
          outOfReach.push({ route: result.route, score: result.score, depth, target: result.target });
        }
      } else {
        if (isClean(result) && isExposedAfterKill(result)) {
          result.score += AFTER_KILL_PENALTY;
          result.exposedAfterKill = true;
        }
        if (isClean(result) && result.targetType === NPC_TYPES.JAVELIN_COLOSSUS && !canDodgeJavelin(result)) {
          result.score += JAVELIN_DODGE_PENALTY;
          result.noJavelinDodge = true;
        }
        if (isClean(result) && touchesOuterWall(result.end)) {
          result.score += OUTER_WALL_PENALTY;
        }
        candidates.push(result);
      }
    }

    // A plan that only works when every click lands on the exact tick falls apart in game: clicking
    // back one tick early let a Shaman step behind a pillar instead of walking round it. Clean 1v1s are
    // replayed with each click a tick early and a tick late (and the start a tick late); the best one
    // that survives all of them wins. A fragile one is only used, with a warning, if nothing sturdier
    // beats hiding.
    const ROBUST_CHECKS = 20;
    const timingHolds = (route: SolveRoute) => {
      const { clicks } = route;
      const variants: Array<SolveRoute | null> = [];
      if (clicks.length > 0) variants.push(buildRoute(clicks, 1));
      for (let i = 0; i < clicks.length - 1; i++) {
        variants.push(buildRoute(clicks.map((c, j) => (j === i ? { ...c, wait: c.wait + 1 } : c))));
        variants.push(
          buildRoute(clicks.map((c, j) => (j === i ? (c.wait > 0 ? { ...c, wait: c.wait - 1 } : { ...c, early: true }) : c))),
        );
      }
      return variants.every((v) => !v || isClean(evaluateRoute(v)));
    };

    candidates.sort((a, b) => a.score - b.score);
    let chosen: Evaluation | null = null;
    let fragileFallback: Evaluation | null = null;
    let robustChecks = 0;
    for (const candidate of candidates) {
      if (candidate.score >= 75000) break;
      if (!isClean(candidate)) {
        chosen = fragileFallback ?? candidate;
        break;
      }
      if (quick) {
        chosen = candidate;
        break;
      }
      if (robustChecks < ROBUST_CHECKS) {
        robustChecks++;
        if (timingHolds(candidate.route)) {
          chosen = candidate;
          break;
        }
      }
      fragileFallback ??= candidate;
    }
    chosen ??= fragileFallback;
    if (!chosen || chosen.score >= 75000) return null;
    return { ...chosen, fragile: chosen === fragileFallback };
  }

  // One NPC step, in two phases. First the direction is picked from terrain alone: diagonal, then
  // east/west, then north/south. Then other NPCs are checked. A diagonal blocked by an NPC slides to
  // east/west, then north/south (the "wiggle"). A straight step that terrain forced - because the
  // diagonal hit a pillar - just waits if an NPC is on it, and takes the tile once it's free. In game
  // a Shaman did exactly that behind the NW pillar instead of walking round a Javelin.
  private npcStep(x: number, y: number, size: number, index: number, dx: number, dy: number, mobs: any[]): Coordinates | null {
    const terrain = (tx: number, ty: number) => this.legalPositionForSim(tx, ty, size, index, []);
    const free = (tx: number, ty: number) => this.legalPositionForSim(tx, ty, size, index, mobs);
    const moves = (tx: number, ty: number) => tx !== x || ty !== y;

    const diagonal = dx !== x && dy !== y && terrain(dx, dy) && (size > 1 || (terrain(dx, y) && terrain(x, dy)));
    if (diagonal) {
      if (free(dx, dy) && (size > 1 || (free(dx, y) && free(x, dy)))) return [dx, dy];
      if (free(dx, y)) return [dx, y];
      if (free(x, dy)) return [x, dy];
      return null;
    }

    let straight: Coordinates | null = null;
    if (moves(dx, y) && terrain(dx, y)) straight = [dx, y];
    else if (moves(x, dy) && terrain(x, dy)) straight = [x, dy];
    return straight && free(straight[0], straight[1]) ? straight : null;
  }

  // Helper for the simulator to check NPC vs NPC collisions (Traffic Jams)
  private legalPositionForSim(x: number, y: number, size: number, index: number, mobs: any[]) {
    if (y - (size - 1) < 0 || x + (size - 1) > MAP_WIDTH) return false;
    
    // Pillar collision check
    for (let i = 0; i < PILLAR_COORDS.length; i++) {
      if (this.doesCollide(x, y, size, PILLAR_COORDS[i][0], PILLAR_COORDS[i][1], 3)) return false;
    }

    // Wall collision check
    for (let yy = y - size + 1; yy <= y; yy++) {
      if (yy >= 0 && yy < blockedTileRanges.length) {
        let ranges = blockedTileRanges[yy];
        for (let j = 0; j < ranges.length; ++j) {
          if (x + size > ranges[j][0] && x < ranges[j][1]) return false;
        }
      }
    }
    
    // NPC vs NPC collision check
    for (let i = 0; i < mobs.length; i++) {
      if (i !== index && mobs[i][2] < 8) {
        if (this.doesCollide(x, y, size, mobs[i][0], mobs[i][1], NPC_INFO[mobs[i][2]].size)) {
          return false;
        }
      }
    }
    return true;
  }

  // Where each click dot and wait label goes, in canvas pixels. Dots on the same tile sit side by
  // side. A wait label goes above or below its tile (alternating between markers), and moves to the
  // other side, or beside its dots, rather than cover another dot or label.
  public layoutClickMarkers(measure: (text: string) => number) {
    type Box = { x0: number; y0: number; x1: number; y1: number };
    const boxAt = (x: number, y: number, w: number, h: number): Box => ({ x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 });
    const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

    const markers = new Map<string, { tile: Coordinates; dots: Array<{ label: string; start: boolean }>; waits: number[] }>();
    this.suggestedClicks.forEach(({ tile, wait }, i) => {
      const key = `${tile[0]},${tile[1]}`;
      let marker = markers.get(key);
      if (!marker) {
        marker = { tile, dots: [], waits: [] };
        markers.set(key, marker);
      }
      const isStart = this.suggestedStartHidden && i === 0;
      marker.dots.push({ label: isStart ? "S" : String(this.suggestedStartHidden ? i : i + 1), start: isStart });
      // Nothing sees you on S and the mobs have stopped moving, so you can stand there as long as you
      // like: its wait is only the simulation letting them settle.
      if (wait > 0 && !isStart) marker.waits.push(wait);
    });

    const dots: Array<{ x: number; y: number; label: string; start: boolean }> = [];
    for (const { tile, dots: tileDots } of markers.values()) {
      const cx = (tile[0] + 0.5) * TILE_SIZE;
      const cy = (tile[1] + 0.5) * TILE_SIZE;
      tileDots.forEach((dot, j) => dots.push({ x: cx + (j - (tileDots.length - 1) / 2) * 14, y: cy, ...dot }));
    }

    const taken: Box[] = dots.map((dot) => boxAt(dot.x, dot.y, 16, 16));
    const labels: Array<{ x: number; y: number; text: string }> = [];
    [...markers.values()].forEach(({ tile, dots: tileDots, waits }, order) => {
      if (waits.length === 0) return;
      const text = `wait ${waits.join(", then ")}`;
      const w = measure(text) + 4;
      const h = 12;
      const cx = (tile[0] + 0.5) * TILE_SIZE;
      const cy = (tile[1] + 0.5) * TILE_SIZE;
      const halfDots = ((tileDots.length - 1) * 14) / 2 + 8;
      const above: Coordinates = [cx, cy - 14];
      const below: Coordinates = [cx, cy + 16];
      const spots: Coordinates[] = [
        ...(order % 2 === 0 ? [above, below] : [below, above]),
        [cx + halfDots + w / 2 + 2, cy],
        [cx - halfDots - w / 2 - 2, cy],
      ];
      const spot = spots.find(([x, y]) => !taken.some((b) => overlaps(boxAt(x, y, w, h), b))) ?? spots[0];
      taken.push(boxAt(spot[0], spot[1], w, h));
      labels.push({ x: spot[0], y: spot[1], text });
    });
    return { dots, labels };
  }

  public drawSuggestedPath() {
    if (!this.suggestedPath || !this.ctx) return;
    const ctx = this.ctx;
    const steps = this.suggestedPath;
    const centre = (tile: Coordinates) => [(tile[0] + 0.5) * TILE_SIZE, (tile[1] + 0.5) * TILE_SIZE];

    // The tile-by-tile walk the game takes between clicks. A one-tile route means "hold this
    // tile", which still gets the end-tile highlight below.
    if (steps.length >= 2) {
      ctx.beginPath();
      ctx.strokeStyle = "#00FF00";
      ctx.lineWidth = 4;
      ctx.setLineDash([5, 5]);
      const [startX, startY] = centre(steps[0]);
      ctx.moveTo(startX, startY);
      for (let i = 1; i < steps.length; i++) {
        const [x, y] = centre(steps[i]);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Final tile, coloured by whether the target is actually in reach from it: green means you
    // can start attacking on arrival, amber means you're isolated but still have to step in.
    const endTile = steps[steps.length - 1];
    ctx.fillStyle = this.solveEndAttackable ? "#00FF00" : "#FFD700";
    ctx.globalAlpha = 0.5;
    ctx.fillRect(endTile[0] * TILE_SIZE, endTile[1] * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    ctx.globalAlpha = 1.0;

    // A blue "S" dot is a hidden tile to start from, a red numbered dot is a click (the green tile
    // above marks where you end up). Timed clicks are numbered from 1 after S. Dots on the same tile
    // sit side by side, so a route that comes back to where it started stays readable.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 11px sans-serif";
    const { dots, labels } = this.layoutClickMarkers((text) => ctx.measureText(text).width);
    for (const { x, y, label, start } of dots) {
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, 2 * Math.PI);
      ctx.fillStyle = start ? "#1E6FFF" : "#FF0000";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#FFFFFF";
      ctx.stroke();
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(label, x, y + 1);
    }
    // labels last, so no dot is drawn over one
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = "#FFD700";
    for (const { x, y, text } of labels) {
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  }

  // exposed for testing
  public _setSelected(
    s: Coordinates,
    _mode: number,
    _extra: MobExtra | null = null
  ) {
    this.selected = s;
    this.cursorLocation = s;
    this.mode = _mode;
    this.modeExtra = _extra;
  }

  public _getMobs() {
    return this.mobs;
  }
}