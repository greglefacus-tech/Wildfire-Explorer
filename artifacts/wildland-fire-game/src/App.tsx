import { useEffect, useRef, useState } from 'react';
import { mountForest } from './forest-scene';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Awaited<ReturnType<typeof mountForest>> | null>(null);
  const [locked, setLocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    mountForest(canvas).then((scene) => {
      if (cancelled) {
        scene.dispose();
        return;
      }
      sceneRef.current = scene;
      scene.onLockChange(setLocked);
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

  const enterForest = () => {
    if (error) {
      window.location.reload();
      return;
    }
    sceneRef.current?.lock();
  };

  return (
    <main className="game-shell" aria-label="Wildland fire patrol forest walk">
      <canvas ref={canvasRef} className="forest-canvas" aria-label="Three-dimensional forest scene" />
      <div className="scene-vignette" />
      <div className="reticle" aria-hidden="true" />

      <section className="hud" aria-label="Patrol information">
        <div className="top-row">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><span>N</span></div>
            <div>
              <div className="eyebrow">Field operations · sector 04</div>
              <div className="brand-name">Wildland patrol</div>
            </div>
          </div>
          <div className="weather-card" aria-label="Wind from the northeast at 15 miles per hour">
            <div className="wind-arrow" aria-hidden="true">↗</div>
            <div className="weather-data">
              <div className="weather-value">Wind: North-East</div>
              <div className="weather-sub">Speed: 15 mph</div>
            </div>
          </div>
        </div>

        <div className="controls-card">
          <div className="controls-title">
            <span><i className="live-dot" />On foot</span>
            <span>Patrol controls</span>
          </div>
          <div className="key-layout" aria-label="Use W A S D to move and mouse to look">
            <span className="key w">W</span>
            <span className="key a">A</span>
            <span className="key s">S</span>
            <span className="key d">D</span>
            <div className="mouse-hint"><strong>Mouse</strong>Look around</div>
          </div>
          <div className="controls-instruction">WASD to move · Click to lock controls</div>
        </div>
        <div className="footer-note">Terrain · mixed conifer forest</div>
      </section>

      <div className="walk-status">{locked ? 'Patrol active · Esc to pause' : 'Patrol paused'}</div>
      <button
        className={`lock-screen${locked ? ' hidden' : ''}`}
        type="button"
        onClick={enterForest}
        aria-label={locked ? 'Patrol active' : 'Click to enter the forest'}
        tabIndex={locked ? -1 : 0}
      >
        <span className="lock-panel">
          <span className="lock-kicker">{error ? 'Scene unavailable' : ready ? 'The forest is quiet' : 'Preparing the trail'}</span>
          <span className="lock-title">{error ? 'Unable to load forest' : ready ? 'Begin your patrol' : 'Waking the forest'}</span>
          <span className="lock-copy">
            {error
              ? 'The scene could not be started. Refresh the page to try again.'
              : ready
                ? 'Move at your own pace through the trees. Look closely; the terrain is never quite level.'
                : 'Building the canopy, brush and trail around you.'}
          </span>
          {!error && ready && (
            <span className="enter-button"><span className="enter-icon">↗</span>Click to enter</span>
          )}
          {!ready && !error && <span className="lock-foot">Loading the landscape</span>}
          {ready && !error && <span className="lock-foot">WASD to walk · mouse to look · Esc to pause</span>}
        </span>
      </button>
      <div className="grain" aria-hidden="true" />
    </main>
  );
}
