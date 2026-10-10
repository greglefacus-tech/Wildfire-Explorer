import { createFireSimulation, getFireGridCellIndex, type FireSimulation } from './fire-simulation';
import type { ForestSceneCallbacks, ForestSceneHandle } from './game-types';

type Collider = { x: number; z: number; radius: number; mesh?: any };

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
  scene.background = new THREE.Color('#a8b4a0');
  scene.fog = new THREE.FogExp2('#a8b4a0', 0.0108);
  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 230);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const controls = new PointerLockControls(camera, document.body);
  controls.pointerSpeed = 0.72;
  scene.add(controls.object);

  // Simple camera-attached McLeod view model: timber handle, rake head and teeth.
  const mcleod = new THREE.Group();
  mcleod.position.set(0.43, -0.39, -0.88);
  mcleod.rotation.set(0.02, 0.08, -0.48);
  camera.add(mcleod);
  const handleMaterial = new THREE.MeshStandardMaterial({ color: '#795632', roughness: 0.88 });
  const steelMaterial = new THREE.MeshStandardMaterial({ color: '#aeb9b5', metalness: 0.86, roughness: 0.38 });
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

  const hemi = new THREE.HemisphereLight('#e1e5c8', '#485b43', 2.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1cb', 2.4);
  sun.position.set(-32, 58, 24);
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#a6b8a2', 0.55);
  fill.position.set(30, 18, -35);
  scene.add(fill);

  // Deterministic terrain undulation gives the walk a grounded, irregular path.
  const terrainHeight = (x: number, z: number) =>
    Math.sin(x * 0.095 + 0.8) * 0.62 +
    Math.cos(z * 0.081 - 0.4) * 0.46 +
    Math.sin((x + z) * 0.043) * 0.52 +
    Math.cos(x * 0.21) * Math.sin(z * 0.17) * 0.13;

  const terrainGeometry = new THREE.PlaneGeometry(180, 180, 112, 112);
  terrainGeometry.rotateX(-Math.PI / 2);
  const positions = terrainGeometry.attributes.position;
  const colors: number[] = [];
  const base = new THREE.Color('#5d6d4d');
  const earth = new THREE.Color('#756c50');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const y = terrainHeight(x, z);
    positions.setY(i, y);
    const tint = THREE.MathUtils.clamp((Math.sin(x * 0.15 + z * 0.09) + 1) * 0.18 + y * 0.07, 0, 0.55);
    const color = base.clone().lerp(earth, tint);
    colors.push(color.r, color.g, color.b);
  }
  terrainGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
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
  const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.26, 1, 7);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#4d4332', roughness: 1 });
  const canopyGeometry = [
    new THREE.ConeGeometry(1.45, 2.55, 8),
    new THREE.ConeGeometry(1.17, 2.35, 8),
    new THREE.ConeGeometry(0.88, 2.05, 8),
  ];
  const canopyMaterials = ['#20392e', '#2a4535', '#334e39'].map((color) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.96 }),
  );

  for (let i = 0; i < 116; i++) {
    // Keep the opening around the starting point clear enough to orient.
    let x = 0, z = 0;
    for (let attempt = 0; attempt < 25; attempt++) {
      x = (random() - 0.5) * 128;
      z = (random() - 0.5) * 128;
      if (Math.hypot(x, z) > 9.5) break;
    }
    const scale = 0.78 + random() * 0.62;
    const y = terrainHeight(x, z);
    const trunkHeight = 3.5 * scale;
    treeFuelPoints.push({ x, z, height: 7.05 * scale });
    const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
    trunk.position.set(x, y + trunkHeight / 2, z);
    trunk.scale.set(scale, trunkHeight, scale);
    trunk.rotation.y = random() * Math.PI;
    scene.add(trunk);
    for (let layer = 0; layer < 3; layer++) {
      const canopy = new THREE.Mesh(canopyGeometry[layer], canopyMaterials[layer]);
      canopy.position.set(x, y + trunkHeight + 0.25 + layer * 1.23 * scale, z);
      canopy.scale.set(scale, scale, scale);
      canopy.rotation.y = random() * Math.PI * 2;
      scene.add(canopy);
    }
    colliders.push({ x, z, radius: 0.67 * scale });
  }

  // Grouped low rounded forms read as brush without overwhelming the ground.
  const bushGeometry = new THREE.IcosahedronGeometry(0.6, 1);
  const bushMaterials = ['#506e43', '#597647', '#647e4d', '#4b6742'].map((color) =>
    new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true }),
  );
  const bushFuelPoints: { x: number; z: number }[] = [];
  const bushesByCell = new Map<number, any[]>();
  for (let i = 0; i < 148; i++) {
    const x = (random() - 0.5) * 126;
    const z = (random() - 0.5) * 126;
    if (Math.hypot(x, z) < 5.5) continue;
    const y = terrainHeight(x, z);
    const scale = 0.48 + random() * 0.75;
    const bush = new THREE.Mesh(bushGeometry, bushMaterials[Math.floor(random() * bushMaterials.length)]);
    bush.position.set(x, y + 0.35 * scale, z);
    bush.scale.set(scale * 1.25, scale * 0.72, scale);
    bush.rotation.y = random() * 5;
    scene.add(bush);
    bushFuelPoints.push({ x, z });
    colliders.push({ x, z, radius: 0.55 * scale, mesh: bush });
    const centerCell = getFireGridCellIndex(x, z);
    if (centerCell >= 0) {
      const centerColumn = centerCell % 64;
      const centerRow = Math.floor(centerCell / 64);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const column = centerColumn + dx;
          const row = centerRow + dz;
          if (column < 0 || column >= 64 || row < 0 || row >= 64) continue;
          const nearbyCell = row * 64 + column;
          const bucket = bushesByCell.get(nearbyCell) ?? [];
          bucket.push(bush);
          bushesByCell.set(nearbyCell, bucket);
        }
      }
    }
  }

  // Blade triangles are assembled into one mesh for a light, patchy understory.
  const grassVertices: number[] = [];
  const grassColors: number[] = [];
  const grassBladesByCell = new Map<number, number[]>();
  const grassFuelPoints: { x: number; z: number }[] = [];
  const grassPalette = [new THREE.Color('#91a760'), new THREE.Color('#a2b56c'), new THREE.Color('#809b56')];
  for (let patch = 0; patch < 190; patch++) {
    const cx = (random() - 0.5) * 145;
    const cz = (random() - 0.5) * 145;
    grassFuelPoints.push({ x: cx, z: cz });
    const count = 8 + Math.floor(random() * 11);
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
      const blades = grassBladesByCell.get(cell);
      if (blades) {
        for (const firstVertex of blades) {
          for (let vertex = 0; vertex < 3; vertex++) grassPosition.setY(firstVertex + vertex, -5);
        }
        grassPosition.needsUpdate = true;
      }
      for (const bush of bushesByCell.get(cell) ?? []) bush.visible = false;
    },
  });

  controls.object.position.set(0, terrainHeight(0, 0) + 1.68, 0);
  controls.object.rotation.y = Math.PI / 2;
  const keys = new Set<string>();
  let menuOpen = false;
  let trenching = false;
  let lockedCallback = (_locked: boolean) => {};

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
    if (menuOpen) return;
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      keys.add(key);
      if (key.startsWith('arrow')) event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
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
    trenching = true;
    canvas.classList.add('is-trenching');
    digAtPlayer();
  };
  const onPointerEnd = (event: PointerEvent) => {
    if ((event.type !== 'pointercancel' && event.button !== 0) || !trenching) return;
    trenching = false;
    canvas.classList.remove('is-trenching');
    fireSystem.endTrench();
  };
  const onWindowBlur = () => {
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
        const outside = Math.abs(pos.x) > 83 || Math.abs(pos.z) > 83;
        const blocked = colliders.some((item) =>
          (!item.mesh || item.mesh.visible) && Math.hypot(pos.x - item.x, pos.z - item.z) < item.radius + 0.48,
        );
        if (outside || blocked) {
          // Slide along obstacles and keep the patrol inside the clearing.
          const tryX = pos.x;
          const tryZ = pos.z;
          pos.copy(before);
          pos.x = tryX;
          if (colliders.some((item) =>
            (!item.mesh || item.mesh.visible) && Math.hypot(pos.x - item.x, pos.z - item.z) < item.radius + 0.48,
          ) || Math.abs(pos.x) > 83) pos.x = before.x;
          pos.z = tryZ;
          if (colliders.some((item) =>
            (!item.mesh || item.mesh.visible) && Math.hypot(pos.x - item.x, pos.z - item.z) < item.radius + 0.48,
          ) || Math.abs(pos.z) > 83) pos.z = before.z;
        }
        pos.y = terrainHeight(pos.x, pos.z) + 1.68;
      }
    }
    if (trenching) digAtPlayer();
    if (trenching) {
      const stroke = Math.sin(now * 0.018);
      mcleod.rotation.x = 0.02 + stroke * 0.14;
      mcleod.rotation.z = -0.48 + Math.abs(stroke) * 0.12;
    } else {
      mcleod.rotation.x = 0.02;
      mcleod.rotation.z = -0.48;
    }
    fireSystem.update(dt, now / 1000, camera);
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
