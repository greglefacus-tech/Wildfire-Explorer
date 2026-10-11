type FuelPoint = { x: number; z: number; height?: number };
type Particle = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  spotTargetIndex?: number;
  startX?: number;
  startY?: number;
  startZ?: number;
  targetX?: number;
  targetY?: number;
  targetZ?: number;
  arcHeight?: number;
  turbPhase?: number;
  turbFreq?: number;
  turbAmp?: number;
};

type FireStats = {
  burningCells: number;
  burnedCells: number;
  crownFireCells: number;
  firebreakCells: number;
};

type WaterParticle = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
};

type FireSystemOptions = {
  THREE: any;
  scene: any;
  terrainHeight: (x: number, z: number) => number;
  random: () => number;
  trees: FuelPoint[];
  bushes: FuelPoint[];
  grassPatches: FuelPoint[];
  onStats?: (stats: FireStats) => void;
  onDigCell?: (cellIndex: number) => void;
  onCellBurned?: (cellIndex: number) => void;
};

export type AtmosphereState = {
  heat: number;
  smog: number;
  emberStorm: number;
  fogDensity: number;
  glowX: number;
  glowY: number;
  glowZ: number;
  glowStrength: number;
};

export type FireSimulation = {
  setWind: (directionDegrees: number, speedMph: number) => void;
  update: (dt: number, elapsed: number, camera: any) => AtmosphereState;
  digAt: (x: number, z: number) => void;
  endTrench: () => void;
  sprayWater: (origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }, dt: number) => void;
  getStats: () => FireStats;
  dispose: () => void;
};

export const FIRE_GRID_SIZE = 112;
export const FIRE_GRID_CELL_SIZE = 2.5;
export const FIRE_GRID_ORIGIN = -140;
const GRID_SIZE = FIRE_GRID_SIZE;
const CELL_SIZE = FIRE_GRID_CELL_SIZE;
const GRID_ORIGIN = FIRE_GRID_ORIGIN;
const CELL_COUNT = GRID_SIZE * GRID_SIZE;
const SPOTTING_WIND_THRESHOLD_MPH = 18;
const PYRO_CLUSTER_CELLS = 8;
const PYRO_CLUSTER_DIM = GRID_SIZE / PYRO_CLUSTER_CELLS;
const PYRO_CLUSTER_COUNT = PYRO_CLUSTER_DIM * PYRO_CLUSTER_DIM;
const PYRO_COLUMN_MAX = 12;
const PYRO_PUFFS_PER_COLUMN = 20;
const PYRO_CAPACITY = PYRO_COLUMN_MAX * PYRO_PUFFS_PER_COLUMN;
const SMOG_WALL_PUFFS = 40;
const ASH_CAPACITY = 1200;
const BLIZZARD_CAPACITY = 2200;
const WATER_CAPACITY = 2000;
const WATER_IMPACT_CAPACITY = 420;
const BASE_FOG_DENSITY = 0.016;
const WATER_RANGE = 22;
const MAX_WETNESS = 5;

export function getFireGridCellIndex(x: number, z: number) {
  const column = Math.floor((x - GRID_ORIGIN) / CELL_SIZE);
  const row = Math.floor((z - GRID_ORIGIN) / CELL_SIZE);
  if (column < 0 || column >= GRID_SIZE || row < 0 || row >= GRID_SIZE) return -1;
  return row * GRID_SIZE + column;
}

const NO_FUEL = 0;
const GRASS = 1;
const BRUSH = 2;
const TREE = 3;
const UNBURNED = 0;
const BURNING = 1;
const BURNED = 2;
const FIREBREAK = 3;

/**
 * A small cellular-automata fire model. The simulation grid is invisible;
 * instanced flame billboards, pooled pyrocumulus columns, and atmospheric
 * particles provide the visuals.
 */
export function createFireSimulation(options: FireSystemOptions): FireSimulation {
  const { THREE, scene, terrainHeight, random, trees, bushes, grassPatches } = options;
  const fuels = new Uint8Array(CELL_COUNT);
  const states = new Uint8Array(CELL_COUNT);
  const crownMask = new Uint8Array(CELL_COUNT);
  const age = new Float32Array(CELL_COUNT);
  const burnDuration = new Float32Array(CELL_COUNT);
  const flameHeight = new Float32Array(CELL_COUNT);
  const spreadClock = new Float32Array(CELL_COUNT);
  const emissionClock = new Float32Array(CELL_COUNT);
  const emberSpotCooldown = new Float32Array(CELL_COUNT);
  const wetnessTimer = new Float32Array(CELL_COUNT);
  const waterCooling = new Float32Array(CELL_COUNT);
  const burnSlot = new Int32Array(CELL_COUNT);
  burnSlot.fill(-1);
  // Sparse simulation list: only burning cells receive per-frame simulation work.
  const activeCells: number[] = [];
  let lastDig: { x: number; z: number } | null = null;

  let windDirection = 90;
  let windSpeed = 15;
  let burningCount = 0;
  let burnedCount = 0;
  let crownCount = 0;
  let firebreakCount = 0;
  let statsClock = 0;
  let statsDirty = true;

  const cellX = (index: number) => GRID_ORIGIN + (index % GRID_SIZE + 0.5) * CELL_SIZE;
  const cellZ = (index: number) => GRID_ORIGIN + (Math.floor(index / GRID_SIZE) + 0.5) * CELL_SIZE;
  const columnOf = (index: number) => index % GRID_SIZE;
  const rowOf = (index: number) => Math.floor(index / GRID_SIZE);
  const cellGround = new Float32Array(CELL_COUNT);
  const treeHeightByCell = new Float32Array(CELL_COUNT);
  for (let index = 0; index < CELL_COUNT; index++) {
    cellGround[index] = terrainHeight(cellX(index), cellZ(index));
  }

  // Continuous grass fuel lets the initial edge fire read as a connected front.
  // Real tree and brush locations override grass with their heavier fuel types.
  fuels.fill(GRASS);

  const paintFuel = (point: FuelPoint, fuel: number, radius: number) => {
    const minX = Math.max(0, Math.floor((point.x - radius - GRID_ORIGIN) / CELL_SIZE));
    const maxX = Math.min(GRID_SIZE - 1, Math.floor((point.x + radius - GRID_ORIGIN) / CELL_SIZE));
    const minZ = Math.max(0, Math.floor((point.z - radius - GRID_ORIGIN) / CELL_SIZE));
    const maxZ = Math.min(GRID_SIZE - 1, Math.floor((point.z + radius - GRID_ORIGIN) / CELL_SIZE));
    for (let row = minZ; row <= maxZ; row++) {
      for (let column = minX; column <= maxX; column++) {
        const index = row * GRID_SIZE + column;
        const dx = cellX(index) - point.x;
        const dz = cellZ(index) - point.z;
        if (dx * dx + dz * dz <= radius * radius) {
          if (fuels[index] < fuel) fuels[index] = fuel;
          if (fuel === TREE && point.height) treeHeightByCell[index] = Math.max(treeHeightByCell[index], point.height);
        }
      }
    }
  };

  grassPatches.forEach((point) => paintFuel(point, GRASS, 1.45));
  bushes.forEach((point) => paintFuel(point, BRUSH, 1.05));
  trees.forEach((point) => paintFuel(point, TREE, 1.18));

  const plane = new THREE.PlaneGeometry(1, 1);
  const flameTexture = createFlameTexture(THREE);
  const flameMaterial = new THREE.MeshBasicMaterial({
    map: flameTexture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const innerFlameMaterial = new THREE.MeshBasicMaterial({
    map: flameTexture,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const outerFlames = new THREE.InstancedMesh(plane, flameMaterial, CELL_COUNT);
  const innerFlames = new THREE.InstancedMesh(plane, innerFlameMaterial, CELL_COUNT);
  outerFlames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  innerFlames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  outerFlames.frustumCulled = false;
  innerFlames.frustumCulled = false;
  const dummy = new THREE.Object3D();
  const pyroColor = new THREE.Color();
  dummy.scale.set(0, 0, 0);
  dummy.updateMatrix();
  for (let i = 0; i < CELL_COUNT; i++) {
    outerFlames.setMatrixAt(i, dummy.matrix);
    innerFlames.setMatrixAt(i, dummy.matrix);
  }
  scene.add(outerFlames, innerFlames);
  const frontByRow = new Int32Array(GRID_SIZE);
  const setFlameMatrix = (
    mesh: any,
    index: number,
    x: number,
    z: number,
    ground: number,
    width: number,
    height: number,
    rotation: number,
    camera?: any,
  ) => {
    dummy.position.set(x, ground + height / 2, z);
    dummy.scale.set(width, height, 1);
    if (camera) {
      dummy.quaternion.copy(camera.quaternion);
      dummy.rotateZ(rotation);
    } else {
      dummy.rotation.set(0, 0, rotation);
    }
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  };

  const burnLifeFactor = (index: number) => {
    const progress = age[index] / Math.max(1, burnDuration[index]);
    return progress <= 0.68 ? 1 : Math.max(0.24, 1 - ((progress - 0.68) / 0.32) * 0.76);
  };

  // Firebreak circles are instanced into one mesh and added only when dug.
  const dirtGeometry = new THREE.CircleGeometry(1, 8);
  dirtGeometry.rotateX(-Math.PI / 2);
  const dirtMaterial = new THREE.MeshStandardMaterial({
    color: '#735438',
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const dirtPatches = new THREE.InstancedMesh(dirtGeometry, dirtMaterial, CELL_COUNT);
  dirtPatches.count = 0;
  dirtPatches.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dirtPatches.frustumCulled = false;
  scene.add(dirtPatches);
  let dirtCount = 0;

  const smokeTexture = createParticleTexture(THREE, 'smoke');
  const smogTexture = createParticleTexture(THREE, 'smog');
  const emberTexture = createParticleTexture(THREE, 'ember');
  const ashTexture = createParticleTexture(THREE, 'ash');
  const emberCapacity = 3000;
  const emberPositions = new Float32Array(emberCapacity * 3);
  const emberColors = new Float32Array(emberCapacity * 3);
  const emberGeometry = makeParticleGeometry(THREE, emberPositions, emberColors);
  const pyroMaterial = new THREE.MeshBasicMaterial({
    map: smokeTexture,
    color: '#4a433c',
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    vertexColors: true,
    fog: true,
  });
  const pyroColumns = new THREE.InstancedMesh(plane, pyroMaterial, PYRO_CAPACITY);
  pyroColumns.count = PYRO_CAPACITY;
  pyroColumns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pyroColumns.frustumCulled = false;
  for (let i = 0; i < PYRO_CAPACITY; i++) {
    pyroColumns.setMatrixAt(i, dummy.matrix);
    pyroColumns.setColorAt(i, pyroColor.setRGB(0.28, 0.24, 0.2));
  }
  if (pyroColumns.instanceColor) pyroColumns.instanceColor.needsUpdate = true;
  scene.add(pyroColumns);
  const smogMaterial = new THREE.MeshBasicMaterial({
    map: smogTexture,
    color: '#5a4a38',
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const smogWall = new THREE.InstancedMesh(plane, smogMaterial, SMOG_WALL_PUFFS);
  smogWall.count = SMOG_WALL_PUFFS;
  smogWall.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  smogWall.frustumCulled = false;
  for (let i = 0; i < SMOG_WALL_PUFFS; i++) smogWall.setMatrixAt(i, dummy.matrix);
  scene.add(smogWall);
  const emberMaterial = new THREE.PointsMaterial({
    map: emberTexture,
    size: 0.16,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const emberPoints = new THREE.Points(emberGeometry, emberMaterial);
  emberPoints.frustumCulled = false;
  scene.add(emberPoints);
  const waterTexture = createParticleTexture(THREE, 'water');
  const waterPositions = new Float32Array(WATER_CAPACITY * 3);
  const waterColors = new Float32Array(WATER_CAPACITY * 3);
  const waterGeometry = makeParticleGeometry(THREE, waterPositions, waterColors);
  const waterMaterial = new THREE.PointsMaterial({
    map: waterTexture,
    size: 0.34,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const waterPoints = new THREE.Points(waterGeometry, waterMaterial);
  waterPoints.frustumCulled = false;
  scene.add(waterPoints);
  const impactPositions = new Float32Array(WATER_IMPACT_CAPACITY * 3);
  const impactColors = new Float32Array(WATER_IMPACT_CAPACITY * 3);
  const impactGeometry = makeParticleGeometry(THREE, impactPositions, impactColors);
  const impactMaterial = new THREE.PointsMaterial({
    map: waterTexture,
    size: 0.72,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const impactPoints = new THREE.Points(impactGeometry, impactMaterial);
  impactPoints.frustumCulled = false;
  scene.add(impactPoints);
  const ashPositions = new Float32Array(ASH_CAPACITY * 3);
  const ashColors = new Float32Array(ASH_CAPACITY * 3);
  const ashGeometry = makeParticleGeometry(THREE, ashPositions, ashColors);
  const ashMaterial = new THREE.PointsMaterial({
    map: ashTexture,
    size: 0.11,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const ashPoints = new THREE.Points(ashGeometry, ashMaterial);
  ashPoints.frustumCulled = false;
  scene.add(ashPoints);
  const blizzardPositions = new Float32Array(BLIZZARD_CAPACITY * 3);
  const blizzardColors = new Float32Array(BLIZZARD_CAPACITY * 3);
  const blizzardGeometry = makeParticleGeometry(THREE, blizzardPositions, blizzardColors);
  const blizzardMaterial = new THREE.PointsMaterial({
    map: emberTexture,
    size: 0.14,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const blizzardPoints = new THREE.Points(blizzardGeometry, blizzardMaterial);
  blizzardPoints.frustumCulled = false;
  scene.add(blizzardPoints);

  // Ember trail streaks: one LineSegments draw call, 2 vertices per ember.
  // Tail position is extrapolated backward from velocity so wind-blown
  // embers naturally produce long directional streaks.
  const trailPositions = new Float32Array(emberCapacity * 6);
  const trailColors = new Float32Array(emberCapacity * 6);
  const trailGeometry = makeParticleGeometry(THREE, trailPositions, trailColors);
  const trailMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trailLines = new THREE.LineSegments(trailGeometry, trailMaterial);
  trailLines.frustumCulled = false;
  scene.add(trailLines);

  const emberParticles: Particle[] = [];
  let emberCursor = 0;
  const waterParticles: WaterParticle[] = [];
  let waterCursor = 0;
  const impactParticles: Particle[] = [];
  let impactCursor = 0;
  const ashParticles: Particle[] = [];
  let ashCursor = 0;
  const blizzardParticles: Particle[] = [];
  let blizzardCursor = 0;
  const pyroClusterHeat = new Float32Array(PYRO_CLUSTER_COUNT);
  const pyroClusterX = new Float32Array(PYRO_CLUSTER_COUNT);
  const pyroClusterZ = new Float32Array(PYRO_CLUSTER_COUNT);
  const pyroClusterGround = new Float32Array(PYRO_CLUSTER_COUNT);
  const pyroClusterN = new Uint16Array(PYRO_CLUSTER_COUNT);
  const pyroColumnsState = Array.from({ length: PYRO_COLUMN_MAX }, () => ({
    active: false,
    x: 0,
    z: 0,
    ground: 0,
    intensity: 0,
    seed: random(),
  }));
  const atmosphere: AtmosphereState = {
    heat: 0,
    smog: 0,
    emberStorm: 0,
    fogDensity: BASE_FOG_DENSITY,
    glowX: 0,
    glowY: 8,
    glowZ: 0,
    glowStrength: 0,
  };

  const hideFlame = (index: number) => {
    dummy.position.set(0, -1000, 0);
    dummy.quaternion.identity();
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(0, 0, 0);
    dummy.updateMatrix();
    outerFlames.setMatrixAt(index, dummy.matrix);
    innerFlames.setMatrixAt(index, dummy.matrix);
    outerFlames.instanceMatrix.needsUpdate = true;
    innerFlames.instanceMatrix.needsUpdate = true;
  };

  const hideSprite = (mesh: any, index: number) => {
    dummy.position.set(0, -2000, 0);
    dummy.scale.set(0, 0, 0);
    dummy.quaternion.identity();
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  };

  const clusterOf = (index: number) => {
    const column = Math.floor(columnOf(index) / PYRO_CLUSTER_CELLS);
    const row = Math.floor(rowOf(index) / PYRO_CLUSTER_CELLS);
    return row * PYRO_CLUSTER_DIM + column;
  };

  const bandFalloff = (value: number, center: number, width: number) => {
    const t = Math.abs(value - center) / width;
    return t >= 1 ? 0 : 1 - t * t;
  };

  const updatePyrocumulus = (elapsed: number, camera: any) => {
    pyroClusterHeat.fill(0);
    pyroClusterX.fill(0);
    pyroClusterZ.fill(0);
    pyroClusterGround.fill(0);
    pyroClusterN.fill(0);
    for (const index of activeCells) {
      const weight = crownMask[index]
        ? 3.2
        : fuels[index] === TREE
          ? 1.8
          : fuels[index] === BRUSH
            ? 0.9
            : 0.22;
      const cluster = clusterOf(index);
      const mass = weight * burnLifeFactor(index);
      pyroClusterHeat[cluster] += mass;
      pyroClusterX[cluster] += cellX(index) * mass;
      pyroClusterZ[cluster] += cellZ(index) * mass;
      pyroClusterGround[cluster] += cellGround[index] * mass;
      pyroClusterN[cluster] += 1;
    }
    const ranked: number[] = [];
    for (let cluster = 0; cluster < PYRO_CLUSTER_COUNT; cluster++) {
      if (pyroClusterHeat[cluster] < 3.4) continue;
      ranked.push(cluster);
    }
    ranked.sort((a, b) => pyroClusterHeat[b] - pyroClusterHeat[a]);
    const chosen = ranked.slice(0, PYRO_COLUMN_MAX);
    for (let column = 0; column < PYRO_COLUMN_MAX; column++) {
      const state = pyroColumnsState[column];
      const cluster = chosen[column];
      if (cluster === undefined) {
        state.intensity *= 0.9;
        if (state.intensity < 0.05) state.active = false;
        continue;
      }
      const weight = pyroClusterHeat[cluster];
      const x = pyroClusterX[cluster] / weight;
      const z = pyroClusterZ[cluster] / weight;
      const ground = pyroClusterGround[cluster] / weight;
      if (!state.active) {
        state.x = x;
        state.z = z;
        state.ground = ground;
        state.active = true;
      } else {
        state.x += (x - state.x) * 0.08;
        state.z += (z - state.z) * 0.08;
        state.ground += (ground - state.ground) * 0.08;
      }
      const target = Math.min(1, pyroClusterHeat[cluster] / 18);
      state.intensity += (target - state.intensity) * 0.12;
    }
    const wind = windVector();
    const windStrength = windSpeed / 35;
    for (let column = 0; column < PYRO_COLUMN_MAX; column++) {
      const state = pyroColumnsState[column];
      for (let layer = 0; layer < PYRO_PUFFS_PER_COLUMN; layer++) {
        const puffIndex = column * PYRO_PUFFS_PER_COLUMN + layer;
        if (!state.active || state.intensity < 0.04) {
          hideSprite(pyroColumns, puffIndex);
          continue;
        }
        const t = layer / (PYRO_PUFFS_PER_COLUMN - 1);
        const phase = elapsed * (0.11 + state.seed * 0.05) + layer * 0.47 + state.seed * 8;
        const rise = 8 + t * (52 + state.intensity * 48);
        const swell = t * t;
        const size = (7 + swell * (42 + state.intensity * 36)) * (0.86 + Math.sin(phase) * 0.12);
        dummy.position.set(
          state.x + wind.x * (8 + t * (22 + windStrength * 28)) + Math.sin(phase) * (1.4 + t * 9),
          state.ground + rise + Math.sin(phase * 0.7) * (1.2 + t * 4),
          state.z + wind.z * (8 + t * (22 + windStrength * 28)) + Math.cos(phase * 0.8) * (1.6 + t * 10),
        );
        dummy.scale.set(size, size * (0.62 + t * 0.28), 1);
        dummy.quaternion.copy(camera.quaternion);
        dummy.updateMatrix();
        pyroColumns.setMatrixAt(puffIndex, dummy.matrix);
        const shade = 0.18 + t * 0.22;
        pyroColor.setRGB(shade * 1.15, shade * 0.92, shade * 0.72).multiplyScalar(0.55 + state.intensity * 0.45);
        pyroColumns.setColorAt(puffIndex, pyroColor);
      }
    }
    pyroColumns.instanceMatrix.needsUpdate = true;
    if (pyroColumns.instanceColor) pyroColumns.instanceColor.needsUpdate = true;
  };

  const updateSmogWall = (elapsed: number, camera: any, smog: number, frontX: number) => {
    smogMaterial.opacity = 0.08 + smog * 0.52;
    const wind = windVector();
    const wallX = frontX + 34;
    const camZ = camera.position.z;
    for (let puff = 0; puff < SMOG_WALL_PUFFS; puff++) {
      if (smog < 0.04) {
        hideSprite(smogWall, puff);
        continue;
      }
      const column = puff % 10;
      const row = Math.floor(puff / 10);
      const phase = elapsed * 0.16 + puff * 0.51;
      const puffX = wallX + wind.x * 6 + Math.sin(phase) * 4.5 + column * 1.1;
      const puffZ = camZ - 42 + column * 9.2 + Math.cos(phase * 0.55) * 3.2;
      dummy.position.set(
        puffX,
        terrainHeight(puffX, puffZ) + 3.5 + row * 5.4 + Math.sin(phase * 0.7) * 1.8,
        puffZ,
      );
      dummy.scale.set(22 + Math.sin(phase) * 3, 14 + row * 1.4, 1);
      dummy.quaternion.copy(camera.quaternion);
      dummy.updateMatrix();
      smogWall.setMatrixAt(puff, dummy.matrix);
    }
    smogWall.instanceMatrix.needsUpdate = true;
  };

  const spawnAmbientAsh = (camera: any, count: number) => {
    const wind = windVector();
    const strength = windSpeed / 35;
    for (let i = 0; i < count; i++) {
      const x = camera.position.x + (random() - 0.5) * 110;
      const z = camera.position.z + (random() - 0.5) * 110;
      ashCursor = addParticle(ashParticles, ASH_CAPACITY, ashCursor, {
        x,
        y: camera.position.y + 6 + random() * 18,
        z,
        vx: wind.x * (1.2 + strength * 4) + (random() - 0.5) * 0.6,
        vy: -0.35 - random() * 1.4,
        vz: wind.z * (1.2 + strength * 4) + (random() - 0.5) * 0.6,
        age: 0,
        life: 4.5 + random() * 5.5,
      });
    }
  };

  const spawnEmberBlizzard = (camera: any, intensity: number, dt: number) => {
    if (intensity < 0.05) return;
    const wind = windVector();
    const spawnCount = Math.min(80, Math.ceil(55 * intensity + 400 * intensity * dt));
    const sidewaysX = -wind.z;
    const sidewaysZ = wind.x;
    for (let i = 0; i < spawnCount; i++) {
      const lateral = (random() - 0.5) * 28;
      const ahead = -8 + random() * 18;
      blizzardCursor = addParticle(blizzardParticles, BLIZZARD_CAPACITY, blizzardCursor, {
        x: camera.position.x + wind.x * ahead + sidewaysX * lateral,
        y: camera.position.y + (random() - 0.35) * 8,
        z: camera.position.z + wind.z * ahead + sidewaysZ * lateral,
        vx: wind.x * (14 + random() * 22) + (random() - 0.5) * 3,
        vy: (random() - 0.6) * 4.5,
        vz: wind.z * (14 + random() * 22) + (random() - 0.5) * 3,
        age: 0,
        life: 0.55 + random() * 1.1,
      });
    }
  };

  const updateWaterParticles = (dt: number) => {
    const positions = waterPositions;
    const colors = waterColors;
    for (let i = waterParticles.length - 1; i >= 0; i--) {
      const particle = waterParticles[i];
      particle.age += dt;
      particle.vy += -9.8 * dt * 0.42;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      const offset = i * 3;
      positions[offset] = particle.x;
      positions[offset + 1] = particle.y;
      positions[offset + 2] = particle.z;
      const fade = 1 - particle.age / particle.life;
      colors[offset] = 0.68 + fade * 0.22;
      colors[offset + 1] = 0.82 + fade * 0.17;
      colors[offset + 2] = 1.0;
      const impactGround = particle.y <= terrainHeight(particle.x, particle.z) + 0.12;
      if (particle.age >= particle.life || impactGround) {
        const impactIndex = getFireGridCellIndex(particle.x, particle.z);
        if (impactIndex >= 0) {
          wetnessTimer[impactIndex] = Math.min(MAX_WETNESS, wetnessTimer[impactIndex] + 2.5);
          if (states[impactIndex] === BURNING) {
            waterCooling[impactIndex] = Math.min(0.9, waterCooling[impactIndex] + 0.36);
          }
        }
        if (impactGround) {
          for (let burst = 0; burst < 8; burst++) {
            impactCursor = addParticle(impactParticles, WATER_IMPACT_CAPACITY, impactCursor, {
              x: particle.x + (random() - 0.5) * 0.55,
              y: particle.y + 0.18 + random() * 0.5,
              z: particle.z + (random() - 0.5) * 0.55,
              vx: (random() - 0.5) * 1.4,
              vy: 0.8 + random() * 1.2,
              vz: (random() - 0.5) * 1.4,
              age: 0,
              life: 0.38 + random() * 0.26,
            });
          }
        }
        waterParticles.splice(i, 1);
      }
    }
    waterGeometry.setDrawRange(0, waterParticles.length);
    waterGeometry.attributes.position.needsUpdate = true;
    waterGeometry.attributes.color.needsUpdate = true;
  };

  const updateImpactParticles = (dt: number) => {
    const positions = impactPositions;
    const colors = impactColors;
    for (let i = impactParticles.length - 1; i >= 0; i--) {
      const particle = impactParticles[i];
      particle.age += dt;
      particle.vy -= 3.8 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      const offset = i * 3;
      positions[offset] = particle.x;
      positions[offset + 1] = particle.y;
      positions[offset + 2] = particle.z;
      const fade = 1 - particle.age / particle.life;
      colors[offset] = 0.6 + fade * 0.35;
      colors[offset + 1] = 0.78 + fade * 0.2;
      colors[offset + 2] = 1.0;
      if (particle.age >= particle.life) {
        const last = impactParticles.length - 1;
        if (last !== i) {
          impactParticles[i] = impactParticles[last];
        }
        impactParticles.pop();
      }
    }
    impactGeometry.setDrawRange(0, impactParticles.length);
    impactGeometry.attributes.position.needsUpdate = true;
    impactGeometry.attributes.color.needsUpdate = true;
  };

  const updateVisualParticles = (
    particles: Particle[],
    dt: number,
    positions: Float32Array,
    colors: Float32Array,
    geometry: any,
    kind: 'ash' | 'blizzard',
  ) => {
    const wind = windVector();
    const windStrength = windSpeed / 35;
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      particle.age += dt;
      if (particle.age >= particle.life) {
        const lastIdx = particles.length - 1;
        if (lastIdx !== i) {
          positions[i * 3] = positions[lastIdx * 3];
          positions[i * 3 + 1] = positions[lastIdx * 3 + 1];
          positions[i * 3 + 2] = positions[lastIdx * 3 + 2];
          colors[i * 3] = colors[lastIdx * 3];
          colors[i * 3 + 1] = colors[lastIdx * 3 + 1];
          colors[i * 3 + 2] = colors[lastIdx * 3 + 2];
        }
        particles[i] = particles[lastIdx];
        particles.pop();
        continue;
      }
      const fade = 1 - particle.age / particle.life;
      particle.vx += wind.x * windStrength * (kind === 'blizzard' ? 8 : 1.4) * dt;
      particle.vz += wind.z * windStrength * (kind === 'blizzard' ? 8 : 1.4) * dt;
      particle.vy += (kind === 'ash' ? -0.35 : -0.1) * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      const offset = i * 3;
      positions[offset] = particle.x;
      positions[offset + 1] = particle.y;
      positions[offset + 2] = particle.z;
      if (kind === 'ash') {
        const grey = 0.28 + fade * 0.42;
        colors[offset] = grey * 1.05;
        colors[offset + 1] = grey * 0.95;
        colors[offset + 2] = grey * 0.82;
      } else {
        colors[offset] = 1;
        colors[offset + 1] = 0.28 + fade * 0.55;
        colors[offset + 2] = 0.04 + fade * 0.1;
      }
    }
    geometry.setDrawRange(0, particles.length);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  };

  const removeActiveCell = (index: number) => {
    const slot = burnSlot[index];
    if (slot < 0) return;
    const lastIndex = activeCells[activeCells.length - 1];
    activeCells[slot] = lastIndex;
    burnSlot[lastIndex] = slot;
    activeCells.pop();
    burnSlot[index] = -1;
  };

  const getStats = (): FireStats => ({
    burningCells: burningCount,
    burnedCells: burnedCount,
    crownFireCells: crownCount,
    firebreakCells: firebreakCount,
  });

  const maybePublishStats = (force = false) => {
    statsClock += 0;
    if (force || statsDirty) options.onStats?.(getStats());
    statsDirty = false;
  };

  const addParticle = (
    particles: Particle[],
    capacity: number,
    cursor: number,
    particle: Particle,
  ): number => {
    if (particles.length < capacity) {
      particles.push(particle);
      return cursor;
    }
    const slot = cursor % capacity;
    particles[slot] = particle;
    return (slot + 1) % capacity;
  };

  const windVector = () => {
    const radians = (windDirection * Math.PI) / 180;
    return { x: Math.sin(radians), z: -Math.cos(radians) };
  };

  const emitForCell = (index: number, initial = false) => {
    const type = fuels[index];
    const x = cellX(index);
    const z = cellZ(index);
    const ground = cellGround[index];
    const wind = windVector();
    const strength = windSpeed / 35;
    const emberCount = type === GRASS ? (initial ? 1 : 0) : initial ? (type === TREE ? 5 : 3) : crownMask[index] ? 3 : type === TREE ? 2 : 1;
    for (let i = 0; i < emberCount; i++) {
      const p: Particle = {
        x: x + (random() - 0.5) * CELL_SIZE * 0.45,
        y: ground + 0.4 + random() * Math.max(0.3, flameHeight[index] * 0.22),
        z: z + (random() - 0.5) * CELL_SIZE * 0.45,
        vx: wind.x * (0.3 + strength * 2.8) + (random() - 0.5) * 1.1,
        vy: 0.8 + random() * 2.4 + (crownMask[index] ? 1.5 : 0),
        vz: wind.z * (0.3 + strength * 2.8) + (random() - 0.5) * 1.1,
        age: 0,
        life: 1.6 + random() * 3.0,
      };
      emberCursor = addParticle(emberParticles, emberCapacity, emberCursor, p);
    }
  };

  const countDenseNeighbors = (index: number) => {
    const column = columnOf(index);
    const row = rowOf(index);
    let count = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const x = column + dx;
        const z = row + dz;
        if (x < 0 || x >= GRID_SIZE || z < 0 || z >= GRID_SIZE) continue;
        if (fuels[z * GRID_SIZE + x] >= BRUSH) count++;
      }
    }
    return count;
  };

  const getRadiantHeatAtCell = (index: number) => {
    if (index < 0) return 0;
    const x = cellX(index);
    const z = cellZ(index);
    let peak = 0;
    for (const burning of activeCells) {
      if (burning === index) continue;
      const dist = Math.hypot(cellX(burning) - x, cellZ(burning) - z);
      if (dist > 14) continue;
      const fireMass = crownMask[burning] ? 1.6 : fuels[burning] === TREE ? 1.3 : fuels[burning] === BRUSH ? 1.1 : 0.7;
      const proximity = 1 - dist / 14;
      const heat = proximity * fireMass * (flameHeight[burning] / 12);
      if (heat > peak) peak = heat;
    }
    return Math.min(1.2, peak);
  };

  const ignite = (index: number, incomingSlope = 0) => {
    if (index < 0 || states[index] !== UNBURNED || fuels[index] === NO_FUEL) return false;
    if (wetnessTimer[index] > 0) {
      const wetGuard = Math.min(0.7, wetnessTimer[index] / MAX_WETNESS * 0.7);
      const radiantHeat = getRadiantHeatAtCell(index);
      const ignitionChance = Math.max(0.12, 1 - wetGuard - radiantHeat * 0.2);
      if (random() > ignitionChance) return false;
    }
    const type = fuels[index];
    const dense = countDenseNeighbors(index) >= 3;
    const crown = windSpeed >= 22 && type >= BRUSH && dense;
    const nearbyTreeHeight = treeHeightByCell[index] || 7.8;
    states[index] = BURNING;
    crownMask[index] = crown ? 1 : 0;
    age[index] = 0;
    spreadClock[index] = 1.8 + random() * 1.2;
    emissionClock[index] = 0;
    let duration = type === GRASS ? 14 + random() * 7
      : type === BRUSH ? 20 + random() * 10
      : 30 + random() * 16;
    if (crown) duration *= 1.28;
    burnDuration[index] = duration;
    const baseFlameHeight = type === GRASS
      ? 1.45 + windSpeed / 35 * 0.65
      : crown
        ? Math.max(12.5, nearbyTreeHeight * 1.5) + random() * 2.4
        : type === BRUSH
          ? 3.8 + windSpeed / 35 * 1.2
          : nearbyTreeHeight * 1.28 + windSpeed / 35 * 0.8;
    // A fire that climbs into elevated fuel burns taller from radiant preheating.
    const uphillFlameMultiplier = Math.min(2.5, 1 + Math.max(0, incomingSlope) * 1.5);
    flameHeight[index] = baseFlameHeight * uphillFlameMultiplier;
    const slot = activeCells.length;
    activeCells.push(index);
    burnSlot[index] = slot;
    burningCount++;
    if (crown) crownCount++;
    const outerColor = type === GRASS ? '#ff8a2d' : type === BRUSH ? '#ff6a21' : '#ff4b16';
    outerFlames.setColorAt(index, new THREE.Color(outerColor));
    innerFlames.setColorAt(index, new THREE.Color(crown ? '#fff0a0' : '#ffd76b'));
    const x = cellX(index);
    const z = cellZ(index);
    const flameWidth = type === GRASS ? CELL_SIZE * 1.42 : CELL_SIZE * 1.22;
    const coreWidth = type === GRASS ? CELL_SIZE * 0.98 : CELL_SIZE * 0.68;
    setFlameMatrix(outerFlames, index, x, z, cellGround[index], flameWidth, flameHeight[index], 0);
    setFlameMatrix(innerFlames, index, x, z, cellGround[index], coreWidth, flameHeight[index] * 0.58, 0.02);
    emitForCell(index, true);
    statsDirty = true;
    return true;
  };

  const spawnSpottingEmber = (sourceIndex: number) => {
    const wind = windVector();
    const perpendicularX = -wind.z;
    const perpendicularZ = wind.x;
    const sourceX = cellX(sourceIndex);
    const sourceZ = cellZ(sourceIndex);
    const sourceY = cellGround[sourceIndex] + Math.max(1, flameHeight[sourceIndex] * 0.78);

    const distanceCells = 1 + Math.floor(random() * 7);
    const crosswindCells = (random() - 0.5) * 1.4;
    const landingX = sourceX +
      (wind.x * distanceCells + perpendicularX * crosswindCells) * CELL_SIZE;
    const landingZ = sourceZ +
      (wind.z * distanceCells + perpendicularZ * crosswindCells) * CELL_SIZE;
    const targetIndex = getFireGridCellIndex(landingX, landingZ);
    if (targetIndex >= 0 && wetnessTimer[targetIndex] > 0) {
      const wetResistance = Math.min(0.7, wetnessTimer[targetIndex] / MAX_WETNESS * 0.7);
      const windPressure = Math.max(0, (windSpeed - 18) / 20);
      const emberChance = Math.max(0.12, 0.32 + (0.7 - wetResistance) * 0.55 + windPressure * 0.28 + getRadiantHeatAtCell(targetIndex) * 0.12);
      if (random() > emberChance) return false;
    }
    const onFuel = targetIndex >= 0 && states[targetIndex] === UNBURNED && fuels[targetIndex] !== NO_FUEL;
    // Most embers that land on fuel ignite it, but a meaningful minority fizzle out.
    const willIgnite = onFuel && random() < 0.65;

    const targetX = willIgnite ? cellX(targetIndex) : landingX;
    const targetZ = willIgnite ? cellZ(targetIndex) : landingZ;
    const targetY = willIgnite
      ? cellGround[targetIndex] + 0.16
      : terrainHeight(landingX, landingZ) + 0.16;
    const flightTime = 0.9 + distanceCells * 0.35;
    const particle: Particle = {
      x: sourceX,
      y: sourceY,
      z: sourceZ,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
      life: flightTime,
      spotTargetIndex: willIgnite ? targetIndex : undefined,
      startX: sourceX,
      startY: sourceY,
      startZ: sourceZ,
      targetX,
      targetY,
      targetZ,
      arcHeight: 3 + distanceCells * 1.2,
      turbPhase: random() * Math.PI * 2,
      turbFreq: 2.5 + random() * 4.5,
      turbAmp: 0.6 + random() * 1.8,
    };
    emberCursor = addParticle(emberParticles, emberCapacity, emberCursor, particle);
    return true;
  };

  const finishBurn = (index: number) => {
    states[index] = BURNED;
    fuels[index] = NO_FUEL;
    burnedCount++;
    burningCount = Math.max(0, burningCount - 1);
    if (crownMask[index]) crownCount = Math.max(0, crownCount - 1);
    crownMask[index] = 0;
    removeActiveCell(index);
    hideFlame(index);
    options.onCellBurned?.(index);
    statsDirty = true;
  };

  const addDirtPatch = (index: number) => {
    if (dirtCount >= CELL_COUNT) return;
    const x = cellX(index);
    const z = cellZ(index);
    dummy.position.set(x, cellGround[index] + 0.035, z);
    dummy.rotation.set(0, random() * Math.PI * 2, 0);
    const diameter = CELL_SIZE * (1.06 + random() * 0.12);
    dummy.scale.set(diameter, diameter, diameter);
    dummy.updateMatrix();
    dirtPatches.setMatrixAt(dirtCount, dummy.matrix);
    const shade = ['#62452f', '#75563a', '#80603f', '#694b31'][Math.floor(random() * 4)];
    dirtPatches.setColorAt(dirtCount, new THREE.Color(shade));
    dirtCount++;
    dirtPatches.count = dirtCount;
    dirtPatches.instanceMatrix.needsUpdate = true;
    if (dirtPatches.instanceColor) dirtPatches.instanceColor.needsUpdate = true;
  };

  const makeFirebreak = (index: number) => {
    if (index < 0 || states[index] === FIREBREAK) return;
    if (states[index] === BURNING) {
      burningCount = Math.max(0, burningCount - 1);
      if (crownMask[index]) crownCount = Math.max(0, crownCount - 1);
      removeActiveCell(index);
      hideFlame(index);
    }
    states[index] = FIREBREAK;
    fuels[index] = NO_FUEL;
    crownMask[index] = 0;
    firebreakCount++;
    addDirtPatch(index);
    options.onDigCell?.(index);
    statsDirty = true;
  };

  const applyWaterToCell = (index: number, sprayPower: number, dt: number) => {
    if (index < 0) return;
    const radiantHeat = getRadiantHeatAtCell(index);
    const heatPenalty = Math.max(0.2, 1 - radiantHeat * 0.75);
    const targetWetness = Math.min(MAX_WETNESS, wetnessTimer[index] + dt * 5.2 * (0.6 + sprayPower) * heatPenalty);
    wetnessTimer[index] = targetWetness;
    if (states[index] === BURNING) {
      waterCooling[index] = Math.min(0.9, waterCooling[index] + dt * (0.28 + sprayPower * 0.38) * heatPenalty);
    }
  };

  const digAt = (x: number, z: number) => {
    const gridEnd = GRID_ORIGIN + GRID_SIZE * CELL_SIZE;
    if (x < GRID_ORIGIN || x > gridEnd || z < GRID_ORIGIN || z > gridEnd) return;
    const start = lastDig ?? { x, z };
    const distance = Math.hypot(x - start.x, z - start.z);
    const steps = Math.max(1, Math.ceil(distance / (CELL_SIZE * 0.34)));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const px = start.x + (x - start.x) * t;
      const pz = start.z + (z - start.z) * t;
      const centerColumn = Math.floor((px - GRID_ORIGIN) / CELL_SIZE);
      const centerRow = Math.floor((pz - GRID_ORIGIN) / CELL_SIZE);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const column = centerColumn + dx;
          const row = centerRow + dz;
          if (column < 0 || column >= GRID_SIZE || row < 0 || row >= GRID_SIZE) continue;
          const index = row * GRID_SIZE + column;
          if (Math.hypot(cellX(index) - px, cellZ(index) - pz) <= CELL_SIZE * 0.72) makeFirebreak(index);
        }
      }
    }
    lastDig = { x, z };
  };

  const sprayWater = (origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }, dt: number) => {
    const dir = { x: direction.x, y: direction.y, z: direction.z };
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    dir.x /= len; dir.y /= len; dir.z /= len;
    const speed = 58 + windSpeed * 1.6;
    const streamCount = 20;
    for (let i = 0; i < streamCount; i++) {
      const travel = 0.18 + i * 0.34;
      const x = origin.x + dir.x * travel;
      const y = origin.y + dir.y * travel;
      const z = origin.z + dir.z * travel;
      const cellIndex = getFireGridCellIndex(x, z);
      if (cellIndex >= 0) applyWaterToCell(cellIndex, 1.1, dt);
      const particle: WaterParticle = {
        x,
        y: y,
        z,
        vx: dir.x * speed + (random() - 0.5) * 2.8,
        vy: dir.y * speed + (random() - 0.5) * 1.6,
        vz: dir.z * speed + (random() - 0.5) * 2.8,
        age: 0,
        life: 0.18 + random() * 0.12,
        size: 0.10 + random() * 0.18,
      };
      waterCursor = waterParticles.length < WATER_CAPACITY ? waterParticles.length : waterCursor % WATER_CAPACITY;
      if (waterParticles.length < WATER_CAPACITY) {
        waterParticles.push(particle);
      } else {
        waterParticles[waterCursor] = particle;
        waterCursor = (waterCursor + 1) % WATER_CAPACITY;
      }
    }
  };

  const updateParticleList = (
    particles: Particle[],
    dt: number,
    positions: Float32Array,
    colors: Float32Array,
    onSpotLanded?: (targetIndex: number) => void,
  ) => {
    const wind = windVector();
    const windStrength = windSpeed / 35;
    const landedSpotTargets: number[] = [];
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      particle.age += dt;
      if (particle.age >= particle.life) {
        if (particle.spotTargetIndex !== undefined) landedSpotTargets.push(particle.spotTargetIndex);
        const lastIdx = particles.length - 1;
        if (lastIdx !== i) {
          positions[i * 3] = positions[lastIdx * 3];
          positions[i * 3 + 1] = positions[lastIdx * 3 + 1];
          positions[i * 3 + 2] = positions[lastIdx * 3 + 2];
          colors[i * 3] = colors[lastIdx * 3];
          colors[i * 3 + 1] = colors[lastIdx * 3 + 1];
          colors[i * 3 + 2] = colors[lastIdx * 3 + 2];
          trailPositions[i * 6] = trailPositions[lastIdx * 6];
          trailPositions[i * 6 + 1] = trailPositions[lastIdx * 6 + 1];
          trailPositions[i * 6 + 2] = trailPositions[lastIdx * 6 + 2];
          trailPositions[i * 6 + 3] = trailPositions[lastIdx * 6 + 3];
          trailPositions[i * 6 + 4] = trailPositions[lastIdx * 6 + 4];
          trailPositions[i * 6 + 5] = trailPositions[lastIdx * 6 + 5];
          trailColors[i * 6] = trailColors[lastIdx * 6];
          trailColors[i * 6 + 1] = trailColors[lastIdx * 6 + 1];
          trailColors[i * 6 + 2] = trailColors[lastIdx * 6 + 2];
          trailColors[i * 6 + 3] = trailColors[lastIdx * 6 + 3];
          trailColors[i * 6 + 4] = trailColors[lastIdx * 6 + 4];
          trailColors[i * 6 + 5] = trailColors[lastIdx * 6 + 5];
        }
        particles[i] = particles[lastIdx];
        particles.pop();
        continue;
      }
      const fade = 1 - particle.age / particle.life;
      let evx: number, evy: number, evz: number;
      if (particle.spotTargetIndex !== undefined) {
        const progress = particle.age / particle.life;
        const prevX = particle.x, prevY = particle.y, prevZ = particle.z;
        const baseX = particle.startX! + (particle.targetX! - particle.startX!) * progress;
        const baseZ = particle.startZ! + (particle.targetZ! - particle.startZ!) * progress;
        const baseY = particle.startY! + (particle.targetY! - particle.startY!) * progress +
          Math.sin(Math.PI * progress) * (particle.arcHeight ?? 0);
        const tp = particle.turbPhase ?? 0;
        const tf = particle.turbFreq ?? 3;
        const ta = particle.turbAmp ?? 1;
        const wobble = Math.sin(tp + progress * tf * Math.PI * 2);
        const wobble2 = Math.cos(tp * 1.7 + progress * tf * 1.3 * Math.PI * 2);
        const wobble3 = Math.sin(tp * 0.6 + progress * tf * 0.9 * Math.PI * 2);
        particle.x = baseX + wobble * ta * (1 - progress * 0.5);
        particle.y = baseY + wobble3 * ta * 0.7 * (1 - progress * 0.3);
        particle.z = baseZ + wobble2 * ta * (1 - progress * 0.5);
        evx = (particle.x - prevX) / dt;
        evy = (particle.y - prevY) / dt;
        evz = (particle.z - prevZ) / dt;
      } else {
        const gust = (random() - 0.5) * 1.2 * windStrength;
        const gust2 = (random() - 0.5) * 1.2 * windStrength;
        particle.vx += (wind.x * windStrength * 2.0 + gust) * dt;
        particle.vz += (wind.z * windStrength * 2.0 + gust2) * dt;
        particle.vy += ((random() - 0.5) * 0.8 + 0.3 * windStrength) * dt;
        particle.vx *= 0.975;
        particle.vz *= 0.975;
        particle.vy *= 0.99;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.z += particle.vz * dt;
        evx = particle.vx;
        evy = particle.vy;
        evz = particle.vz;
      }
      const offset = i * 3;
      positions[offset] = particle.x;
      positions[offset + 1] = particle.y;
      positions[offset + 2] = particle.z;
      const r = 1;
      const g = 0.22 + fade * 0.62;
      const b = 0.035 + fade * 0.12;
      colors[offset] = r;
      colors[offset + 1] = g;
      colors[offset + 2] = b;
      const speed = Math.hypot(evx, evy, evz);
      const trailLen = Math.min(speed * 0.022, 0.35);
      const to = i * 6;
      trailPositions[to] = particle.x;
      trailPositions[to + 1] = particle.y;
      trailPositions[to + 2] = particle.z;
      trailColors[to] = r;
      trailColors[to + 1] = g;
      trailColors[to + 2] = b;
      if (speed > 0.01) {
        const inv = trailLen / speed;
        trailPositions[to + 3] = particle.x - evx * inv;
        trailPositions[to + 4] = particle.y - evy * inv;
        trailPositions[to + 5] = particle.z - evz * inv;
      } else {
        trailPositions[to + 3] = particle.x;
        trailPositions[to + 4] = particle.y;
        trailPositions[to + 5] = particle.z;
      }
      trailColors[to + 3] = r * 0.1;
      trailColors[to + 4] = g * 0.06;
      trailColors[to + 5] = 0;
    }
    emberGeometry.setDrawRange(0, particles.length);
    emberGeometry.attributes.position.needsUpdate = true;
    emberGeometry.attributes.color.needsUpdate = true;
    trailGeometry.setDrawRange(0, particles.length * 2);
    trailGeometry.attributes.position.needsUpdate = true;
    trailGeometry.attributes.color.needsUpdate = true;
    for (const targetIndex of landedSpotTargets) onSpotLanded?.(targetIndex);
  };

  const attemptSpread = (sourceIndex: number) => {
    const column = columnOf(sourceIndex);
    const row = rowOf(sourceIndex);
    const wind = windVector();
    const windStrength = windSpeed / 35;
    // The west-edge line advances east. Adjacent diagonals overlap the cells
    // along the front, while reverse spread and isolated spot fires are disabled.
    const directions = [[1, -1], [1, 0], [1, 1]];
    const sourceHeight = cellGround[sourceIndex];
    let fastestSlopeMultiplier = 1;
    for (const [dx, dz] of directions) {
      const nextColumn = column + dx;
      const nextRow = row + dz;
      if (nextColumn < 0 || nextColumn >= GRID_SIZE || nextRow < 0 || nextRow >= GRID_SIZE) continue;
      const next = nextRow * GRID_SIZE + nextColumn;
      if (wetnessTimer[next] > 0) continue;
      const targetFuel = fuels[next];
      if (states[next] !== UNBURNED || targetFuel === NO_FUEL) continue;
      const length = Math.hypot(dx, dz);
      const alignment = (dx / length) * wind.x + (dz / length) * wind.z;
      const directional = alignment >= 0
        ? 1 + alignment * windStrength * 2.75
        : Math.max(0.08, 1 + alignment * windStrength * 0.9);
      const baseProbability = targetFuel === GRASS ? 0.04 : targetFuel === BRUSH ? 0.48 : 0.72;
      const elevationDelta = cellGround[next] - sourceHeight;
      const slopeFactor = elevationDelta > 0
        ? 1 + Math.min(elevationDelta, 1.5) * 1.5
        : elevationDelta < 0 ? 0.5 : 1;
      fastestSlopeMultiplier = Math.max(fastestSlopeMultiplier, slopeFactor);
      const crownFactor = crownMask[sourceIndex] ? 1.65 : 1;
      const windFactor = 0.75 + windStrength * 1.25;
      const diagonalPenalty = length > 1 ? 0.76 : 1;
      const probability = Math.min(
        0.92,
        baseProbability * directional * slopeFactor * crownFactor * windFactor * diagonalPenalty,
      );
      if (random() < probability) ignite(next, Math.max(0, elevationDelta));
    }
    return fastestSlopeMultiplier;
  };

  const update = (dt: number, elapsed: number, camera: any) => {
    for (let i = 0; i < CELL_COUNT; i++) {
      if (wetnessTimer[i] > 0) {
        const radiantHeat = getRadiantHeatAtCell(i);
        const evaporativeLoss = 0.18 + radiantHeat * 0.9 + (windSpeed / 35) * 0.28;
        wetnessTimer[i] = Math.max(0, wetnessTimer[i] - dt * evaporativeLoss);
      }
      if (waterCooling[i] > 0) waterCooling[i] = Math.max(0, waterCooling[i] - dt * 0.72);
    }
    const turnCount = activeCells.length;
    for (let slot = turnCount - 1; slot >= 0; slot--) {
      const index = activeCells[slot];
      if (wetnessTimer[index] > 0) {
        const radiantHeat = getRadiantHeatAtCell(index);
        const damp = Math.min(1, wetnessTimer[index] / MAX_WETNESS);
        const flameResistance = Math.min(1, flameHeight[index] / 11);
        const suppression = Math.max(0, (0.7 + damp * 2.2) * (1 - flameResistance * 0.52) * Math.max(0.18, 1 - radiantHeat * 0.72));
        age[index] -= dt * suppression;
        spreadClock[index] += dt * (0.8 + damp * 2.1 + radiantHeat * 1.5);
        emissionClock[index] += dt * (0.9 + damp * 2.0 + radiantHeat * 1.2);
      }
      age[index] += dt;
      spreadClock[index] -= dt;
      emissionClock[index] += dt;
      emberSpotCooldown[index] = Math.max(0, emberSpotCooldown[index] - dt);
      const emissionInterval = crownMask[index] ? 0.18 : fuels[index] === TREE ? 0.38 : fuels[index] === BRUSH ? 0.55 : 1.0;
      if (emissionClock[index] > emissionInterval) {
        emissionClock[index] = 0;
        emitForCell(index);
      }
      const highIntensity = crownMask[index] === 1 || fuels[index] === BRUSH || fuels[index] === TREE;
      if (
        windSpeed >= SPOTTING_WIND_THRESHOLD_MPH &&
        highIntensity &&
        burnLifeFactor(index) >= 0.96 &&
        emberSpotCooldown[index] <= 0
      ) {
        emberSpotCooldown[index] = crownMask[index] ? 0.9 : 1.8;
        const spawnChance = crownMask[index] ? 0.85 : fuels[index] === BRUSH ? 0.45 : 0.32;
        if (random() < spawnChance) spawnSpottingEmber(index);
      }
      if (spreadClock[index] <= 0) {
        const slopeMultiplier = attemptSpread(index);
        spreadClock[index] = (2.1 + random() * 1.2) / slopeMultiplier;
      }
      if (age[index] >= burnDuration[index]) {
        finishBurn(index);
        continue;
      }
    }

    // Only burning cells are visited; the full grid is never scanned per frame.
    frontByRow.fill(-1);
    let nearestDist = 1e9;
    let nearestIndex = -1;
    let frontX = GRID_ORIGIN;
    for (const index of activeCells) {
      const row = rowOf(index);
      if (columnOf(index) > (frontByRow[row] < 0 ? -1 : columnOf(frontByRow[row]))) {
        frontByRow[row] = index;
      }
      const x = cellX(index);
      if (x > frontX) frontX = x;
      const dist = Math.hypot(x - camera.position.x, cellZ(index) - camera.position.z);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIndex = index;
      }
    }
    const approachDist = camera.position.x - frontX;
    const heat = nearestIndex < 0 ? 0 : THREE.MathUtils.clamp(1 - nearestDist / 36, 0, 1);
    const smog = bandFalloff(approachDist, 38, 40) * (burningCount > 0 ? 1 : 0);
    const emberStorm = bandFalloff(approachDist, 16, 15) * (burningCount > 0 ? 1 : 0);
    atmosphere.heat = heat;
    atmosphere.smog = smog;
    atmosphere.emberStorm = emberStorm;
    atmosphere.fogDensity = BASE_FOG_DENSITY + smog * 0.022 + heat * 0.018;
    if (nearestIndex >= 0) {
      atmosphere.glowX = cellX(nearestIndex);
      atmosphere.glowY = cellGround[nearestIndex] + Math.max(3, flameHeight[nearestIndex] * 0.45);
      atmosphere.glowZ = cellZ(nearestIndex);
      atmosphere.glowStrength = (0.8 + heat * 4.8) * (crownMask[nearestIndex] ? 1.35 : 1);
    } else {
      atmosphere.glowStrength *= 0.85;
    }

    const flameBoost = 1 + THREE.MathUtils.clamp(1 - nearestDist / 22, 0, 1) * 0.55;
    for (const index of activeCells) {
      const x = cellX(index);
      const z = cellZ(index);
      const ground = cellGround[index];
      const phase = elapsed * (crownMask[index] ? 9.5 : 7.1) + index * 0.73;
      const flicker = 0.88 + Math.sin(phase) * 0.075 + Math.sin(phase * 2.31) * 0.035;
      const close = Math.hypot(x - camera.position.x, z - camera.position.z) < 26 ? flameBoost : 1;
      const height = flameHeight[index] * flicker * burnLifeFactor(index) * close;
      const grass = fuels[index] === GRASS;
      const width = CELL_SIZE * (grass ? 1.42 : 1.22);
      const coreWidth = CELL_SIZE * (grass ? 0.98 : 0.68);
      setFlameMatrix(outerFlames, index, x, z, ground, width, height, Math.sin(phase * 0.6) * 0.1, camera);
      setFlameMatrix(innerFlames, index, x, z, ground + height * 0.015, coreWidth, height * 0.57, -Math.sin(phase) * 0.14, camera);
    }
    outerFlames.instanceMatrix.needsUpdate = true;
    innerFlames.instanceMatrix.needsUpdate = true;

    updatePyrocumulus(elapsed, camera);
    updateSmogWall(elapsed, camera, smog, frontX);
    spawnAmbientAsh(camera, ashParticles.length < 240 ? 48 : ashParticles.length < ASH_CAPACITY * 0.78 ? 16 : 2);
    spawnEmberBlizzard(camera, emberStorm, dt);
    updateWaterParticles(dt);
    updateImpactParticles(dt);
    updateParticleList(emberParticles, dt, emberPositions, emberColors, (targetIndex) => {
      ignite(targetIndex);
    });
    updateVisualParticles(ashParticles, dt, ashPositions, ashColors, ashGeometry, 'ash');
    updateVisualParticles(blizzardParticles, dt, blizzardPositions, blizzardColors, blizzardGeometry, 'blizzard');

    statsClock += dt;
    if (statsClock >= 0.55) {
      statsClock = 0;
      if (statsDirty) maybePublishStats(true);
    }
    return atmosphere;
  };

  // Begin as one continuous west-edge fireline, then slowly advance east.
  for (let row = 0; row < GRID_SIZE; row++) {
    ignite(row * GRID_SIZE);
  }
  options.onStats?.(getStats());

  const setWind = (directionDegrees: number, speedMph: number) => {
    windDirection = THREE.MathUtils.euclideanModulo(Number(directionDegrees) || 0, 360);
    windSpeed = THREE.MathUtils.clamp(Number(speedMph) || 0, 0, 35);
  };

  return {
    setWind,
    update,
    digAt,
    endTrench: () => { lastDig = null; },
    sprayWater,
    getStats,
    dispose: () => {
      plane.dispose();
      flameTexture.dispose();
      flameMaterial.dispose();
      innerFlameMaterial.dispose();
      dirtGeometry.dispose();
      dirtMaterial.dispose();
      smokeTexture.dispose();
      smogTexture.dispose();
      emberTexture.dispose();
      ashTexture.dispose();
      emberGeometry.dispose();
      waterGeometry.dispose();
      waterTexture.dispose();
      waterMaterial.dispose();
      impactGeometry.dispose();
      impactMaterial.dispose();
      ashGeometry.dispose();
      blizzardGeometry.dispose();
      trailGeometry.dispose();
      trailMaterial.dispose();
      pyroMaterial.dispose();
      smogMaterial.dispose();
      emberMaterial.dispose();
      ashMaterial.dispose();
      blizzardMaterial.dispose();
    },
  };
}

function makeParticleGeometry(THREE: any, positions: Float32Array, colors: Float32Array) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  return geometry;
}

function createFlameTexture(THREE: any) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 192;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the fire texture.');
  const glow = context.createRadialGradient(64, 140, 8, 64, 132, 90);
  glow.addColorStop(0, 'rgba(255,244,180,0.95)');
  glow.addColorStop(0.25, 'rgba(255,169,49,0.95)');
  glow.addColorStop(0.62, 'rgba(255,67,14,0.75)');
  glow.addColorStop(1, 'rgba(125,20,4,0)');
  context.fillStyle = glow;
  context.beginPath();
  context.moveTo(64, 190);
  context.bezierCurveTo(19, 172, 35, 133, 42, 111);
  context.bezierCurveTo(24, 82, 57, 56, 62, 8);
  context.bezierCurveTo(83, 46, 92, 63, 82, 94);
  context.bezierCurveTo(109, 77, 109, 126, 108, 144);
  context.bezierCurveTo(109, 169, 89, 184, 64, 190);
  context.fill();
  const core = context.createLinearGradient(0, 190, 0, 93);
  core.addColorStop(0, 'rgba(255,255,212,0.88)');
  core.addColorStop(0.55, 'rgba(255,224,101,0.55)');
  core.addColorStop(1, 'rgba(255,170,40,0)');
  context.fillStyle = core;
  context.beginPath();
  context.moveTo(65, 187);
  context.bezierCurveTo(49, 167, 56, 145, 61, 125);
  context.bezierCurveTo(77, 146, 84, 161, 74, 185);
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createParticleTexture(THREE: any, kind: 'smoke' | 'ember' | 'ash' | 'smog' | 'water') {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a particle texture.');
  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  if (kind === 'smoke') {
    gradient.addColorStop(0, 'rgba(38,32,26,0.7)');
    gradient.addColorStop(0.42, 'rgba(52,44,36,0.38)');
    gradient.addColorStop(1, 'rgba(40,34,28,0)');
  } else if (kind === 'smog') {
    gradient.addColorStop(0, 'rgba(72,56,40,0.72)');
    gradient.addColorStop(0.45, 'rgba(58,46,34,0.4)');
    gradient.addColorStop(1, 'rgba(42,34,26,0)');
  } else if (kind === 'ash') {
    gradient.addColorStop(0, 'rgba(210,198,176,0.9)');
    gradient.addColorStop(0.35, 'rgba(160,148,128,0.45)');
    gradient.addColorStop(1, 'rgba(90,80,68,0)');
  } else if (kind === 'water') {
    gradient.addColorStop(0, 'rgba(220,245,255,1)');
    gradient.addColorStop(0.28, 'rgba(122,214,255,0.85)');
    gradient.addColorStop(1, 'rgba(118,200,245,0)');
  } else {
    gradient.addColorStop(0, 'rgba(255,255,202,1)');
    gradient.addColorStop(0.28, 'rgba(255,179,59,0.95)');
    gradient.addColorStop(1, 'rgba(255,63,10,0)');
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
