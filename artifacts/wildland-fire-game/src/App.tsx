import { useEffect, useRef, useState } from 'react';
import { mountForest } from './forest-scene';
import {
  INITIAL_WIND_DIRECTION,
  INITIAL_WIND_SPEED,
  MAX_WIND_SPEED,
  type FireStats,
  type ForestSceneHandle,
} from './game-types';

const EMPTY_STATS: FireStats = {
  burningCells: 0,
  burnedCells: 0,
  crownFireCells: 0,
  firebreakCells: 0,
};

function compassName(degrees: number) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round((degrees % 360) / 45) % 8];
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ForestSceneHandle | null>(null);
  const [locked, setLocked] = useState(false);
  const [started, setStarted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [windDirection, setWindDirection] = useState(INITIAL_WIND_DIRECTION);
  const [windSpeed, setWindSpeed] = useState(INITIAL_WIND_SPEED);
  const [stats, setStats] = useState<FireStats>(EMPTY_STATS);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    Promise.resolve(mountForest(canvas, {
      onLockChange: setLocked,
      onMenuChange: setMenuOpen,
      onFireStats: setStats,
    })).then((scene) => {
      if (cancelled) {
        scene.dispose();
        return;
      }
      sceneRef.current = scene;
      scene.setWind(INITIAL_WIND_DIRECTION, INITIAL_WIND_SPEED);
      setReady(true);
    }).catch(() => {
      if (!cancelled) setError(true);
    });

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  const updateWind = (direction: number, speed: number) => {
    setWindDirection(direction);
    setWindSpeed(speed);
    sceneRef.current?.setWind(direction, speed);
  };

  const enterForest = () => {
    if (error) {
      window.location.reload();
      return;
    }
    setStarted(true);
    sceneRef.current?.lock();
  };

  const resumePatrol = () => {
    setMenuOpen(false);
    sceneRef.current?.setMenuOpen(false);
    sceneRef.current?.lock();
  };

  const breeze = windSpeed <= 11;
  const highWinds = windSpeed >= 25;
  const directionName = compassName(windDirection);

  return (
    <main className="game-shell" aria-label="Wildland fire patrol forest walk" data-testid="game-shell">
      <canvas
        ref={canvasRef}
        className="forest-canvas"
        aria-label="Three-dimensional forest scene"
        data-testid="scene-canvas"
      />
      <div className="scene-vignette" aria-hidden="true" />
      <div className="reticle" aria-hidden="true" />

      <section className="hud" aria-label="Patrol information">
        <div className="top-row">
          <div className="brand-lockup" data-testid="status-patrol-identity">
            <div className="brand-mark" aria-hidden="true"><span>N</span></div>
            <div>
              <div className="eyebrow">Field operations · sector 04</div>
              <div className="brand-name">Wildland patrol</div>
            </div>
          </div>

          <section className="wind-card" aria-label="Live wind conditions" data-testid="panel-wind">
            <div className="wind-heading">
              <span>Wind conditions</span>
              <span className="wind-live"><i className="live-dot" />Live</span>
            </div>
            <div className="wind-readout">
              <span
                className="wind-arrow"
                aria-hidden="true"
                style={{ transform: `rotate(${windDirection}deg)` }}
                data-testid="indicator-wind-direction"
              >↑</span>
              <span className="wind-value" data-testid="text-wind-direction">
                {String(windDirection).padStart(3, '0')}° · {directionName}
              </span>
              <span className="wind-speed" data-testid="text-wind-speed">{windSpeed} mph</span>
            </div>
            <div className="wind-range">
              <label className="range-control" htmlFor="wind-direction">
                <span className="range-label">
                  <span>Direction</span>
                  <output data-testid="value-wind-direction">{windDirection}°</output>
                </span>
                <input
                  id="wind-direction"
                  type="range"
                  min="0"
                  max="360"
                  step="1"
                  value={windDirection}
                  aria-label="Wind direction in degrees"
                  data-testid="slider-wind-direction"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => updateWind(Number(event.currentTarget.value), windSpeed)}
                />
              </label>
              <label className="range-control" htmlFor="wind-speed">
                <span className="range-label">
                  <span>Speed</span>
                  <output data-testid="value-wind-speed">{windSpeed} mph</output>
                </span>
                <input
                  id="wind-speed"
                  type="range"
                  min="0"
                  max={MAX_WIND_SPEED}
                  step="1"
                  value={windSpeed}
                  aria-label="Wind speed in miles per hour"
                  data-testid="slider-wind-speed"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => updateWind(windDirection, Number(event.currentTarget.value))}
                />
              </label>
            </div>
            <div className="wind-cues" aria-label="Wind behavior cues">
              <span className={breeze ? 'active' : ''} data-testid="cue-light-breeze">Light Breeze · 0–11 mph</span>
              <span className={highWinds ? 'active' : ''} data-testid="cue-high-winds">High Winds · 25+ mph</span>
            </div>
          </section>
        </div>

        <div className="telemetry" aria-label="Live fire activity" data-testid="panel-fire-stats">
          <div className="metric fire">
            <span className="metric-value" data-testid="stat-burning-cells">{stats.burningCells}</span>
            <span className="metric-label">Burning cells</span>
          </div>
          <div className="metric crown">
            <span className="metric-value" data-testid="stat-crown-fire-cells">{stats.crownFireCells}</span>
            <span className="metric-label">Crown fire</span>
          </div>
          <div className="metric">
            <span className="metric-value" data-testid="stat-burned-cells">{stats.burnedCells}</span>
            <span className="metric-label">Burned cells</span>
          </div>
          <div className="metric break">
            <span className="metric-value" data-testid="stat-firebreak-cells">{stats.firebreakCells}</span>
            <span className="metric-label">Firebreak cells</span>
          </div>
        </div>

        <div className="lower-left">
          <section className="controls-card" aria-label="Field controls" data-testid="panel-controls">
            <div className="controls-title">
              <span><i className="live-dot" />McLeod equipped</span>
              <span>Patrol controls</span>
            </div>
            <div className="key-layout" aria-label="Use W A S D to move and mouse to look">
              <span className="key w">W</span>
              <span className="key a">A</span>
              <span className="key s">S</span>
              <span className="key d">D</span>
              <div className="mouse-hint"><strong>Mouse</strong>Look around</div>
            </div>
            <div className="controls-instruction">
              <span><strong>WASD</strong> move · <strong>Mouse</strong> look · hold <strong>Left mouse</strong> to rake beneath your boots</span>
              <span><strong>P</strong> toggle pointer lock · <strong>Esc / Tab</strong> options menu</span>
            </div>
          </section>
          <div className="footer-note" data-testid="text-terrain-note">Fireline · west edge advancing east</div>
        </div>
      </section>

      <div className="walk-status" data-testid="status-patrol">
        {locked ? 'Patrol active · P to release · Esc / Tab for options' : menuOpen ? 'Options · patrol paused' : started ? 'Patrol paused · P to resume' : 'Patrol ready'}
      </div>

      <button
        className={`lock-screen${started ? ' hidden' : ''}`}
        type="button"
        onClick={enterForest}
        aria-label={error ? 'Reload the forest scene' : 'Click to enter the forest'}
        tabIndex={started ? -1 : 0}
        data-testid="button-start-patrol"
      >
        <span className="lock-panel">
          <span className="lock-kicker" data-testid="status-scene-loading">
            {error ? 'Scene unavailable' : ready ? 'The forest is quiet' : 'Preparing the trail'}
          </span>
          <span className="lock-title">
            {error ? 'Unable to load forest' : ready ? 'Begin your patrol' : 'Waking the forest'}
          </span>
          <span className="lock-copy">
            {error
              ? 'The scene could not be started. Refresh the page to try again.'
              : ready
                ? 'A slow wall of fire is advancing from the west. Move through the trees and rake a firebreak beneath your boots.'
                : 'Building the canopy, brush and trail around you.'}
          </span>
          {!error && ready && (
            <span className="enter-button"><span className="enter-icon" aria-hidden="true">↗</span>Click to enter</span>
          )}
          {!ready && !error && <span className="lock-foot">Loading the landscape</span>}
          {ready && !error && <span className="lock-foot">WASD to walk · mouse to look · hold left mouse to rake beneath you</span>}
        </span>
      </button>

      {menuOpen && (
        <div className="menu-backdrop" data-testid="options-backdrop">
          <section
            className="options-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="options-title"
            data-testid="panel-options"
          >
            <div className="options-topline">
              <span>Field operations</span>
              <span data-testid="status-options-open">Patrol paused</span>
            </div>
            <h1 className="options-title" id="options-title">Options</h1>
            <p className="options-copy">Adjust the wind before returning to the line. Wind updates immediately in the forest.</p>
            <div className="option-summary" data-testid="summary-options-wind">
              <div className="option-summary-title">Current wind</div>
              <div className="option-wind">
                <span>{String(windDirection).padStart(3, '0')}° · {directionName}</span>
                <span>{windSpeed} mph</span>
              </div>
            </div>
            <div className="menu-controls" data-testid="text-options-controls">
              <strong>WASD</strong> move · <strong>Mouse</strong> look · hold <strong>left mouse</strong> to rake beneath your boots with the McLeod.
              <br />
              Press <strong>P</strong> to toggle pointer lock. Press <strong>Esc</strong> or <strong>Tab</strong> for this menu.
            </div>
            <div className="menu-actions">
              <button className="menu-button" type="button" onClick={resumePatrol} data-testid="button-close-options">Close options</button>
              <button className="menu-button primary" type="button" onClick={resumePatrol} data-testid="button-resume-patrol">Resume patrol</button>
            </div>
          </section>
        </div>
      )}
      <div className="grain" aria-hidden="true" />
    </main>
  );
}
