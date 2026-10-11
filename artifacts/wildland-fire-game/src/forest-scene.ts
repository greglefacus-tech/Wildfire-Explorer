import {
  createFireSimulation,
  FIRE_GRID_ORIGIN,
  FIRE_GRID_SIZE,
  FIRE_GRID_CELL_SIZE,
  getFireGridCellIndex,
  type FireSimulation,
} from './fire-simulation';
import type { ForestSceneCallbacks, ForestSceneHandle, ToolSelection } from './game-types';

type Collider = { x: number; z: number; radius: number; active?: boolean };
type BushInstanceRecord = {
  mesh: any;
  instanceId: number;
  collider: Collider;
  visible: boolean;
  x: number;
  z: number;
  scale: number;
  rotation: number;
};
type TreeVisualRecord = {
  instanceId: number;
  charred: boolean;
  x: number;
  z: number;
  y: number;
  scale: number;
  rotation: number;
};

/**
 * All Three.js code is intentionally loaded in the browser from the import map.
 * This keeps the prototype client-only and avoids bundling a second Three build.
 */
export async function mountForest(
  canvas: HTMLCanvasElement,
  callbacks: ForestSceneCallbacks = {},
): Promise<ForestSceneHandle> {
  // Import by URL so Vite leaves Three.js on the CDN rather than trying to bundle it.
  const threeModuleUrl = 'https://unpkg.com/three@0.170.0/build/three.module.js';
  const controlsModuleUrl = 'https://unpkg.com/three@0.170.0/examples/jsm/controls/PointerLockControls.js';
  // @ts-ignore Three is resolved by the browser import map in index.html.
  const THREE: any = await import(/* @vite-ignore */ threeModuleUrl);
  // @ts-ignore The controls module is also served directly from the browser CDN.
  const { PointerLockControls }: any = await import(/* @vite-ignore */ controlsModuleUrl);

  const scene = new THREE.Scene();
  const baseFogColor = new THREE.Color(0x1a0802);
  const heatFogColor = new THREE.Color(0x6a1204);
  const smogFogColor = new THREE.Color(0x2a1c14);
  scene.background = baseFogColor.clone();
  scene.fog = new THREE.FogExp2(0x1a0802, 0.016);
  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 420);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.78;
  const controls = new PointerLockControls(camera, document.body);
  controls.pointerSpeed = 0.72;
  scene.add(controls.object);

  const skyTexture = createApocalypseSkyTexture(THREE);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(360, 24, 16),
    new THREE.MeshBasicMaterial({
      map: skyTexture,
      side: THREE.BackSide,
      depthWrite: false,
      fog: true,
    }),
  );
  sky.renderOrder = -10;
  scene.add(sky);

  // Simple camera-attached McLeod view model: timber handle, rake head and teeth.
  const mcleod = new THREE.Group();
  mcleod.position.set(0.43, -0.39, -0.88);
  mcleod.rotation.set(0.02, 0.08, -0.48);
  camera.add(mcleod);
  const hose = new THREE.Group();
  hose.position.set(0.72, -0.34, -1.05);
  hose.visible = false;
  camera.add(hose);
  const handleMaterial = new THREE.MeshStandardMaterial({ color: '#795632', roughness: 0.88 });
  const steelMaterial = new THREE.MeshStandardMaterial({ color: '#aeb9b5', metalness: 0.86, roughness: 0.38 });
  const hoseMaterial = new THREE.MeshStandardMaterial({ color: '#a71116', roughness: 0.6, metalness: 0.3 });
  const brassMaterial = new THREE.MeshStandardMaterial({ color: '#b89445', roughness: 0.35, metalness: 0.9 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.027, 0.9, 8), handleMaterial);
  handle.position.set(0, 0.28, 0);
  handle.rotation.z = -0.08;
  mcleod.add(handle);
  const rakeHead = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.04, 0.065), steelMaterial);
  rakeHead.position.set(-0.04, 0.71, 0);
  mcleod.add(rakeHead);
  const toothGeometry = new THREE.BoxGeometry(0.018, 0.11, 0.032);
  for (let tooth = 0; tooth < 7; tooth++) {
    const tine = new THREE.Mesh(toothGeometry, steelMaterial);
    tine.position.set(-0.19 + tooth * 0.05, 0.635, 0);
    mcleod.add(tine);
  }
  const hoseTube = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 1.3, 16), hoseMaterial);
  hoseTube.rotation.z = Math.PI / 2;
  hoseTube.position.set(0.28, -0.02, -0.1);
  hose.add(hoseTube);
  const hoseConnector = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.26, 12), brassMaterial);
  hoseConnector.rotation.z = Math.PI / 2;
  hoseConnector.position.set(0.84, -0.02, -0.06);
  hose.add(hoseConnector);
  const nozzleBody = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.038, 0.34, 10), brassMaterial);
  nozzleBody.rotation.z = Math.PI / 2;
  nozzleBody.position.set(1.02, -0.02, -0.06);
  hose.add(nozzleBody);
  const nozzleTip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.14, 10), brassMaterial);
  nozzleTip.rotation.z = Math.PI / 2;
  nozzleTip.position.set(1.26, -0.02, -0.06);
  hose.add(nozzleTip);
  const triggerGuard = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.12), hoseMaterial);
  triggerGuard.position.set(0.98, 0.08, -0.06);
  hose.add(triggerGuard);

  const hemi = new THREE.HemisphereLight(0xc24a18, 0x140804, 0.62);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xff9a4a, 0.48);
  sun.position.set(-22, 26, 14);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x5a2210, 0.28);
  fill.position.set(26, 12, -30);
  scene.add(fill);
  const fireGlow = new THREE.PointLight(0xff5a14, 0, 56, 1.65);
  scene.add(fireGlow);

  const heatTint = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({
      color: 0xff3a00,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  heatTint.position.set(0, 0, -0.72);
  heatTint.frustumCulled = false;
  heatTint.renderOrder = 1000;
  camera.add(heatTint);
  const smogVeil = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({
      color: 0x3a2a1c,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    }),
  );
  smogVeil.position.set(0, 0, -0.74);
  smogVeil.frustumCulled = false;
  smogVeil.renderOrder = 999;
  camera.add(smogVeil);

  // Deterministic terrain undulation gives the walk a grounded, irregular path.
  const hill = (x: number, z: number, cx: number, cz: number, rx: number, rz: number, height: number) =>
    height * Math.exp(-(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2) * 1.15);
  const terrainHeight = (x: number, z: number) =>
    Math.sin(x * 0.045 + 0.8) * 1.15 +
    Math.cos(z * 0.039 - 0.4) * 0.95 +
    Math.sin((x + z) * 0.021) * 1.1 +
    Math.cos(x * 0.11) * Math.sin(z * 0.09) * 0.32 +
    hill(x, z, -86, -63, 38, 46, 11) +
    hill(x, z, -22, 48, 55, 37, 8) +
    hill(x, z, 72, -19, 46, 58, 12) +
    hill(x, z, 12, -105, 42, 39, 7);

  const terrainGeometry = new THREE.PlaneGeometry(320, 320, 192, 192);
  terrainGeometry.rotateX(-Math.PI / 2);
  const positions = terrainGeometry.attributes.position;
  const terrainColors = new Float32Array(positions.count * 3);
  const terrainVerticesByFireCell = new Map<number, number[]>();
  const base = new THREE.Color('#5d6d4d');
  const earth = new THREE.Color('#756c50');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const y = terrainHeight(x, z);
    positions.setY(i, y);
    const tint = THREE.MathUtils.clamp((Math.sin(x * 0.15 + z * 0.09) + 1) * 0.18 + y * 0.07, 0, 0.55);
    const color = base.clone().lerp(earth, tint);
    terrainColors[i * 3] = color.r;
    terrainColors[i * 3 + 1] = color.g;
    terrainColors[i * 3 + 2] = color.b;
    const cell = getFireGridCellIndex(x, z);
    if (cell >= 0) {
      const vertices = terrainVerticesByFireCell.get(cell) ?? [];
      vertices.push(i);
      terrainVerticesByFireCell.set(cell, vertices);
    }
  }
  const baseTerrainColors = terrainColors.slice();
  terrainGeometry.setAttribute('color', new THREE.BufferAttribute(terrainColors, 3));
  const terrainColorAttribute = terrainGeometry.attributes.color;
  terrainGeometry.computeVertexNormals();
  const terrain = new THREE.Mesh(terrainGeometry, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0,
  }));
  terrain.receiveShadow = true;
  scene.add(terrain);

  // A small seeded RNG makes the forest layout stable from visit to visit.
  let seed = 23741;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const colliders: Collider[] = [];
  const treeFuelPoints: { x: number; z: number; height: number }[] = [];
  const treesByCell = new Map<number, TreeVisualRecord[]>();
  const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.26, 1, 7);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 });
  const canopyGeometry = [
    new THREE.ConeGeometry(1.45, 2.55, 8),
    new THREE.ConeGeometry(1.17, 2.35, 8),
    new THREE.ConeGeometry(0.88, 2.05, 8),
  ];
  const canopyMaterials = canopyGeometry.map(() =>
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96 }),
  );
  const canopyPalettes = [
    ['#183126', '#203a2c', '#294331'],
    ['#20392e', '#294433', '#334c36'],
    ['#294231', '#334b35', '#3a533a'],
  ].map((palette) => palette.map((color) => new THREE.Color(color)));
  const treeCount = 880;
  const trunkInstances = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, treeCount);
  const canopyInstances = canopyGeometry.map((geometry, layer) =>
    new THREE.InstancedMesh(geometry, canopyMaterials[layer], treeCount),
  );
  trunkInstances.frustumCulled = false;
  canopyInstances.forEach((mesh: any) => { mesh.frustumCulled = false; });
  const placement = new THREE.Object3D();

  for (let i = 0; i < treeCount; i++) {
    // Keep the opening around the starting point clear enough to orient.
    let x = 0, z = 0;
    for (let attempt = 0; attempt < 25; attempt++) {
      x = (random() - 0.5) * 256;
      z = (random() - 0.5) * 256;
      if (Math.hypot(x, z) > 9.5) break;
    }
    const scale = 0.78 + random() * 0.62;
    const y = terrainHeight(x, z);
    const trunkHeight = 3.5 * scale;
    const rotation = random() * Math.PI;
    treeFuelPoints.push({ x, z, height: 7.05 * scale });
    placement.position.set(x, y + trunkHeight / 2, z);
    placement.scale.set(scale, trunkHeight, scale);
    placement.rotation.set(0, rotation, 0);
    placement.updateMatrix();
    trunkInstances.setMatrixAt(i, placement.matrix);
    const trunkColor = new THREE.Color('#4d4332').multiplyScalar(0.88 + random() * 0.22);
    trunkInstances.setColorAt(i, trunkColor);
    for (let layer = 0; layer < 3; layer++) {
      placement.position.set(x, y + trunkHeight + 0.25 + layer * 1.23 * scale, z);
      placement.scale.set(scale, scale, scale);
      placement.rotation.set(0, random() * Math.PI * 2, 0);
      placement.updateMatrix();
      canopyInstances[layer].setMatrixAt(i, placement.matrix);
      const shade = canopyPalettes[layer][Math.floor(random() * canopyPalettes[layer].length)];
      const canopyColor = shade.clone().multiplyScalar(0.9 + random() * 0.2);
      canopyInstances[layer].setColorAt(i, canopyColor);
    }
    const visualRecord: TreeVisualRecord = { instanceId: i, charred: false, x, z, y, scale, rotation };
    const centerCell = getFireGridCellIndex(x, z);
    if (centerCell >= 0) {
      const centerColumn = centerCell % FIRE_GRID_SIZE;
      const centerRow = Math.floor(centerCell / FIRE_GRID_SIZE);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const column = centerColumn + dx;
          const row = centerRow + dz;
          if (column < 0 || column >= FIRE_GRID_SIZE || row < 0 || row >= FIRE_GRID_SIZE) continue;
          const cellX = FIRE_GRID_ORIGIN + (column + 0.5) * FIRE_GRID_CELL_SIZE;
          const cellZ = FIRE_GRID_ORIGIN + (row + 0.5) * FIRE_GRID_CELL_SIZE;
          if (Math.hypot(cellX - x, cellZ - z) > 1.18) continue;
          const cell = row * FIRE_GRID_SIZE + column;
          const bucket = treesByCell.get(cell) ?? [];
          bucket.push(visualRecord);
          treesByCell.set(cell, bucket);
        }
      }
    }
    colliders.push({ x, z, radius: 0.67 * scale });
  }
  trunkInstances.instanceMatrix.needsUpdate = true;
  if (trunkInstances.instanceColor) trunkInstances.instanceColor.needsUpdate = true;
  for (const mesh of canopyInstances) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
  }
  scene.add(trunkInstances);
  const treeBranchGeometry = new THREE.CylinderGeometry(0.035, 0.075, 1, 5);
  const treeBranchMaterial = new THREE.MeshStandardMaterial({ color: '#211f19', roughness: 1 });
  const treeSkeletonBranches = new THREE.InstancedMesh(treeBranchGeometry, treeBranchMaterial, treeCount * 3);
  treeSkeletonBranches.frustumCulled = false;
  const hiddenPlacement = new THREE.Object3D();
  hiddenPlacement.position.set(0, -100, 0);
  hiddenPlacement.scale.set(0, 0, 0);
  hiddenPlacement.updateMatrix();
  for (let i = 0; i < treeCount * 3; i++) treeSkeletonBranches.setMatrixAt(i, hiddenPlacement.matrix);
  treeSkeletonBranches.instanceMatrix.needsUpdate = true;
  scene.add(treeSkeletonBranches);

  // Instancing keeps the denser brush field to a single draw call.
  const bushGeometry = new THREE.IcosahedronGeometry(0.6, 1);
  const bushMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true });
  const bushCount = 1100;
  const bushInstances = new THREE.InstancedMesh(bushGeometry, bushMaterial, bushCount);
  bushInstances.frustumCulled = false;
  const bushFuelPoints: { x: number; z: number }[] = [];
  const bushesByCell = new Map<number, BushInstanceRecord[]>();
  let bushInstanceCount = 0;
  const bushPalette = ['#506e43', '#597647', '#647e4d', '#4b6742'].map((color) => new THREE.Color(color));
  for (let i = 0; i < bushCount; i++) {
    const x = (random() - 0.5) * 256;
    const z = (random() - 0.5) * 256;
    if (Math.hypot(x, z) < 5.5) continue;
    const y = terrainHeight(x, z);
    const scale = 0.48 + random() * 0.75;
    const instanceId = bushInstanceCount++;
    placement.position.set(x, y + 0.35 * scale, z);
    placement.scale.set(scale * 1.25, scale * 0.72, scale);
    placement.rotation.set(0, random() * 5, 0);
    placement.updateMatrix();
    bushInstances.setMatrixAt(instanceId, placement.matrix);
    bushInstances.setColorAt(instanceId, bushPalette[Math.floor(random() * bushPalette.length)]);
    bushFuelPoints.push({ x, z });
    const collider: Collider = { x, z, radius: 0.55 * scale, active: true };
    colliders.push(collider);
    const rotation = random() * 5;
    const record: BushInstanceRecord = { mesh: bushInstances, instanceId, collider, visible: true, x, z, scale, rotation };
    const centerCell = getFireGridCellIndex(x, z);
    if (centerCell >= 0) {
      const centerColumn = centerCell % FIRE_GRID_SIZE;
      const centerRow = Math.floor(centerCell / FIRE_GRID_SIZE);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const column = centerColumn + dx;
          const row = centerRow + dz;
          if (column < 0 || column >= FIRE_GRID_SIZE || row < 0 || row >= FIRE_GRID_SIZE) continue;
          const nearbyX = FIRE_GRID_ORIGIN + (column + 0.5) * FIRE_GRID_CELL_SIZE;
          const nearbyZ = FIRE_GRID_ORIGIN + (row + 0.5) * FIRE_GRID_CELL_SIZE;
          if (Math.hypot(nearbyX - x, nearbyZ - z) > 3.6) continue;
          const nearbyCell = row * FIRE_GRID_SIZE + column;
          const bucket = bushesByCell.get(nearbyCell) ?? [];
          bucket.push(record);
          bushesByCell.set(nearbyCell, bucket);
        }
      }
    }
  }
  bushInstances.count = bushInstanceCount;
  bushInstances.instanceMatrix.needsUpdate = true;
  if (bushInstances.instanceColor) bushInstances.instanceColor.needsUpdate = true;
  scene.add(bushInstances);
  const bushStemGeometry = new THREE.CylinderGeometry(0.022, 0.052, 1, 5);
  const bushStemMaterial = new THREE.MeshStandardMaterial({ color: '#211f19', roughness: 1 });
  const bushSkeletonBranches = Array.from({ length: 3 }, () => {
    const mesh = new THREE.InstancedMesh(bushStemGeometry, bushStemMaterial, bushInstanceCount);
    mesh.count = bushInstanceCount;
    mesh.frustumCulled = false;
    for (let i = 0; i < bushInstanceCount; i++) mesh.setMatrixAt(i, hiddenPlacement.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    return mesh;
  });

  // One larger blade mesh fills the widened map without adding draw calls.
  const grassVertices: number[] = [];
  const grassColors: number[] = [];
  const grassBladesByCell = new Map<number, number[]>();
  const grassFuelPoints: { x: number; z: number }[] = [];
  const grassPalette = [new THREE.Color('#91a760'), new THREE.Color('#a2b56c'), new THREE.Color('#809b56')];
  for (let patch = 0; patch < 620; patch++) {
    const cx = (random() - 0.5) * 290;
    const cz = (random() - 0.5) * 290;
    grassFuelPoints.push({ x: cx, z: cz });
    const count = 14 + Math.floor(random() * 13);
    for (let blade = 0; blade < count; blade++) {
      const x = cx + (random() - 0.5) * 2.4;
      const z = cz + (random() - 0.5) * 2.4;
      const y = terrainHeight(x, z) + 0.04;
      const height = 0.14 + random() * 0.26;
      const width = 0.025 + random() * 0.035;
      const lean = (random() - 0.5) * 0.16;
      const a = random() * Math.PI * 2;
      const dx = Math.cos(a) * width, dz = Math.sin(a) * width;
      const color = grassPalette[Math.floor(random() * grassPalette.length)];
      const firstVertex = grassVertices.length / 3;
      grassVertices.push(x - dx, y, z - dz, x + dx, y, z + dz, x + lean, y + height, z + lean);
      for (let k = 0; k < 3; k++) grassColors.push(color.r, color.g, color.b);
      const cell = getFireGridCellIndex(x, z);
      if (cell >= 0) {
        const blades = grassBladesByCell.get(cell) ?? [];
        blades.push(firstVertex);
        grassBladesByCell.set(cell, blades);
      }
    }
  }
  const grassGeometry = new THREE.BufferGeometry();
  grassGeometry.setAttribute('position', new THREE.Float32BufferAttribute(grassVertices, 3));
  grassGeometry.setAttribute('color', new THREE.Float32BufferAttribute(grassColors, 3));
  grassGeometry.computeVertexNormals();
  const grassMesh = new THREE.Mesh(grassGeometry, new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 1,
  }));
  grassMesh.frustumCulled = false;
  scene.add(grassMesh);

  const grassPosition = grassGeometry.attributes.position;
  const removeGrassAtCell = (cell: number) => {
    const blades = grassBladesByCell.get(cell);
    if (!blades?.length) return;
    for (const firstVertex of blades) {
      for (let vertex = 0; vertex < 3; vertex++) grassPosition.setY(firstVertex + vertex, -5);
    }
    grassPosition.needsUpdate = true;
  };
  const hideBushesAtCell = (cell: number, leaveCharredStems = false) => {
    for (const bush of bushesByCell.get(cell) ?? []) {
      if (!bush.visible) continue;
      bush.visible = false;
      bush.collider.active = false;
      bush.mesh.setMatrixAt(bush.instanceId, hiddenPlacement.matrix);
      bush.mesh.instanceMatrix.needsUpdate = true;
      if (!leaveCharredStems) continue;
      const ground = terrainHeight(bush.x, bush.z);
      const branches = [
        { height: 1.1, tiltX: 0.18, tiltZ: -0.34, x: 0, z: 0 },
        { height: 0.88, tiltX: -0.38, tiltZ: 0.25, x: 0.1, z: -0.04 },
        { height: 0.76, tiltX: 0.32, tiltZ: 0.48, x: -0.08, z: 0.05 },
      ];
      branches.forEach((branch, branchIndex) => {
        const height = bush.scale * branch.height;
        placement.position.set(
          bush.x + branch.x * bush.scale,
          ground + height / 2,
          bush.z + branch.z * bush.scale,
        );
        placement.scale.set(bush.scale * 0.62, height, bush.scale * 0.62);
        placement.rotation.set(branch.tiltX, bush.rotation + branchIndex * 1.6, branch.tiltZ);
        placement.updateMatrix();
        bushSkeletonBranches[branchIndex].setMatrixAt(bush.instanceId, placement.matrix);
        bushSkeletonBranches[branchIndex].instanceMatrix.needsUpdate = true;
      });
    }
  };
  const charTreesAtCell = (cell: number) => {
    for (const tree of treesByCell.get(cell) ?? []) {
      if (tree.charred) continue;
      tree.charred = true;
      for (const canopy of canopyInstances) {
        canopy.setMatrixAt(tree.instanceId, hiddenPlacement.matrix);
        canopy.instanceMatrix.needsUpdate = true;
      }
      trunkInstances.setColorAt(tree.instanceId, new THREE.Color('#171814'));
      if (trunkInstances.instanceColor) trunkInstances.instanceColor.needsUpdate = true;
      const branches = [
        { height: 1.65, tiltX: 0.22, tiltZ: -0.54, yaw: -0.8 },
        { height: 1.45, tiltX: -0.32, tiltZ: 0.49, yaw: 1.1 },
        { height: 1.2, tiltX: 0.42, tiltZ: 0.26, yaw: 2.5 },
      ];
      branches.forEach((branch, branchIndex) => {
        const height = tree.scale * branch.height;
        placement.position.set(
          tree.x + Math.cos(tree.rotation + branch.yaw) * tree.scale * 0.2,
          tree.y + tree.scale * 3.0 + height / 2,
          tree.z + Math.sin(tree.rotation + branch.yaw) * tree.scale * 0.2,
        );
        placement.scale.set(tree.scale * 0.68, height, tree.scale * 0.68);
        placement.rotation.set(branch.tiltX, tree.rotation + branch.yaw, branch.tiltZ);
        placement.updateMatrix();
        treeSkeletonBranches.setMatrixAt(tree.instanceId * 3 + branchIndex, placement.matrix);
        treeSkeletonBranches.instanceMatrix.needsUpdate = true;
      });
    }
  };
  const terrainBurnFades: { vertices: number[]; age: number }[] = [];
  const charredColor = new THREE.Color('#20221d');
  const fireSystem: FireSimulation = createFireSimulation({
    THREE,
    scene,
    terrainHeight,
    random,
    trees: treeFuelPoints,
    bushes: bushFuelPoints,
    grassPatches: grassFuelPoints,
    onStats: callbacks.onFireStats,
    onDigCell: (cell) => {
      removeGrassAtCell(cell);
      hideBushesAtCell(cell);
    },
    onCellBurned: (cell) => {
      const vertices = terrainVerticesByFireCell.get(cell);
      if (vertices?.length) terrainBurnFades.push({ vertices, age: 0 });
      removeGrassAtCell(cell);
      hideBushesAtCell(cell, true);
      charTreesAtCell(cell);
    },
  });

  controls.object.position.set(0, terrainHeight(0, 0) + 1.68, 0);
  controls.object.rotation.y = Math.PI / 2;
  const keys = new Set<string>();
  let menuOpen = false;
  let trenching = false;
  let waterSpraying = false;
  let activeTool: ToolSelection = 'mcleod';
  let lockedCallback = (_locked: boolean) => {};
  callbacks.onToolChange?.(activeTool);

  const setActiveTool = (tool: ToolSelection) => {
    activeTool = tool;
    mcleod.visible = tool === 'mcleod';
    hose.visible = tool === 'hose';
    callbacks.onToolChange?.(tool);
    waterSpraying = false;
    if (tool === 'mcleod') {
      canvas.classList.remove('is-trenching');
    }
  };

  const setMenuState = (open: boolean) => {
    menuOpen = open;
    if (open) {
      keys.clear();
      trenching = false;
      canvas.classList.remove('is-trenching');
      fireSystem.endTrench();
      controls.unlock();
    }
    callbacks.onMenuChange?.(open);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (key === 'escape' || key === 'tab') {
      event.preventDefault();
      if (!event.repeat) setMenuState(!menuOpen);
      return;
    }
    if (key === 'p') {
      event.preventDefault();
      if (!event.repeat && !menuOpen) {
        if (controls.isLocked) controls.unlock();
        else controls.lock();
      }
      return;
    }
    if (key === '1') {
      event.preventDefault();
      setActiveTool('mcleod');
      return;
    }
    if (key === '2') {
      event.preventDefault();
      setActiveTool('hose');
      return;
    }
    if (menuOpen) return;
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      keys.add(key);
      if (key.startsWith('arrow')) event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (key === '1' || key === '2') return;
    keys.delete(key);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  const onLock = () => {
    lockedCallback(true);
    callbacks.onLockChange?.(true);
  };
  const onUnlock = () => {
    keys.clear();
    lockedCallback(false);
    callbacks.onLockChange?.(false);
  };
  controls.addEventListener('lock', onLock);
  controls.addEventListener('unlock', onUnlock);

  const digAtPlayer = () => {
    const position = controls.object.position;
    fireSystem.digAt(position.x, position.z);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || menuOpen) return;
    const target = event.target as Element | null;
    if (target?.closest?.('.hud, .menu-backdrop, .lock-screen')) return;
    if (!controls.isLocked && target !== canvas) return;

    if (activeTool === 'hose') {
      waterSpraying = true;
      return;
    }

    trenching = true;
    canvas.classList.add('is-trenching');
    digAtPlayer();
  };
  const onPointerEnd = (event: PointerEvent) => {
    if (event.type !== 'pointercancel' && event.button !== 0) return;
    if (activeTool === 'hose') {
      waterSpraying = false;
      return;
    }
    if (!trenching) return;
    trenching = false;
    canvas.classList.remove('is-trenching');
    fireSystem.endTrench();
  };
  const onWindowBlur = () => {
    if (activeTool === 'hose') {
      waterSpraying = false;
      return;
    }
    if (!trenching) return;
    trenching = false;
    canvas.classList.remove('is-trenching');
    fireSystem.endTrench();
  };
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
  window.addEventListener('blur', onWindowBlur);

  const resize = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  window.addEventListener('resize', resize);
  resize();

  let frame = 0;
  let disposed = false;
  let previous = performance.now();
  const animate = (now: number) => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    const dt = Math.min((now - previous) / 1000, 0.04);
    previous = now;
    if (controls.isLocked) {
      const forward = Number(keys.has('w') || keys.has('arrowup')) - Number(keys.has('s') || keys.has('arrowdown'));
      const side = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'));
      if (forward || side) {
        const distance = 4.1 * dt;
        const before = controls.object.position.clone();
        controls.moveForward(forward * distance);
        controls.moveRight(side * distance);
        const pos = controls.object.position;
        const outside = Math.abs(pos.x) > 148 || Math.abs(pos.z) > 148;
        const blocked = colliders.some((item) =>
          item.active !== false && Math.hypot(pos.x - item.x, pos.z - item.z) < item.radius + 0.48,
        );
        if (outside || blocked) {
          // Slide along obstacles and keep the patrol inside the clearing.
          const tryX = pos.x;
          const tryZ = pos.z;
          pos.copy(before);
          pos.x = tryX;
          if (colliders.some((item) =>
            item.active !== false && Math.hypot(pos.x - item.x, pos.z - item.z) < item.radius + 0.48,
          ) || Math.abs(pos.x) > 148) pos.x = before.x;
          pos.z = tryZ;
          if (colliders.some((item) =>
            item.active !== false && Math.hypot(pos.x - item.x, pos.z - item.z) < item.radius + 0.48,
          ) || Math.abs(pos.z) > 148) pos.z = before.z;
        }
        pos.y = terrainHeight(pos.x, pos.z) + 1.68;
      }
    }
    if (activeTool === 'hose' && waterSpraying && controls.isLocked) {
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      const nozzleLocal = new THREE.Vector3(1.28, -0.02, -0.06);
      const hoseTip = nozzleLocal.clone().applyQuaternion(camera.quaternion).add(camera.position);
      const origin = hoseTip.clone();
      fireSystem.sprayWater(origin, direction, dt);
    }
    if (trenching) digAtPlayer();
    if (activeTool === 'hose') {
      hose.position.set(0.72, -0.34, -1.05);
      hose.quaternion.copy(camera.quaternion);
      hose.rotateY(-0.15);
      hose.rotateX(0.22);
    } else if (trenching) {
      const stroke = Math.sin(now * 0.018);
      mcleod.rotation.x = 0.02 + stroke * 0.14;
      mcleod.rotation.z = -0.48 + Math.abs(stroke) * 0.12;
    } else {
      mcleod.rotation.x = 0.02;
      mcleod.rotation.z = -0.48;
    }
    let terrainColorChanged = false;
    for (let i = terrainBurnFades.length - 1; i >= 0; i--) {
      const fade = terrainBurnFades[i];
      fade.age += dt;
      const progress = Math.min(1, fade.age / 7.5);
      for (const vertex of fade.vertices) {
        const offset = vertex * 3;
        terrainColors[offset] = baseTerrainColors[offset] * (1 - progress) + charredColor.r * progress;
        terrainColors[offset + 1] = baseTerrainColors[offset + 1] * (1 - progress) + charredColor.g * progress;
        terrainColors[offset + 2] = baseTerrainColors[offset + 2] * (1 - progress) + charredColor.b * progress;
      }
      terrainColorChanged = true;
      if (progress >= 1) {
        terrainBurnFades[i] = terrainBurnFades[terrainBurnFades.length - 1];
        terrainBurnFades.pop();
      }
    }
    if (terrainColorChanged) terrainColorAttribute.needsUpdate = true;
    const atmosphere = fireSystem.update(dt, now / 1000, camera);
    const fog = scene.fog;
    const targetFog = baseFogColor.clone().lerp(smogFogColor, atmosphere.smog).lerp(heatFogColor, atmosphere.heat);
    fog.color.copy(targetFog);
    fog.density = atmosphere.fogDensity;
    scene.background.copy(targetFog);
    hemi.intensity = 0.48 + atmosphere.heat * 0.55 + atmosphere.smog * 0.08;
    hemi.color.setHex(atmosphere.heat > 0.45 ? 0xff6a1c : 0xc24a18);
    sun.intensity = 0.22 + (1 - atmosphere.smog) * 0.28 - atmosphere.heat * 0.08;
    sun.color.setHex(atmosphere.smog > 0.4 ? 0xc46a28 : 0xff9a4a);
    fireGlow.position.set(atmosphere.glowX, atmosphere.glowY, atmosphere.glowZ);
    fireGlow.intensity = atmosphere.glowStrength;
    heatTint.material.opacity = atmosphere.heat * 0.42;
    smogVeil.material.opacity = atmosphere.smog * 0.46;
    renderer.toneMappingExposure = 0.68 + atmosphere.heat * 0.55 - atmosphere.smog * 0.12;
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(animate);

  return {
    lock: () => {
      if (menuOpen) setMenuState(false);
      controls.lock();
    },
    unlock: () => controls.unlock(),
    setWind: (directionDegrees, speedMph) => fireSystem.setWind(directionDegrees, speedMph),
    setMenuOpen: (open) => setMenuState(open),
    setActiveTool: (tool: ToolSelection) => setActiveTool(tool),
    getActiveTool: () => activeTool,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('blur', onWindowBlur);
      controls.removeEventListener('lock', onLock);
      controls.removeEventListener('unlock', onUnlock);
      fireSystem.dispose();
      skyTexture.dispose();
      controls.dispose();
      scene.traverse((object: any) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material: any) => material.dispose());
        else object.material?.dispose?.();
      });
      renderer.dispose();
    },
  };
}

function createApocalypseSkyTexture(THREE: any) {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the sky texture.');
  const gradient = context.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#0a0406');
  gradient.addColorStop(0.38, '#1c0806');
  gradient.addColorStop(0.62, '#4a1408');
  gradient.addColorStop(0.82, '#a8320c');
  gradient.addColorStop(0.93, '#c44512');
  gradient.addColorStop(1, '#1a0802');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 8, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
