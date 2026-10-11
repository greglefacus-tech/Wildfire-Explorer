type FuelPoint = { x: number; z: number; height?: number; id?: number };
type FuelKind = 'grass' | 'brush' | 'tree' | 'front';
type FuelState = 'fuel' | 'burning' | 'burned' | 'cut';
type FuelNode = FuelPoint & {
  kind: FuelKind;
  state: FuelState;
  progress: number;
  ignition: number;
  wetness: number;
  duration: number;
  age: number;
  height: number;
  crown: boolean;
  climb: number;
  emberClock: number;
};
type WaterParticle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number };
type FireStats = { burningCells: number; burnedCells: number; crownFireCells: number; firebreakCells: number };
type FireSystemOptions = {
  THREE: any;
  scene: any;
  terrainHeight: (x: number, z: number) => number;
  random: () => number;
  trees: FuelPoint[];
  bushes: FuelPoint[];
  grassPatches: FuelPoint[];
  onStats?: (stats: FireStats) => void;
  onDig?: (x: number, z: number, radius: number) => void;
  onFuelBurned?: (kind: FuelKind, id: number | undefined, x: number, z: number) => void;
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

const MAP_LIMIT = 148;
const SPREAD_RANGE = 16;
const MAX_WATER_PARTICLES = 1600;
const FIRE_RIBBONS_PER_NODE = 3;

export function createFireSimulation(options: FireSystemOptions): FireSimulation {
  const { THREE, scene, terrainHeight, random } = options;
  const nodes: FuelNode[] = [];
  const active: FuelNode[] = [];
  const water: WaterParticle[] = [];
  const dirtPositions: number[] = [];
  const breaks: { x: number; z: number; radius: number }[] = [];
  let windDirection = 90;
  let windSpeed = 15;
  let lastDig: { x: number; z: number } | null = null;
  let statsClock = 0;
  let spreadClock = 0;
  let statsDirty = true;
  let burnedCount = 0;
  let firebreakCount = 0;
  let burningCount = 0;
  let crownCount = 0;

  const makeFuel = (point: FuelPoint, kind: FuelKind) => {
    nodes.push({
      ...point,
      kind,
      state: 'fuel',
      progress: 0,
      ignition: 0,
      wetness: 0,
      duration: 0,
      age: 0,
      height: point.height ?? (kind === 'tree' ? 8 : kind === 'brush' ? 3 : 1.6),
      crown: false,
      climb: 0,
      emberClock: random() * 0.8,
    });
  };
  options.grassPatches.forEach((point) => makeFuel(point, 'grass'));
  options.bushes.forEach((point) => makeFuel(point, 'brush'));
  options.trees.forEach((point) => makeFuel(point, 'tree'));

  const MAX_FIRE_QUADS = Math.max(8192, (options.grassPatches.length + options.bushes.length + options.trees.length + 112) * 10);
  const firePositions = new Float32Array(MAX_FIRE_QUADS * 4 * 3);
  const fireUvs = new Float32Array(MAX_FIRE_QUADS * 4 * 2);
  const fireSeeds = new Float32Array(MAX_FIRE_QUADS * 4);
  const fireIndices = new Uint32Array(MAX_FIRE_QUADS * 6);
  const firePositionAttribute = new THREE.BufferAttribute(firePositions, 3).setUsage(THREE.DynamicDrawUsage);
  const fireUvAttribute = new THREE.BufferAttribute(fireUvs, 2).setUsage(THREE.DynamicDrawUsage);
  const fireSeedAttribute = new THREE.BufferAttribute(fireSeeds, 1).setUsage(THREE.DynamicDrawUsage);
  const fireIndexAttribute = new THREE.BufferAttribute(fireIndices, 1).setUsage(THREE.DynamicDrawUsage);
  const fireGeometry = new THREE.BufferGeometry();
  fireGeometry.setAttribute('position', firePositionAttribute);
  fireGeometry.setAttribute('uv', fireUvAttribute);
  fireGeometry.setAttribute('aSeed', fireSeedAttribute);
  fireGeometry.setIndex(fireIndexAttribute);
  fireGeometry.setDrawRange(0, 0);
  const fireMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2() },
      uWindLean: { value: 0 },
    },
    vertexShader: `
      uniform float uTime;
      uniform vec2 uWind;
      uniform float uWindLean;
      attribute float aSeed;
      varying vec2 vUv;
      varying float vSeed;
      varying float vTurbulence;
      void main() {
        vUv = uv;
        vSeed = aSeed;
        vec3 displaced = position;
        float rise = uv.y;
        float turbulence = sin(uv.x * 17.0 + uTime * 3.5 + aSeed * 31.0 + rise * 8.0);
        float lick = sin(uv.x * 9.0 - uTime * 2.6 + aSeed * 19.0);
        displaced.x += uWind.x * rise * rise * uWindLean + turbulence * 0.07 * rise;
        displaced.z += uWind.y * rise * rise * uWindLean + lick * 0.07 * rise;
        displaced.y += turbulence * 0.08 * rise + lick * 0.035 * rise;
        vTurbulence = turbulence * 0.5 + lick * 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;
      varying float vSeed;
      varying float vTurbulence;
      void main() {
        float rise = vUv.y;
        float horizontal = abs(vUv.x - 0.5) * 2.0;
        float lobe = 0.34 + 0.46 * (0.5 + 0.5 * sin(vUv.x * 18.0 + vSeed * 27.0 + uTime * 4.0));
        float width = mix(0.49, 0.035, rise) * (0.7 + lobe * 0.3) + vTurbulence * 0.025;
        float flameSilhouette = 1.0 - smoothstep(width - 0.035, width + 0.035, horizontal);
        float connector = step(0.5, -vSeed);
        float silhouette = mix(flameSilhouette, 1.0, connector);
        float baseFade = smoothstep(0.0, 0.065, rise);
        float tipFade = 1.0 - smoothstep(0.9, 1.0, rise) * 0.35;
        float flicker = 0.78 + 0.22 * sin(uTime * 13.0 + vSeed * 41.0 + rise * 19.0 + vTurbulence * 2.5);
        float core = 1.0 - smoothstep(0.0, 0.78, rise);
        core *= 1.0 - connector * 0.82;
        vec3 color = mix(vec3(1.0, 0.1, 0.008), vec3(1.0, 0.42, 0.035), core);
        color = mix(color, vec3(1.0, 0.78, 0.32), core * core * 0.3);
        gl_FragColor = vec4(color, silhouette * baseFade * tipFade * flicker * mix(0.46, 0.34, connector));
      }
    `,
  });
  const fireMesh = new THREE.Mesh(fireGeometry, fireMaterial);
  fireMesh.frustumCulled = false;
  fireMesh.renderOrder = 2;
  scene.add(fireMesh);

  const waterGeometry = new THREE.BufferGeometry();
  const waterPositions = new Float32Array(MAX_WATER_PARTICLES * 3);
  const waterColors = new Float32Array(MAX_WATER_PARTICLES * 3);
  waterGeometry.setAttribute('position', new THREE.BufferAttribute(waterPositions, 3).setUsage(THREE.DynamicDrawUsage));
  waterGeometry.setAttribute('color', new THREE.BufferAttribute(waterColors, 3).setUsage(THREE.DynamicDrawUsage));
  waterGeometry.setDrawRange(0, 0);
  const waterTexture = makeSpriteTexture(THREE, 'water');
  const waterMaterial = new THREE.PointsMaterial({
    map: waterTexture,
    size: 0.3,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const waterPoints = new THREE.Points(waterGeometry, waterMaterial);
  waterPoints.frustumCulled = false;
  scene.add(waterPoints);

  const steamGeometry = new THREE.BufferGeometry();
  const steamPositions = new Float32Array(900 * 3);
  const steamColors = new Float32Array(900 * 3);
  steamGeometry.setAttribute('position', new THREE.BufferAttribute(steamPositions, 3).setUsage(THREE.DynamicDrawUsage));
  steamGeometry.setAttribute('color', new THREE.BufferAttribute(steamColors, 3).setUsage(THREE.DynamicDrawUsage));
  steamGeometry.setDrawRange(0, 0);
  const steamTexture = makeSpriteTexture(THREE, 'steam');
  const steamMaterial = new THREE.PointsMaterial({
    map: steamTexture,
    size: 0.75,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const steamPoints = new THREE.Points(steamGeometry, steamMaterial);
  steamPoints.frustumCulled = false;
  scene.add(steamPoints);
  const steam: WaterParticle[] = [];

  const dirtGeometry = new THREE.BufferGeometry();
  const dirtMaterial = new THREE.PointsMaterial({ color: '#70533a', size: 2.5, sizeAttenuation: true, depthWrite: false });
  const dirtPoints = new THREE.Points(dirtGeometry, dirtMaterial);
  dirtPoints.frustumCulled = false;
  scene.add(dirtPoints);
  const atmosphere: AtmosphereState = {
    heat: 0, smog: 0, emberStorm: 0, fogDensity: 0.016,
    glowX: 0, glowY: 8, glowZ: 0, glowStrength: 0,
  };

  const windVector = () => {
    const radians = windDirection * Math.PI / 180;
    return { x: Math.sin(radians), z: -Math.cos(radians) };
  };
  const pointIsCut = (x: number, z: number) => breaks.some((cut) => Math.hypot(cut.x - x, cut.z - z) <= cut.radius);
  const heatAt = (x: number, z: number) => {
    let heat = 0;
    for (const source of active) {
      const distance = Math.hypot(source.x - x, source.z - z);
      if (distance > SPREAD_RANGE) continue;
      const intensity = source.crown ? 4.5 : source.kind === 'tree' ? 1.5 + source.climb : source.kind === 'brush' ? 1.1 : 0.55;
      heat += intensity * (1 - distance / SPREAD_RANGE) * (1 - source.progress * 0.35);
    }
    return Math.min(12, heat);
  };
  const getStats = (): FireStats => ({ burningCells: burningCount, burnedCells: burnedCount, crownFireCells: crownCount, firebreakCells: firebreakCount });
  const publishStats = (force = false) => {
    if (!force && !statsDirty) return;
    options.onStats?.(getStats());
    statsDirty = false;
  };
  const ignite = (node: FuelNode) => {
    if (node.state !== 'fuel' || pointIsCut(node.x, node.z)) return false;
    if (node.wetness > 0.2 && heatAt(node.x, node.z) < 1.6) return false;
    node.state = 'burning';
    node.age = 0;
    node.progress = 0;
    node.duration = node.kind === 'tree' ? 22 + random() * 8 : node.kind === 'brush' ? 15 + random() * 6 : 11 + random() * 5;
    node.crown = false;
    node.climb = 0;
    active.push(node);
    burningCount++;
    statsDirty = true;
    return true;
  };
  const finishBurn = (node: FuelNode) => {
    node.state = 'burned';
    node.progress = 1;
    node.ignition = 0;
    burnedCount++;
    burningCount = Math.max(0, burningCount - 1);
    if (node.crown) crownCount = Math.max(0, crownCount - 1);
    const slot = active.indexOf(node);
    if (slot >= 0) active.splice(slot, 1);
    if (node.kind !== 'front') options.onFuelBurned?.(node.kind, node.id, node.x, node.z);
    statsDirty = true;
  };
  const spawnSteam = (x: number, y: number, z: number, amount = 8) => {
    for (let index = 0; index < amount && steam.length < 300; index++) {
      steam.push({
        x: x + (random() - 0.5) * 0.7,
        y: y + random() * 0.35,
        z: z + (random() - 0.5) * 0.7,
        vx: (random() - 0.5) * 0.8,
        vy: 1.2 + random() * 1.4,
        vz: (random() - 0.5) * 0.8,
        age: 0,
        life: 0.5 + random() * 0.55,
      });
    }
  };
  const impactWater = (x: number, y: number, z: number) => {
    const heat = heatAt(x, z);
    if (heat >= 1.9) {
      spawnSteam(x, y, z, 10 + Math.min(18, Math.ceil(heat * 1.2)));
      return;
    }
    for (const node of nodes) {
      const distance = Math.hypot(node.x - x, node.z - z);
      if (distance > 1.8 || node.state === 'burned' || node.state === 'cut') continue;
      node.wetness = Math.min(5, node.wetness + 1.8 * (1 - distance / 2.2));
      if (node.state === 'burning') node.age = Math.max(0, node.age - 0.25);
    }
    spawnSteam(x, y, z, 3);
  };

  const fireSeedCount = 112;
  for (let index = 0; index < fireSeedCount; index++) {
    const z = -138 + index * (276 / (fireSeedCount - 1));
    const seed: FuelNode = {
      x: -138, z, kind: 'front', state: 'fuel', progress: 0, ignition: 0, wetness: 0,
      duration: 900, age: 0, height: 1.6, crown: false, climb: 0, emberClock: 0,
    };
    nodes.push(seed);
    ignite(seed);
  }

  let fireQuadCount = 0;
  let fireRenderClock = 0;
  const appendFireQuad = (
    bottomA: { x: number; y: number; z: number },
    bottomB: { x: number; y: number; z: number },
    topB: { x: number; y: number; z: number },
    topA: { x: number; y: number; z: number },
    seed: number,
  ) => {
    if (fireQuadCount >= MAX_FIRE_QUADS) return;
    const firstVertex = fireQuadCount * 4;
    const corners = [bottomA, bottomB, topB, topA];
    for (let corner = 0; corner < 4; corner++) {
      const vertex = firstVertex + corner;
      const offset = vertex * 3;
      firePositions[offset] = corners[corner].x;
      firePositions[offset + 1] = corners[corner].y;
      firePositions[offset + 2] = corners[corner].z;
      fireUvs[vertex * 2] = corner === 0 || corner === 3 ? 0 : 1;
      fireUvs[vertex * 2 + 1] = corner < 2 ? 0 : 1;
      fireSeeds[vertex] = seed;
    }
    const index = fireQuadCount * 6;
    fireIndices[index] = firstVertex;
    fireIndices[index + 1] = firstVertex + 1;
    fireIndices[index + 2] = firstVertex + 2;
    fireIndices[index + 3] = firstVertex;
    fireIndices[index + 4] = firstVertex + 2;
    fireIndices[index + 5] = firstVertex + 3;
    fireQuadCount++;
  };

  const rebuildFireMesh = (elapsed: number) => {
    fireQuadCount = 0;
    const wind = windVector();
    const widths = { front: 2.5, grass: 1.2, brush: 1.05, tree: 0.42 };
    const heights = (node: FuelNode) => node.crown
      ? Math.max(10, node.height * 1.6)
      : node.kind === 'tree'
        ? Math.max(1.2, 1.2 + node.height * node.climb)
        : node.kind === 'front' ? 7.2 : node.kind === 'brush' ? 3.3 : 1.65;
    const centers = active.map((node) => ({
      node,
      ground: terrainHeight(node.x, node.z),
      height: heights(node),
    }));

    for (let index = 0; index < centers.length; index++) {
      const { node, ground, height } = centers[index];
      const halfWidth = widths[node.kind] * (node.crown ? 2.2 : 1);
      const lean = (windSpeed / 35) * height * 0.34;
      for (let ribbon = 0; ribbon < FIRE_RIBBONS_PER_NODE; ribbon++) {
        const angle = ribbon * Math.PI / FIRE_RIBBONS_PER_NODE + Math.sin(elapsed * 0.3 + node.x + node.z) * 0.08;
        const sideX = Math.cos(angle) * halfWidth;
        const sideZ = Math.sin(angle) * halfWidth;
        const topX = node.x + wind.x * lean;
        const topZ = node.z + wind.z * lean;
        appendFireQuad(
          { x: node.x - sideX, y: ground, z: node.z - sideZ },
          { x: node.x + sideX, y: ground, z: node.z + sideZ },
          { x: topX + sideX * 0.045, y: ground + height, z: topZ + sideZ * 0.045 },
          { x: topX - sideX * 0.045, y: ground + height, z: topZ - sideZ * 0.045 },
          index * 0.173 + node.age * 0.07,
        );
      }
    }

    const bucketSize = 5.5;
    const buckets = new Map<string, number[]>();
    for (let index = 0; index < centers.length; index++) {
      const node = centers[index].node;
      const key = `${Math.floor(node.x / bucketSize)},${Math.floor(node.z / bucketSize)}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(index);
      buckets.set(key, bucket);
    }
    for (let index = 0; index < centers.length; index++) {
      const a = centers[index];
      const bucketX = Math.floor(a.node.x / bucketSize);
      const bucketZ = Math.floor(a.node.z / bucketSize);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = buckets.get(`${bucketX + dx},${bucketZ + dz}`);
          if (!bucket) continue;
          for (const otherIndex of bucket) {
            if (otherIndex <= index) continue;
            const b = centers[otherIndex];
            const distance = Math.hypot(b.node.x - a.node.x, b.node.z - a.node.z);
            if (distance < 0.25 || distance > 4.35) continue;
            const connectorHeight = Math.max(1.8, Math.min(a.height, b.height) * 0.42);
            const lean = (windSpeed / 35) * 0.22;
            appendFireQuad(
              { x: a.node.x, y: a.ground, z: a.node.z },
              { x: b.node.x, y: b.ground, z: b.node.z },
              { x: b.node.x + wind.x * connectorHeight * lean, y: b.ground + connectorHeight, z: b.node.z + wind.z * connectorHeight * lean },
              { x: a.node.x + wind.x * connectorHeight * lean, y: a.ground + connectorHeight, z: a.node.z + wind.z * connectorHeight * lean },
              -1,
            );
          }
        }
      }
    }

    const vertexCount = fireQuadCount * 4;
    fireGeometry.setDrawRange(0, fireQuadCount * 6);
    firePositionAttribute.clearUpdateRanges();
    firePositionAttribute.addUpdateRange(0, vertexCount * 3);
    firePositionAttribute.needsUpdate = true;
    fireUvAttribute.clearUpdateRanges();
    fireUvAttribute.addUpdateRange(0, vertexCount * 2);
    fireUvAttribute.needsUpdate = true;
    fireSeedAttribute.clearUpdateRanges();
    fireSeedAttribute.addUpdateRange(0, vertexCount);
    fireSeedAttribute.needsUpdate = true;
    fireIndexAttribute.clearUpdateRanges();
    fireIndexAttribute.addUpdateRange(0, fireQuadCount * 6);
    fireIndexAttribute.needsUpdate = true;
  };

  const updateParticles = (particles: WaterParticle[], positions: Float32Array, colors: Float32Array, geometry: any, dt: number, type: 'water' | 'steam') => {
    let count = 0;
    for (let index = particles.length - 1; index >= 0; index--) {
      const particle = particles[index];
      particle.age += dt;
      if (particle.age >= particle.life) {
        particles.splice(index, 1);
        continue;
      }
      particle.vy += (type === 'water' ? -9.8 * 0.42 : -0.4) * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      if (type === 'water' && particle.y <= terrainHeight(particle.x, particle.z) + 0.1) {
        impactWater(particle.x, particle.y, particle.z);
        particles.splice(index, 1);
        continue;
      }
      const offset = count * 3;
      positions[offset] = particle.x;
      positions[offset + 1] = particle.y;
      positions[offset + 2] = particle.z;
      const fade = 1 - particle.age / particle.life;
      colors[offset] = type === 'water' ? 0.7 : 0.75 + fade * 0.2;
      colors[offset + 1] = type === 'water' ? 0.88 : 0.8 + fade * 0.18;
      colors[offset + 2] = type === 'water' ? 1 : 0.76;
      count++;
    }
    geometry.setDrawRange(0, count);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  };

  const update = (dt: number, elapsed: number, camera: any) => {
    for (const node of nodes) node.wetness = Math.max(0, node.wetness - dt * 0.12);
    for (const node of active.slice()) {
      node.age += dt * (node.wetness > 0.2 && !node.crown ? 0.25 : 1);
      node.progress = Math.min(1, node.age / Math.max(1, node.duration));
      if (node.kind === 'tree' && !node.crown) {
        node.climb = Math.min(1, node.climb + dt / (6.5 / (1 + windSpeed / 100)));
        if (node.climb >= 1) {
          node.crown = true;
          node.duration += 22;
          crownCount++;
          statsDirty = true;
        }
      }
      node.emberClock -= dt;
      if (node.emberClock <= 0 && (node.kind === 'tree' || node.kind === 'brush' || node.crown)) {
        node.emberClock = node.crown ? 0.12 : 0.55;
        spawnSteam(node.x, terrainHeight(node.x, node.z) + Math.max(0.5, node.height * (node.crown ? 0.8 : node.climb * 0.6)), node.z, node.crown ? 2 : 1);
      }
      if (node.age >= node.duration) finishBurn(node);
    }

    spreadClock += dt;
    if (spreadClock >= 0.18) {
      const step = spreadClock;
      spreadClock = 0;
      const wind = windVector();
      for (const node of nodes) {
        if (node.state !== 'fuel' || node.kind === 'front' || node.wetness > 0.1 || pointIsCut(node.x, node.z)) continue;
        let vectorX = 0;
        let vectorZ = 0;
        let heat = 0;
        for (const source of active) {
          const dx = node.x - source.x;
          const dz = node.z - source.z;
          const distance = Math.hypot(dx, dz);
          if (distance < 0.01 || distance > SPREAD_RANGE) continue;
          const directionX = dx / distance;
          const directionZ = dz / distance;
          const upslope = (terrainHeight(node.x, node.z) - terrainHeight(source.x, source.z)) / distance;
          const align = directionX * wind.x + directionZ * wind.z;
          const windScale = THREE.MathUtils.clamp(1 + align * (windSpeed / 35) * 1.8, 0.12, 2.8);
          const slopeScale = Math.exp(THREE.MathUtils.clamp(upslope * 4.5, -1, 1.1));
          const sourceHeat = source.crown ? 4.5 : source.kind === 'tree' ? 1.3 + source.climb : source.kind === 'brush' ? 1 : 0.55;
          const contribution = sourceHeat * windScale * slopeScale * Math.exp(-distance / 7.5);
          vectorX += directionX * contribution;
          vectorZ += directionZ * contribution;
          heat += contribution;
        }
        const speed = Math.min(1.3, Math.hypot(vectorX, vectorZ));
        node.ignition = THREE.MathUtils.clamp(node.ignition + step * speed * 0.095, 0, 1);
        if (node.ignition >= 1 && heat > 0.16) ignite(node);
      }
    }

    const cameraDistance = (node: FuelNode) => Math.hypot(camera.position.x - node.x, camera.position.z - node.z);
    let nearest: FuelNode | null = null;
    let nearestDistance = Infinity;
    let maxX = -MAP_LIMIT;
    let activeHeat = 0;
    for (const node of active) {
      const distance = cameraDistance(node);
      if (distance < nearestDistance) {
        nearest = node;
        nearestDistance = distance;
      }
      maxX = Math.max(maxX, node.x);
      activeHeat += node.crown ? 4.5 : node.kind === 'tree' ? 1.4 : node.kind === 'brush' ? 0.9 : 0.45;
    }
    fireRenderClock += dt;
    fireMaterial.uniforms.uTime.value = elapsed;
    const wind = windVector();
    fireMaterial.uniforms.uWind.value.set(wind.x, wind.z);
    fireMaterial.uniforms.uWindLean.value = (windSpeed / 35) * 0.5;
    if (fireRenderClock >= 0.09) {
      rebuildFireMesh(elapsed);
      fireRenderClock = 0;
    }
    updateParticles(water, waterPositions, waterColors, waterGeometry, dt, 'water');
    updateParticles(steam, steamPositions, steamColors, steamGeometry, dt, 'steam');
    dirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(dirtPositions, 3));
    dirtGeometry.attributes.position.needsUpdate = true;

    const frontHeat = THREE.MathUtils.clamp(activeHeat / 80, 0, 1);
    atmosphere.heat = nearest ? THREE.MathUtils.clamp(1 - nearestDistance / 36, 0, 1) : 0;
    atmosphere.smog = THREE.MathUtils.clamp(1 - Math.abs(camera.position.x - maxX - 35) / 40, 0, 1) * frontHeat;
    atmosphere.emberStorm = THREE.MathUtils.clamp(1 - Math.abs(camera.position.x - maxX - 12) / 15, 0, 1) * frontHeat;
    atmosphere.fogDensity = 0.016 + atmosphere.smog * 0.022 + atmosphere.heat * 0.018;
    atmosphere.glowX = nearest?.x ?? 0;
    atmosphere.glowY = nearest ? terrainHeight(nearest.x, nearest.z) + Math.max(2, nearest.height * 0.45) : 8;
    atmosphere.glowZ = nearest?.z ?? 0;
    atmosphere.glowStrength = nearest ? (0.8 + atmosphere.heat * 4.8) * (nearest.crown ? 1.8 : 1) : atmosphere.glowStrength * 0.85;

    statsClock += dt;
    if (statsClock >= 0.55) {
      statsClock = 0;
      publishStats();
    }
    return atmosphere;
  };

  const digAt = (x: number, z: number) => {
    if (Math.abs(x) > MAP_LIMIT || Math.abs(z) > MAP_LIMIT) return;
    const start = lastDig ?? { x, z };
    const distance = Math.hypot(x - start.x, z - start.z);
    const steps = Math.max(1, Math.ceil(distance / 0.65));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const px = start.x + (x - start.x) * t;
      const pz = start.z + (z - start.z) * t;
      const radius = 0.9;
      for (const node of nodes) {
        if (node.kind === 'front' || node.state === 'cut' || Math.hypot(node.x - px, node.z - pz) > radius) continue;
        if (node.state === 'burning') {
          burningCount = Math.max(0, burningCount - 1);
          if (node.crown) crownCount = Math.max(0, crownCount - 1);
          const activeIndex = active.indexOf(node);
          if (activeIndex >= 0) active.splice(activeIndex, 1);
        }
        node.state = 'cut';
        node.ignition = 0;
        node.crown = false;
        firebreakCount++;
      }
      breaks.push({ x: px, z: pz, radius: 0.82 });
      dirtPositions.push(px, terrainHeight(px, pz) + 0.035, pz);
      options.onDig?.(px, pz, radius);
      statsDirty = true;
    }
    lastDig = { x, z };
  };

  const sprayWater = (origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }, dt: number) => {
    const magnitude = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const dx = direction.x / magnitude;
    const dy = direction.y / magnitude;
    const dz = direction.z / magnitude;
    const speed = 58 + windSpeed * 1.6;
    for (let index = 0; index < 20; index++) {
      const travel = 0.18 + index * 0.34;
      const particle = {
        x: origin.x + dx * travel,
        y: origin.y + dy * travel,
        z: origin.z + dz * travel,
        vx: dx * speed + (random() - 0.5) * 2.8,
        vy: dy * speed + (random() - 0.5) * 1.6,
        vz: dz * speed + (random() - 0.5) * 2.8,
        age: 0,
        life: 0.18 + random() * 0.12,
      };
      const heat = heatAt(particle.x, particle.z);
      if (heat >= 1.9) spawnSteam(particle.x, particle.y, particle.z, 2);
      else if (particle.x * particle.x + particle.z * particle.z < 148 * 148) impactWater(particle.x, particle.y, particle.z);
      if (water.length < MAX_WATER_PARTICLES) water.push(particle);
    }
  };

  const setWind = (directionDegrees: number, speedMph: number) => {
    windDirection = THREE.MathUtils.euclideanModulo(Number(directionDegrees) || 0, 360);
    windSpeed = THREE.MathUtils.clamp(Number(speedMph) || 0, 0, 35);
  };
  options.onStats?.(getStats());

  return {
    setWind,
    update,
    digAt,
    endTrench: () => { lastDig = null; },
    sprayWater,
    getStats,
    dispose: () => {
      fireGeometry.dispose();
      fireMaterial.dispose();
      waterGeometry.dispose();
      waterTexture.dispose();
      waterMaterial.dispose();
      steamGeometry.dispose();
      steamTexture.dispose();
      steamMaterial.dispose();
      dirtGeometry.dispose();
      dirtMaterial.dispose();
    },
  };
}

function makeSpriteTexture(THREE: any, type: 'water' | 'steam') {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`Could not create ${type} particle texture.`);
  const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 31);
  if (type === 'water') {
    gradient.addColorStop(0, 'rgba(220,250,255,0.9)');
    gradient.addColorStop(0.3, 'rgba(91,194,255,0.65)');
    gradient.addColorStop(1, 'rgba(45,128,210,0)');
  } else {
    gradient.addColorStop(0, 'rgba(245,242,230,0.55)');
    gradient.addColorStop(0.45, 'rgba(205,205,194,0.28)');
    gradient.addColorStop(1, 'rgba(150,150,145,0)');
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
