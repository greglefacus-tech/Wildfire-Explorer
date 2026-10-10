export const INITIAL_WIND_DIRECTION = 90;
export const INITIAL_WIND_SPEED = 15;
export const MAX_WIND_SPEED = 35;

export type FireStats = {
  burningCells: number;
  burnedCells: number;
  crownFireCells: number;
  firebreakCells: number;
};

export type ForestSceneCallbacks = {
  onLockChange?: (locked: boolean) => void;
  onMenuChange?: (open: boolean) => void;
  onFireStats?: (stats: FireStats) => void;
};

export type ForestSceneHandle = {
  lock: () => void;
  unlock: () => void;
  setWind: (directionDegrees: number, speedMph: number) => void;
  setMenuOpen: (open: boolean) => void;
  dispose: () => void;
};
