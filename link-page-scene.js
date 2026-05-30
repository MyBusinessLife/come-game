import * as THREE from "/assets/three.module.min.js";

const canvas = document.getElementById("game-room-canvas");
const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (canvas && !reducedMotion) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 14);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.55));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const textureLoader = new THREE.TextureLoader();
  const panels = [];

  const artworks = [
    { url: "/assets/game-room/art-01.webp", aspect: 1.63, x: -7.1, y: 3.15, z: -5.8, size: 3.25, ry: 0.28 },
    { url: "/assets/game-room/art-02.webp", aspect: 1.63, x: 7.0, y: 2.7, z: -6.1, size: 3.28, ry: -0.3 },
    { url: "/assets/game-room/art-03.png", aspect: 0.72, x: -7.9, y: -1.85, z: -6.7, size: 3.85, ry: 0.22, cutout: true },
    { url: "/assets/game-room/art-04.webp", aspect: 1.78, x: 7.6, y: -2.25, z: -6.8, size: 3.2, ry: -0.24 },
    { url: "/assets/game-room/art-05.webp", aspect: 1.67, x: -2.2, y: 5.15, z: -8.4, size: 3.1, ry: 0.08 },
    { url: "/assets/game-room/art-06.webp", aspect: 0.72, x: 2.6, y: -5.05, z: -8.2, size: 4.3, ry: -0.08 },
  ];

  function makePanel(artwork, index) {
    const height = artwork.size;
    const width = height * artwork.aspect;
    const group = new THREE.Group();
    group.position.set(artwork.x, artwork.y, artwork.z);
    group.rotation.set((index - 2.5) * 0.025, artwork.ry, (index - 2.5) * 0.035);

    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      alphaTest: artwork.cutout ? 0.03 : 0,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    group.add(plane);

    if (!artwork.cutout) {
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(width + 0.18, height + 0.18),
        new THREE.MeshBasicMaterial({
          color: index % 2 ? 0x24e5ff : 0xff4d9d,
          transparent: true,
          opacity: 0.07,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      glow.position.z = -0.03;
      group.add(glow);
    }

    textureLoader.load(artwork.url, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
      material.map = texture;
      material.opacity = artwork.cutout ? 0.9 : 0.72;
      material.needsUpdate = true;
    });

    group.userData = {
      base: group.position.clone(),
      phase: index * 0.86,
      speed: 0.08 + index * 0.01,
      floatX: 0.3 + (index % 3) * 0.08,
      floatY: 0.2 + (index % 2) * 0.08,
      rotate: 0.012 + index * 0.002,
    };
    scene.add(group);
    panels.push(group);
  }

  artworks.forEach(makePanel);

  function resize() {
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.z = width < 680 ? 18.5 : 14;
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
    panels.forEach((panel) => {
      const data = panel.userData;
      panel.position.x = data.base.x + Math.sin(t * data.speed + data.phase) * data.floatX;
      panel.position.y = data.base.y + Math.cos(t * data.speed * 0.9 + data.phase) * data.floatY;
      panel.rotation.z += data.rotate * 0.004;
    });
    renderer.render(scene, camera);
    window.CAG_LINK_SCENE_READY = true;
  }

  animate();
}
