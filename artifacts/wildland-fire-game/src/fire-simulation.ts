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
};

type FireStats = {
  burningCells: number;
  burnedCells: number;
  crownFireCells: number;
  firebreakCells: number;
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
};

export type FireSimulation = {
  setWind: (directionDegrees: number, speedMph: number) => void;
  update: (dt: number, elapsed: number, camera: any) => void;
  digAt: (x: number, z: number) => void;
  endTrench: () => void;
  getStats: () => FireStats;
  dispose: () => void;
};

const GRID_SIZE = 64;
const CELL_SIZE = 2.5;
const GRID_ORIGIN = -80;
const CELL_COUNT = GRID_SIZE * GRID_SIZE;

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
 * instanced billboards and bounded point-particle buffers provide the visuals.
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
  const burnSlot = new Int32Array(CELL_COUNT);
  burnSlot.fill(-1);
  const activeCells: number[] = [];
  let lastDig: { x: number; z: number } | null = null;

  let windDirection = 45;
  let windSpeed = 15;
  let burningCount = 0;
  let burnedCount = 0;
  let crownCount = 0;
  let firebreakCount = 0;
  let statsClock = 0;
  let statsDirty = true;

  const cellIndex = (x: number, z: number) => {
    const column = Math.floor((x - GRID_ORIGIN) / CELL_SIZE);
    const row = Math.floor((z - GRID_ORIGIN) / CELL_SIZE);
    if (column < 0 || column >= GRID_SIZE || row < 0 || row >= GRID_SIZE) return -1;
    return row * GRID_SIZE + column;
  };
  const cellX = (index: number) => GRID_ORIGIN + (index % GRID_SIZE + 0.5) * CELL_SIZE;
  const cellZ = (index: number) => GRID_ORIGIN + (Math.floor(index / GRID_SIZE) + 0.5) * CELL_SIZE;
  const columnOf = (index: number) => index % GRID_SIZE;
  const rowOf = (index: number) => Math.floor(index / GRID_SIZE);

  // Most open ground has patchy grass; real tree and brush locations override it.
  for (let i = 0; i < CELL_COUNT; i++) fuels[i] = random() < 0.61 ? GRASS : NO_FUEL;

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
        if (dx * dx + dz * dz <= radius * radius && fuels[index] < fuel) fuels[index] = fuel;
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
  dummy.scale.set(0, 0, 0);
  dummy.updateMatrix();
  for (let i = 0; i < CELL_COUNT; i++) {
    outerFlames.setMatrixAt(i, dummy.matrix);
    innerFlames.setMatrixAt(i, dummy.matrix);
  }
  scene.add(outerFlames, innerFlames);
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
  const emberTexture = createParticleTexture(THREE, 'ember');
  const smokeCapacity = 1500;
  const emberCapacity = 1800;
  const smokePositions = new Float32Array(smokeCapacity * 3);
  const smokeColors = new Float32Array(smokeCapacity * 3);
  const emberPositions = new Float32Array(emberCapacity * 3);
  const emberColors = new Float32Array(emberCapacity * 3);
  const smokeGeometry = makeParticleGeometry(THREE, smokePositions, smokeColors);
  const emberGeometry = makeParticleGeometry(THREE, emberPositions, emberColors);
  const smokeMaterial = new THREE.PointsMaterial({
    map: smokeTexture,
    size: 2.6,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const emberMaterial = new THREE.PointsMaterial({
    map: emberTexture,
    size: 1.55,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const smokePoints = new THREE.Points(smokeGeometry, smokeMaterial);
  const emberPoints = new THREE.Points(emberGeometry, emberMaterial);
  smokePoints.frustumCulled = false;
  emberPoints.frustumCulled = false;
  scene.add(smokePoints, emberPoints);
  const smokeParticles: Particle[] = [];
  const emberParticles: Particle[] = [];
  let smokeCursor = 0;
  let emberCursor = 0;

  const hideFlame = (index: number) => {
    outerFlames.setMatrixAt(index, dummy.matrix);
    innerFlames.setMatrixAt(index, dummy.matrix);
    outerFlames.instanceMatrix.needsUpdate = true;
    innerFlames.instanceMatrix.needsUpdate = true;
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
    const ground = terrainHeight(x, z);
    const wind = windVector();
    const strength = windSpeed / 35;
    const smokeCount = initial ? (type === GRASS ? 2 : 4) : (type === GRASS ? 1 : 2);
    const emberCount = initial ? (type === TREE ? 7 : 4) : (type === TREE ? 3 : 2);
    for (let i = 0; i < smokeCount; i++) {
      const p: Particle = {
        x: x + (random() - 0.5) * CELL_SIZE * 0.55,
        y: ground + 0.35 + random() * Math.max(0.5, flameHeight[index] * 0.28),
        z: z + (random() - 0.5) * CELL_SIZE * 0.55,
        vx: wind.x * (0.16 + strength * 0.8) + (random() - 0.5) * 0.25,
        vy: 0.55 + random() * 0.8 + (crownMask[index] ? 0.42 : 0),
        vz: wind.z * (0.16 + strength * 0.8) + (random() - 0.5) * 0.25,
        age: 0,
        life: 4.5 + random() * 4.5,
      };
      smokeCursor = addParticle(smokeParticles, smokeCapacity, smokeCursor, p);
    }
    for (let i = 0; i < emberCount; i++) {
      const p: Particle = {
        x: x + (random() - 0.5) * CELL_SIZE * 0.45,
        y: ground + 0.4 + random() * Math.max(0.3, flameHeight[index] * 0.22),
        z: z + (random() - 0.5) * CELL_SIZE * 0.45,
        vx: wind.x * (0.2 + strength * 1.8) + (random() - 0.5) * 0.9,
        vy: 0.7 + random() * 2.1 + (crownMask[index] ? 1.2 : 0),
        vz: wind.z * (0.2 + strength * 1.8) + (random() - 0.5) * 0.9,
        age: 0,
        life: 1.3 + random() * 2.6,
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

  const ignite = (index: number) => {
    if (index < 0 || states[index] !== UNBURNED || fuels[index] === NO_FUEL) return false;
    const type = fuels[index];
    const dense = countDenseNeighbors(index) >= 3;
    const crown = windSpeed >= 22 && type >= BRUSH && dense;
    const nearbyTreeHeight = trees.find(
      (tree) => Math.hypot(tree.x - cellX(index), tree.z - cellZ(index)) < 2,
    )?.height ?? 7.8;
    states[index] = BURNING;
    crownMask[index] = crown ? 1 : 0;
    age[index] = 0;
    spreadClock[index] = 0.28 + random() * 0.38;
    emissionClock[index] = 0;
    let duration = type === GRASS ? 2.2 + random() * 1.8
      : type === BRUSH ? 6 + random() * 4.5
      : 10 + random() * 7;
    if (crown) duration *= 1.28;
    burnDuration[index] = duration;
    flameHeight[index] = type === GRASS
      ? 0.48 + windSpeed / 35 * 0.72
      : crown
        ? Math.max(10.2, nearbyTreeHeight * 1.3) + random() * 1.8
        : type === BRUSH
          ? 1.9 + windSpeed / 35 * 1.35
          : nearbyTreeHeight + windSpeed / 35 * 1.25;
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
    setFlameMatrix(outerFlames, index, x, z, terrainHeight(x, z), flameHeight[index] * 0.58, flameHeight[index], 0);
    setFlameMatrix(innerFlames, index, x, z, terrainHeight(x, z), flameHeight[index] * 0.27, flameHeight[index] * 0.58, 0.02);
    emitForCell(index, true);
    statsDirty = true;
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
    statsDirty = true;
  };

  const addDirtPatch = (index: number) => {
    if (dirtCount >= CELL_COUNT) return;
    const x = cellX(index);
    const z = cellZ(index);
    dummy.position.set(x, terrainHeight(x, z) + 0.035, z);
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

  const digAt = (x: number, z: number) => {
    if (Math.abs(x - GRID_ORIGIN) > GRID_SIZE * CELL_SIZE || Math.abs(z - GRID_ORIGIN) > GRID_SIZE * CELL_SIZE) return;
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

  const updateParticleList = (
    particles: Particle[],
    dt: number,
    positions: Float32Array,
    colors: Float32Array,
    kind: 'smoke' | 'ember',
  ) => {
    const wind = windVector();
    const windStrength = windSpeed / 35;
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      particle.age += dt;
      if (particle.age >= particle.life) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
        continue;
      }
      const fade = 1 - particle.age / particle.life;
      particle.vx += wind.x * windStrength * (kind === 'smoke' ? 0.26 : 0.68) * dt;
      particle.vz += wind.z * windStrength * (kind === 'smoke' ? 0.26 : 0.68) * dt;
      particle.vx *= kind === 'smoke' ? 0.995 : 0.986;
      particle.vz *= kind === 'smoke' ? 0.995 : 0.986;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      const offset = i * 3;
      positions[offset] = particle.x;
      positions[offset + 1] = particle.y;
      positions[offset + 2] = particle.z;
      if (kind === 'smoke') {
        const shade = 0.18 + fade * 0.3;
        colors[offset] = shade * 0.86;
        colors[offset + 1] = shade * 0.88;
        colors[offset + 2] = shade * 0.82;
      } else {
        colors[offset] = 1;
        colors[offset + 1] = (0.22 + fade * 0.62);
        colors[offset + 2] = 0.035 + fade * 0.12;
      }
    }
    const geometry = kind === 'smoke' ? smokeGeometry : emberGeometry;
    geometry.setDrawRange(0, particles.length);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  };

  const attemptSpread = (sourceIndex: number) => {
    const column = columnOf(sourceIndex);
    const row = rowOf(sourceIndex);
    const sourceFuel = fuels[sourceIndex];
    const wind = windVector();
    const windStrength = windSpeed / 35;
    const directions = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],             [1, 0],
      [-1, 1],  [0, 1],   [1, 1],
    ];
    const sourceHeight = terrainHeight(cellX(sourceIndex), cellZ(sourceIndex));
    for (const [dx, dz] of directions) {
      const nextColumn = column + dx;
      const nextRow = row + dz;
      if (nextColumn < 0 || nextColumn >= GRID_SIZE || nextRow < 0 || nextRow >= GRID_SIZE) continue;
      const next = nextRow * GRID_SIZE + nextColumn;
      const targetFuel = fuels[next];
      if (states[next] !== UNBURNED || targetFuel === NO_FUEL) continue;
      const length = Math.hypot(dx, dz);
      const alignment = (dx / length) * wind.x + (dz / length) * wind.z;
      const directional = alignment >= 0
        ? 1 + alignment * windStrength * 2.75
        : Math.max(0.08, 1 + alignment * windStrength * 0.9);
      const baseProbability = targetFuel === GRASS ? 0.15 : targetFuel === BRUSH ? 0.082 : 0.054;
      const slope = (terrainHeight(cellX(next), cellZ(next)) - sourceHeight) / CELL_SIZE;
      const slopeFactor = Math.max(0.65, Math.min(1.48, 1 + slope * 0.5));
      const crownFactor = crownMask[sourceIndex] ? 1.65 : 1;
      const windFactor = 0.75 + windStrength * 1.25;
      const diagonalPenalty = length > 1 ? 0.76 : 1;
      const probability = Math.min(
        0.92,
        baseProbability * directional * slopeFactor * crownFactor * windFactor * diagonalPenalty,
      );
      if (random() < probability) ignite(next);
    }

    // Strong winds can carry embers past one neighboring fuel cell.
    if (windSpeed >= 24 && random() < windStrength * 0.22) {
      const jump = 2 + (windSpeed >= 31 ? 1 : 0);
      const columnStep = Math.round(wind.x * jump);
      const rowStep = Math.round(wind.z * jump);
      if (columnStep || rowStep) {
        const targetColumn = column + columnStep;
        const targetRow = row + rowStep;
        if (targetColumn >= 0 && targetColumn < GRID_SIZE && targetRow >= 0 && targetRow < GRID_SIZE) {
          const target = targetRow * GRID_SIZE + targetColumn;
          if (fuels[target] !== NO_FUEL && states[target] === UNBURNED) ignite(target);
        }
      }
    }
  };

  const update = (dt: number, elapsed: number, camera: any) => {
    const turnCount = activeCells.length;
    for (let slot = turnCount - 1; slot >= 0; slot--) {
      const index = activeCells[slot];
      age[index] += dt;
      spreadClock[index] -= dt;
      emissionClock[index] += dt;
      if (emissionClock[index] > (crownMask[index] ? 0.16 : 0.29)) {
        emissionClock[index] = 0;
        emitForCell(index);
      }
      if (spreadClock[index] <= 0) {
        spreadClock[index] = 0.42 + random() * 0.34;
        attemptSpread(index);
      }
      if (age[index] >= burnDuration[index]) finishBurn(index);
    }

    // Billboard flames stay camera-facing; one instance per cell keeps draw calls low.
    for (const index of activeCells) {
      const x = cellX(index);
      const z = cellZ(index);
      const ground = terrainHeight(x, z);
      const phase = elapsed * (crownMask[index] ? 9.5 : 7.1) + index * 0.73;
      const flicker = 0.88 + Math.sin(phase) * 0.075 + Math.sin(phase * 2.31) * 0.035;
      const height = flameHeight[index] * flicker;
      setFlameMatrix(outerFlames, index, x, z, ground, height * 0.56, height, Math.sin(phase * 0.6) * 0.1, camera);
      setFlameMatrix(innerFlames, index, x, z, ground + height * 0.015, height * 0.25, height * 0.57, -Math.sin(phase) * 0.14, camera);
    }
    outerFlames.instanceMatrix.needsUpdate = true;
    innerFlames.instanceMatrix.needsUpdate = true;

    updateParticleList(smokeParticles, dt, smokePositions, smokeColors, 'smoke');
    updateParticleList(emberParticles, dt, emberPositions, emberColors, 'ember');

    statsClock += dt;
    if (statsClock >= 0.55) {
      statsClock = 0;
      if (statsDirty) maybePublishStats(true);
    }
  };

  // The map edge is the first fireline; subsequent generations advance inward.
  for (let column = 0; column < GRID_SIZE; column++) {
    for (const row of [0, GRID_SIZE - 1]) {
      const index = row * GRID_SIZE + column;
      if (fuels[index] === NO_FUEL) fuels[index] = GRASS;
      ignite(index);
    }
  }
  for (let row = 1; row < GRID_SIZE - 1; row++) {
    for (const column of [0, GRID_SIZE - 1]) {
      const index = row * GRID_SIZE + column;
      if (fuels[index] === NO_FUEL) fuels[index] = GRASS;
      ignite(index);
    }
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
    getStats,
    dispose: () => {
      plane.dispose();
      flameTexture.dispose();
      flameMaterial.dispose();
      innerFlameMaterial.dispose();
      dirtGeometry.dispose();
      dirtMaterial.dispose();
      smokeTexture.dispose();
      emberTexture.dispose();
      smokeGeometry.dispose();
      emberGeometry.dispose();
      smokeMaterial.dispose();
      emberMaterial.dispose();
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

function createParticleTexture(THREE: any, kind: 'smoke' | 'ember') {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a particle texture.');
  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  if (kind === 'smoke') {
    gradient.addColorStop(0, 'rgba(45,42,36,0.64)');
    gradient.addColorStop(0.48, 'rgba(47,44,39,0.4)');
    gradient.addColorStop(1, 'rgba(50,47,42,0)');
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
