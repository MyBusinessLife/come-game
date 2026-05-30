import * as THREE from "/assets/three.module.min.js";

const canvas = document.getElementById("game-room-canvas");
const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (canvas && !reducedMotion) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
  camera.position.set(0, 0.5, 16);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const ambient = new THREE.HemisphereLight(0xbfffee, 0x1f1035, 1.3);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.65);
  keyLight.position.set(3, 5, 7);
  scene.add(keyLight);

  const rimLight = new THREE.PointLight(0x45f0ff, 12, 30);
  rimLight.position.set(-6, 4, 7);
  scene.add(rimLight);

  const roseLight = new THREE.PointLight(0xff4fa3, 9, 32);
  roseLight.position.set(7, -3, 5);
  scene.add(roseLight);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x101a22,
    metalness: 0.38,
    roughness: 0.32,
    transparent: true,
    opacity: 0.64,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x07100d,
    metalness: 0.55,
    roughness: 0.26,
    transparent: true,
    opacity: 0.7,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xdffdf4,
    metalness: 0.1,
    roughness: 0.08,
    transparent: true,
    opacity: 0.34,
    emissive: 0x123c36,
    emissiveIntensity: 0.18,
  });
  const cyanMat = new THREE.MeshStandardMaterial({ color: 0x35e8ff, emissive: 0x087685, emissiveIntensity: 0.45, roughness: 0.22 });
  const pinkMat = new THREE.MeshStandardMaterial({ color: 0xff3d97, emissive: 0x7c113d, emissiveIntensity: 0.48, roughness: 0.22 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xf3c86a, emissive: 0x6c4a0e, emissiveIntensity: 0.32, roughness: 0.28 });
  const greenMat = new THREE.MeshStandardMaterial({ color: 0x49f28f, emissive: 0x11672e, emissiveIntensity: 0.36, roughness: 0.22 });
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xf7fbff,
    metalness: 0.18,
    roughness: 0.27,
    transparent: true,
    opacity: 0.74,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x0a0e13,
    metalness: 0.5,
    roughness: 0.2,
    transparent: true,
    opacity: 0.82,
  });
  const blueLightMat = new THREE.MeshStandardMaterial({
    color: 0x4bdcff,
    emissive: 0x1195ff,
    emissiveIntensity: 0.95,
    roughness: 0.16,
  });

  function mesh(geometry, material, x, y, z) {
    const item = new THREE.Mesh(geometry, material);
    item.position.set(x || 0, y || 0, z || 0);
    return item;
  }

  function makeDualSensePad() {
    const pad = new THREE.Group();

    const mainShell = mesh(new THREE.CapsuleGeometry(0.62, 2.0, 18, 42), shellMat, 0, 0, 0);
    mainShell.rotation.z = Math.PI / 2;
    mainShell.scale.set(1.06, 0.78, 0.22);
    pad.add(mainShell);

    const leftWing = mesh(new THREE.CapsuleGeometry(0.52, 0.9, 18, 34), shellMat, -1.55, -0.08, 0.02);
    leftWing.rotation.z = 0.82;
    leftWing.scale.set(0.72, 1.28, 0.24);
    pad.add(leftWing);

    const rightWing = mesh(new THREE.CapsuleGeometry(0.52, 0.9, 18, 34), shellMat, 1.55, -0.08, 0.02);
    rightWing.rotation.z = -0.82;
    rightWing.scale.set(0.72, 1.28, 0.24);
    pad.add(rightWing);

    const centerBlack = mesh(new THREE.CapsuleGeometry(0.42, 1.18, 16, 32), trimMat, 0, -0.02, 0.32);
    centerBlack.rotation.z = Math.PI / 2;
    centerBlack.scale.set(0.94, 0.6, 0.16);
    pad.add(centerBlack);

    const touchPad = mesh(new THREE.BoxGeometry(0.82, 0.35, 0.08), trimMat, 0, 0.26, 0.56);
    touchPad.scale.set(1, 0.78, 1);
    pad.add(touchPad);

    const leftLight = mesh(new THREE.BoxGeometry(0.54, 0.045, 0.06), blueLightMat, -0.45, 0.06, 0.62);
    leftLight.rotation.z = 0.35;
    const rightLight = mesh(new THREE.BoxGeometry(0.54, 0.045, 0.06), blueLightMat, 0.45, 0.06, 0.62);
    rightLight.rotation.z = -0.35;
    pad.add(leftLight, rightLight);

    const leftShoulder = mesh(new THREE.BoxGeometry(1.0, 0.18, 0.18), shellMat, -0.85, 0.73, 0.02);
    const rightShoulder = mesh(new THREE.BoxGeometry(1.0, 0.18, 0.18), shellMat, 0.85, 0.73, 0.02);
    pad.add(leftShoulder, rightShoulder);

    [
      [-0.62, -0.18],
      [0.62, -0.18],
    ].forEach(([x, y]) => {
      const base = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 36), trimMat, x, y, 0.63);
      base.rotation.x = Math.PI / 2;
      const top = mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.1, 36), darkMat, x, y, 0.73);
      top.rotation.x = Math.PI / 2;
      pad.add(base, top);
    });

    const dpadH = mesh(new THREE.BoxGeometry(0.5, 0.12, 0.08), trimMat, -1.06, 0.14, 0.62);
    const dpadV = mesh(new THREE.BoxGeometry(0.12, 0.5, 0.08), trimMat, -1.06, 0.14, 0.63);
    pad.add(dpadH, dpadV);

    [
      [1.03, 0.32, pinkMat],
      [1.28, 0.12, greenMat],
      [1.04, -0.09, cyanMat],
      [0.8, 0.12, goldMat],
    ].forEach((b) => {
      pad.add(mesh(new THREE.SphereGeometry(0.105, 24, 18), b[2], b[0], b[1], 0.68));
    });

    const home = mesh(new THREE.SphereGeometry(0.07, 18, 12), blueLightMat, 0, -0.42, 0.68);
    pad.add(home);
    return pad;
  }

  function makeHandheld() {
    const item = new THREE.Group();
    item.add(mesh(new THREE.BoxGeometry(1.7, 2.12, 0.28), bodyMat, 0, 0, 0));
    item.add(mesh(new THREE.BoxGeometry(1.05, 1.1, 0.05), glassMat, 0, 0.26, 0.19));
    item.add(mesh(new THREE.BoxGeometry(0.36, 0.08, 0.07), cyanMat, -0.47, -0.66, 0.21));
    item.add(mesh(new THREE.BoxGeometry(0.08, 0.36, 0.07), cyanMat, -0.47, -0.66, 0.22));
    item.add(mesh(new THREE.SphereGeometry(0.12, 24, 16), pinkMat, 0.48, -0.58, 0.22));
    item.add(mesh(new THREE.SphereGeometry(0.12, 24, 16), goldMat, 0.76, -0.72, 0.22));
    return item;
  }

  function makeCartridge() {
    const item = new THREE.Group();
    item.add(mesh(new THREE.BoxGeometry(1.18, 1.58, 0.22), darkMat, 0, 0, 0));
    item.add(mesh(new THREE.BoxGeometry(0.86, 0.76, 0.05), glassMat, 0, 0.22, 0.15));
    item.add(mesh(new THREE.BoxGeometry(0.94, 0.08, 0.07), goldMat, 0, -0.66, 0.15));
    return item;
  }

  function makeDisc() {
    const item = new THREE.Group();
    item.add(mesh(new THREE.TorusGeometry(0.64, 0.08, 18, 64), glassMat, 0, 0, 0));
    item.add(mesh(new THREE.TorusGeometry(0.23, 0.04, 18, 44), cyanMat, 0, 0, 0.02));
    item.add(mesh(new THREE.SphereGeometry(0.08, 18, 12), pinkMat, 0, 0, 0.07));
    return item;
  }

  const textureLoader = new THREE.TextureLoader();
  const artworkSources = [
    { url: "/assets/game-room/art-01.webp", aspect: 1.63 },
    { url: "/assets/game-room/art-02.webp", aspect: 1.63 },
    { url: "/assets/game-room/art-03.webp", aspect: 0.72 },
    { url: "/assets/game-room/art-04.webp", aspect: 1.78 },
    { url: "/assets/game-room/art-05.webp", aspect: 1.67 },
    { url: "/assets/game-room/art-06.webp", aspect: 0.72 },
  ];

  function makeArtworkPanel(source, index) {
    const group = new THREE.Group();
    const height = source.aspect < 1 ? 2.5 : 1.42;
    const width = height * source.aspect;
    const frame = mesh(new THREE.BoxGeometry(width + 0.12, height + 0.12, 0.08), darkMat, 0, 0, -0.05);
    frame.material = darkMat.clone();
    frame.material.opacity = 0.38;
    group.add(frame);

    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const plane = mesh(new THREE.PlaneGeometry(width, height), material, 0, 0, 0.02);
    group.add(plane);

    textureLoader.load(source.url, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
      material.map = texture;
      material.needsUpdate = true;
    });

    group.userData.isPoster = true;
    group.userData.phase = index * 0.77;
    group.userData.speed = 0.1 + index * 0.012;
    group.userData.float = 0.22 + (index % 3) * 0.08;
    group.userData.rotate = 0.026 + index * 0.006;
    return group;
  }

  const makers = [makeDualSensePad, makeHandheld, makeCartridge, makeDisc];
  const objects = [];
  const posterPositions = [
    [-8.4, 3.9, -10.6, 0.12, 0.5],
    [8.1, 3.8, -10.9, -0.1, -0.48],
    [-9.3, -0.8, -11.6, -0.08, 0.58],
    [9.5, -1.0, -11.9, 0.1, -0.55],
    [-6.0, -4.6, -12.4, 0.16, 0.36],
    [6.2, -4.4, -12.6, -0.13, -0.36],
  ];

  artworkSources.forEach((source, index) => {
    const panel = makeArtworkPanel(source, index);
    const pos = posterPositions[index];
    panel.position.set(pos[0], pos[1], pos[2]);
    panel.rotation.set(pos[3], pos[4], (index - 2) * 0.025);
    panel.userData.base = panel.position.clone();
    scene.add(panel);
    objects.push(panel);
  });

  const positions = [
    [-7.7, 3.1, -3.8], [7.8, 2.8, -4.6], [-8.2, -2.6, -4.1], [8.4, -2.8, -4.4],
    [-4.9, 4.9, -7.4], [4.8, 4.6, -7.8], [-5.8, -4.7, -7.2], [5.7, -4.8, -7.5],
    [-10.1, 0.3, -8.8], [10.2, 0.2, -8.8], [-1.6, 5.8, -9.6], [1.8, -5.8, -9.6],
  ];

  positions.forEach((pos, index) => {
    const object = makers[index % makers.length]();
    object.position.set(pos[0], pos[1], pos[2]);
    const scale = index % 4 === 0 ? 1.24 : 0.86 + (index % 3) * 0.1;
    object.scale.setScalar(scale);
    object.rotation.set(index * 0.43, index * 0.61, index * 0.22);
    object.userData = {
      base: object.position.clone(),
      speed: 0.18 + (index % 5) * 0.035,
      float: 0.35 + (index % 4) * 0.11,
      rotate: 0.12 + (index % 6) * 0.025,
      phase: index * 0.9,
    };
    scene.add(object);
    objects.push(object);
  });

  function resize() {
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.z = width < 680 ? 19 : 16;
    camera.updateProjectionMatrix();
  }

  let running = true;
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
  });

  window.addEventListener("resize", resize, { passive: true });
  resize();

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    if (!running) return;
    const t = clock.getElapsedTime();
    objects.forEach((object) => {
      const data = object.userData;
      object.position.x = data.base.x + Math.sin(t * data.speed + data.phase) * data.float;
      object.position.y = data.base.y + Math.cos(t * data.speed * 0.86 + data.phase) * data.float;
      object.rotation.x += data.rotate * 0.0038;
      object.rotation.y += data.rotate * 0.0052;
      object.rotation.z += data.rotate * 0.0025;
    });
    rimLight.position.x = Math.sin(t * 0.28) * 7;
    roseLight.position.y = Math.cos(t * 0.22) * 4;
    renderer.render(scene, camera);
    window.CAG_LINK_SCENE_READY = true;
  }

  animate();
}
