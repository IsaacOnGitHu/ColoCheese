import {
  CSSProperties,
  MouseEventHandler,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { MobExtra } from "./types";
import { ManticoreOverlay } from "./ManticoreOverlay";
import { LineOfSight } from "./lineOfSight";

import "./App.css";
import { DEFAULT_WEAPON_MODE, NpcType, WEAPON_MODES, WeaponMode } from "./constants";
import {
  DEFAULT_PLAYER_DEFENCE,
  InvocationTier,
  Invocations,
  NO_INVOCATIONS,
  PRAYER_LABELS,
  PlayerDefence,
  PrayerStyle,
  TIER_LABELS,
} from "./damageModel";

type Settings = {
  weaponMode: WeaponMode;
  solarflare: boolean;
  runPrayer: PrayerStyle;
  defence: PlayerDefence;
  invocations: Invocations;
};

const SETTINGS_KEY = "colo-cheese-settings";

const DEFAULT_SETTINGS: Settings = {
  weaponMode: DEFAULT_WEAPON_MODE,
  solarflare: false,
  runPrayer: "magic",
  defence: DEFAULT_PLAYER_DEFENCE,
  invocations: NO_INVOCATIONS,
};

const toTier = (value: unknown): InvocationTier => (value === 1 || value === 2 || value === 3 ? value : 0);

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (!saved) return DEFAULT_SETTINGS;
    return {
      weaponMode: saved.weaponMode in WEAPON_MODES ? saved.weaponMode : DEFAULT_SETTINGS.weaponMode,
      solarflare: saved.solarflare === true,
      runPrayer: saved.runPrayer in PRAYER_LABELS ? saved.runPrayer : DEFAULT_SETTINGS.runPrayer,
      defence: { ...DEFAULT_PLAYER_DEFENCE, ...saved.defence },
      invocations: {
        relentless: toTier(saved.invocations?.relentless),
        mantimayhem: toTier(saved.invocations?.mantimayhem),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const DEFENCE_FIELDS: Array<[keyof PlayerDefence, string]> = [
  ["stab", "Stab"],
  ["slash", "Slash"],
  ["crush", "Crush"],
  ["magic", "Magic"],
  ["ranged", "Range"],
  ["defenceLevel", "Def lvl"],
  ["magicLevel", "Magic lvl"],
];

function App() {
  const [isDragging, setDragging] = useState(false);
  const [lineOfSight, setLineOfSight] = useState<LineOfSight | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [solving, setSolving] = useState(false);

  // Easter egg: click the header cheese five times in quick succession.
  const [cheeseClicks, setCheeseClicks] = useState({ count: 0, at: 0 });
  const [showCheese, setShowCheese] = useState(false);
  const onCheeseClick = () => {
    const now = Date.now();
    const count = now - cheeseClicks.at < 1500 ? cheeseClicks.count + 1 : 1;
    // start fetching the banner on the first click so it's ready by the fifth
    if (count === 1) new Image().src = "/cheese-banner.jpg";
    if (count >= 5) {
      setShowCheese(true);
      setCheeseClicks({ count: 0, at: 0 });
    } else {
      setCheeseClicks({ count, at: now });
    }
  };
  useEffect(() => {
    if (!showCheese) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowCheese(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [showCheese]);
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useSyncExternalStore(
    (s) => {
      lineOfSight?.subscribe(s);
      return () => lineOfSight?.unsubscribe(s);
    },
    () => lineOfSight?.getUiState()
  );

  const uiState = lineOfSight?.getUiState();

  const currentReplayLength = uiState?.replayLength;
  const isReplaying = uiState?.isReplaying;
  const replayTick = uiState?.replayTick;
  const solveSummary = uiState?.solveSummary;
  const solveTone = uiState?.solveTone;
  const solveRoute = uiState?.solveRoute;
  const startHidden = uiState?.startHidden;

  useEffect(() => {
    lineOfSight?.applySettings(settings);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // storage can be blocked (private windows); the settings still apply for this visit
    }
  }, [lineOfSight, settings]);

  const updateSettings = (change: Partial<Settings>) => setSettings((current) => ({ ...current, ...change }));

  function handleCanvas(canvas: HTMLCanvasElement | null) {
    if (lineOfSight) {
      return;
    }
    if (!canvas) {
      return;
    }
    const newLos = new LineOfSight();
    newLos.initDOM(canvas);
    setLineOfSight(newLos);
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      lineOfSight?.handleKeyDown(e);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [lineOfSight]);

  const handleMaybeDrop = () => {
    if (isDragging) {
      lineOfSight?.place();
    }
    setDragging(false);
  };

  const DraggableUnitButton = useCallback(
    (
      props: UnitButtonProps & {
        mode: NpcType;
        extra?: MobExtra;
      },
    ) => {
      const { mode, extra } = props;
      return (
        <UnitButton
          {...props}
          onMouseDown={(e) => {
            lineOfSight?.setMode(mode, extra);
            setDragging(true);
            e.preventDefault();
          }}
          onClick={(e) => {
            lineOfSight?.setMode(mode, extra, true);
            setDragging(true);
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      );
    },
    [lineOfSight],
  );

  return (
    <div className="app-container" onMouseUp={() => setDragging(false)}>
      {/* LEFT COLUMN: THE ARENA CANVAS & TICK SCRUBBER */}
      <div className="canvas-column">
        <canvas
          ref={handleCanvas}
          onSelect={() => false}
          onContextMenu={(e) => lineOfSight?.onCanvasRightClick(e)}
          onMouseDown={(e) => lineOfSight?.onCanvasMouseDown(e)}
          onMouseUp={(e) => {
            lineOfSight?.onCanvasMouseUp(e);
            handleMaybeDrop?.();
          }}
          onDoubleClick={(e) => lineOfSight?.onCanvasDblClick(e)}
          onWheel={(e) => lineOfSight?.onCanvasMouseWheel(e)}
          onMouseMove={(e) => lineOfSight?.onCanvasMouseMove(e)}
          onMouseOut={() => lineOfSight?.onCanvasMouseOut()}
        />

        {/* INTEGRATED ARENA SCRUBBER BAR */}
        <div className="canvas-scrubber-bar">
          <div className="scrubber-controls">
            <span>Simulation:</span>
            <button
              onClick={() => lineOfSight?.reset()}
              title="Hotkey: Down arrow or mousewheel up"
            >
              &laquo; Reset
            </button>
            <button
              onClick={() => lineOfSight?.toggleAutoReplay()}
              id="replayAutoButton"
              hidden={currentReplayLength === null}
            >
              {isReplaying ? "Pause" : "Play"}
            </button>
            <button
              onClick={() => lineOfSight?.step(true)}
              title="Hotkey: Up arrow or mousewheel down"
            >
              Step &raquo;
            </button>
          </div>

          <div id="replayIndicator">
            {currentReplayLength ? (
              <strong style={{ color: "#f85149" }}>
                {(replayTick ?? 0) > currentReplayLength
                  ? `Tick ${replayTick} (holding end tile)`
                  : `Replay: Tick ${replayTick} / ${currentReplayLength}`}
              </strong>
            ) : (
              <span style={{ color: "#8b949e" }}>Manual Placement Mode</span>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT COLUMN: CONTROL DASHBOARD */}
      <div className="sidebar-column">
        <div className="card app-header">
          <h1 className="app-title">
            <span
              key={cheeseClicks.count}
              className={`cheese-trigger${cheeseClicks.count > 0 ? " wiggle" : ""}`}
              onClick={onCheeseClick}
            >
              🧀
            </span>{" "}
            Colo Cheese
          </h1>
          <p className="app-subtitle">No-flick tank paths for the OSRS Fortis Colosseum. Load your stack, hit Solve, get a safe 1v1.</p>
        </div>

        {showCheese && (
          <div className="cheese-egg" role="dialog" aria-label="Very tank" onClick={() => setShowCheese(false)}>
            <img src="/cheese-banner.jpg" alt="Colo Cheese: very cool, very tank" />
          </div>
        )}

        <button
          className="solve-tank-btn"
          onClick={() => {
            if (!lineOfSight || solving) return;
            setSolving(true);
            // Give the button a moment to show it's working before the solver holds up the page.
            setTimeout(() => {
              try {
                lineOfSight.solveAndDrawTankPath();
              } finally {
                setSolving(false);
              }
            }, 30);
          }}
          disabled={solving}
          aria-label="Find a safe 1v1"
          data-microtip-position="bottom"
          role="tooltip"
        >
          {solving ? "⏳ Solving..." : "🛡️ Solve Tank Path"}
        </button>

        {solveSummary && (
          <div className={`solve-status ${solveTone}`}>
            {solveSummary}
            {solveRoute && <span className="route">{solveRoute}</span>}
            {solveRoute && (
              <div className="map-key">
                {startHidden && <span><i className="key-dot start">S</i>Start Tile</span>}
                <span><i className="key-dot click">1</i>Click Sequence</span>
                <span><i className="key-end" />End</span>
              </div>
            )}
          </div>
        )}

        <div className="card">
          <div className="panel-header">
            <span>Mobs</span>
            <div className="btn-group">
              <button className="btn-small" onClick={() => lineOfSight?.place()}>
                Place
              </button>
              <button className="btn-small" onClick={() => lineOfSight?.remove()}>
                Clear
              </button>
            </div>
          </div>

          <div className="unit-grid">
            <DraggableUnitButton
              mode={0}
              image="./player.png"
              borderColor="red"
              tooltip="You"
            />
            <DraggableUnitButton
              mode={1}
              image="./serpent_shaman.png"
              borderColor="cyan"
              tooltip="Serpent Shaman"
            />
            <DraggableUnitButton
              mode={2}
              image="./javelin_colossus.png"
              borderColor="lime"
              tooltip="Javelin Colossus"
            />
            <DraggableUnitButton
              mode={3}
              image="./jaguar_warrior.png"
              borderColor="orange"
              tooltip="Jaguar Warrior"
            />
            <DraggableUnitButton
              mode={4}
              extra="u"
              overlay={null}
              image="./manticore.png"
              borderColor="purple"
              tooltip="Manticore (uncharged)"
            />
            <DraggableUnitButton
              mode={4}
              extra="r"
              overlay={<ManticoreOverlay order={["range", "mage", "melee"]} />}
              image="./manticore.png"
              borderColor="purple"
              tooltip="Manticore (range first)"
            />
            <DraggableUnitButton
              mode={4}
              extra="m"
              overlay={<ManticoreOverlay order={["mage", "range", "melee"]} />}
              image="./manticore.png"
              borderColor="purple"
              tooltip="Manticore (mage first)"
            />
            <DraggableUnitButton
              mode={5}
              image="./minotaur.png"
              borderColor="purple"
              tooltip="Minotaur"
            />
            <DraggableUnitButton
              mode={6}
              image="./shockwave_colossus.png"
              borderColor="purple"
              tooltip="Shockwave Colossus"
            />
            <DraggableUnitButton
              mode={7}
              overlay={<span style={{ fontSize: 16, fontWeight: "bold" }}>+</span>}
              image="./serpent_shaman.png"
              borderColor="cyan"
              tooltip="Reinforcement Shaman"
            />
          </div>

          {/* only shown when a Mantimayhem 3 link is loaded */}
          {lineOfSight?.mantimayhem3 && (
            <div className="mm3-section">
              <div className="mm3-title">Mantimayhem 3</div>
              <div className="unit-grid">
                <DraggableUnitButton
                  mode={4}
                  extra="Mrm"
                  overlay={<ManticoreOverlay order={["melee", "range", "mage"]} />}
                  image="./manticore.png"
                  borderColor="purple"
                  tooltip="Melee, range, mage"
                />
                <DraggableUnitButton
                  mode={4}
                  extra="Mmr"
                  overlay={<ManticoreOverlay order={["melee", "mage", "range"]} />}
                  image="./manticore.png"
                  borderColor="purple"
                  tooltip="Melee, mage, range"
                />
                <DraggableUnitButton
                  mode={4}
                  extra="rMm"
                  overlay={<ManticoreOverlay order={["range", "melee", "mage"]} />}
                  image="./manticore.png"
                  borderColor="purple"
                  tooltip="Range, melee, mage"
                />
                <DraggableUnitButton
                  mode={4}
                  extra="mMr"
                  overlay={<ManticoreOverlay order={["mage", "melee", "range"]} />}
                  image="./manticore.png"
                  borderColor="purple"
                  tooltip="Mage, melee, range"
                />
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="panel-header">Settings</div>

          <div className="reach-row">
            <label htmlFor="reach-select">Weapon</label>
            <select
              id="reach-select"
              value={settings.weaponMode}
              onChange={(e) => updateSettings({ weaponMode: e.target.value as WeaponMode })}
            >
              {Object.entries(WEAPON_MODES).map(([mode, { label }]) => (
                <option key={mode} value={mode}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="reach-row">
            <label htmlFor="prayer-select">Pray while running</label>
            <select
              id="prayer-select"
              value={settings.runPrayer}
              onChange={(e) => updateSettings({ runPrayer: e.target.value as PrayerStyle })}
            >
              {Object.entries(PRAYER_LABELS).map(([style, label]) => (
                <option key={style} value={style}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={settings.solarflare}
                onChange={(e) => updateSettings({ solarflare: e.target.checked })}
              />
              Solarflare
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.defence.justiciar}
                onChange={(e) =>
                  updateSettings({ defence: { ...settings.defence, justiciar: e.target.checked } })
                }
              />
              Justiciar set
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.defence.piety}
                onChange={(e) => updateSettings({ defence: { ...settings.defence, piety: e.target.checked } })}
              />
              Piety
            </label>
          </div>

          <div className="reach-row">
            <label htmlFor="relentless-select">Relentless</label>
            <select
              id="relentless-select"
              value={settings.invocations.relentless}
              onChange={(e) =>
                updateSettings({
                  invocations: { ...settings.invocations, relentless: toTier(Number(e.target.value)) },
                })
              }
            >
              {TIER_LABELS.map((label, tier) => (
                <option key={tier} value={tier}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="mantimayhem-select" className="gap-left">
              Mantimayhem
            </label>
            <select
              id="mantimayhem-select"
              value={settings.invocations.mantimayhem}
              onChange={(e) =>
                updateSettings({
                  invocations: { ...settings.invocations, mantimayhem: toTier(Number(e.target.value)) },
                })
              }
            >
              {TIER_LABELS.map((label, tier) => (
                <option key={tier} value={tier}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="stat-heading">Your defence</div>
          <div className="stat-grid">
            {DEFENCE_FIELDS.map(([field, label]) => (
              <label key={field}>
                {label}
                <input
                  type="number"
                  defaultValue={settings.defence[field] as number}
                  onChange={(e) => {
                    const value = parseInt(e.target.value, 10);
                    if (Number.isFinite(value)) {
                      updateSettings({ defence: { ...settings.defence, [field]: value } });
                    }
                  }}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="card">
          <button className="guide-toggle" onClick={() => setShowGuide(!showGuide)}>
            <span>📖 How to use</span>
            <span>{showGuide ? "▲" : "▼"}</span>
          </button>
          {showGuide && (
            <ol className="guide-steps">
              <li>Hide behind a pillar where nothing can see you.</li>
              <li>Paste your RuneLite plugin link, or drag the mobs and yourself onto the map.</li>
              <li>Hit Solve.</li>
              <li>If there's a blue S, walk there first. Put your run prayer on and click the red dots in order. Stand still if it says wait, then click the end tile.</li>
              <li>After a kill, drag the dead mob off, move everyone to where they are now, and solve again.</li>
            </ol>
          )}
        </div>

        <p className="footer-text">
          🧀 <strong>Colo Cheese</strong> | Built for Dads<br />
          Math adapted from <a href="https://los.colosim.com" target="_blank" rel="noreferrer">los.colosim.com</a> · <a href="https://github.com/IsaacOnGitHu/ColoCheese" target="_blank" rel="noreferrer">Source on GitHub</a>
        </p>
      </div>
    </div>
  );
}

type UnitButtonProps = {
  onMouseDown?: MouseEventHandler;
  onClick?: MouseEventHandler;
  image: string;
  overlay?: React.ReactNode;
  borderColor: CSSProperties["color"];
  tooltip: string;
  width?: number;
  height?: number;
};

const UnitButton = ({
  onMouseDown,
  onClick,
  image,
  overlay = null,
  borderColor,
  tooltip,
}: UnitButtonProps) => {
  return (
    <button
      className="UnitButton"
      onMouseDown={onMouseDown}
      onClick={onClick}
      style={{ borderColor }}
      aria-label={tooltip}
      data-microtip-position="bottom"
      role="tooltip"
    >
      {overlay && <div className="overlay">{overlay}</div>}
      <img src={image} height="40" draggable="false" alt="" />
    </button>
  );
};

export default App;
