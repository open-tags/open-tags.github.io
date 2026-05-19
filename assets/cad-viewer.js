import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const viewerEls = [...document.querySelectorAll(".cad-viewer")];

if (viewerEls.length) {
  initCadViewers().catch((error) => {
    viewerEls.forEach((viewer) => setStatus(viewer, `viewer unavailable: ${error.message}`));
  });
}

async function initCadViewers() {
  if (!window.occtimportjs) {
    throw new Error("STEP importer failed to load");
  }

  const occt = await window.occtimportjs();
  await Promise.all(viewerEls.map((viewer) => initViewer(viewer, occt)));
}

async function initViewer(viewer, occt) {
  const canvasHost = viewer.querySelector(".viewer-canvas");
  const status = viewer.querySelector(".viewer-status");
  const stepUrl = viewer.dataset.stepUrl;
  const label = viewer.dataset.label;
  const transparentMode = viewer.dataset.transparent || "";

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvasHost.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100000);
  camera.up.set(0, 0, 1);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.65;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x171717, 2.4));

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, -4, 6);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xb8ff36, 0.8);
  fill.position.set(-5, 4, 3);
  scene.add(fill);

  const model = await loadStepModel(stepUrl, occt, transparentMode);
  scene.add(model);
  frameModel(model, camera, controls);
  setStatus(viewer, `${label} loaded`);

  const resize = () => {
    const rect = canvasHost.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvasHost);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  status.dataset.ready = "true";
}

async function loadStepModel(url, occt, transparentMode) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  const fileBuffer = new Uint8Array(await response.arrayBuffer());
  const result = occt.ReadStepFile(fileBuffer, null);
  if (!result?.meshes?.length) {
    throw new Error(`no meshes in ${url}`);
  }

  const group = new THREE.Group();

  for (const resultMesh of result.meshes) {
    const mesh = buildMesh(resultMesh, transparentMode);
    group.add(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 32),
      new THREE.LineBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.38 })
    );
    group.add(edges);
  }

  return group;
}

function buildMesh(resultMesh, transparentMode) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(resultMesh.attributes.position.array, 3)
  );

  if (resultMesh.attributes.normal) {
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(resultMesh.attributes.normal.array, 3)
    );
  } else {
    geometry.computeVertexNormals();
  }

  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(resultMesh.index.array), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const isTransparent = shouldMakeTransparent(resultMesh, transparentMode);
  const color = resultMesh.color
    ? new THREE.Color(resultMesh.color[0], resultMesh.color[1], resultMesh.color[2])
    : new THREE.Color(0x4a4a4a);

  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color,
      metalness: 0.12,
      roughness: 0.52,
      transparent: isTransparent,
      opacity: isTransparent ? 0.28 : 1,
      depthWrite: !isTransparent,
      side: THREE.DoubleSide
    })
  );
}

function shouldMakeTransparent(resultMesh, transparentMode) {
  if (transparentMode === "all") return true;
  if (transparentMode !== "lid") return false;

  const meshName = [
    resultMesh.name,
    resultMesh.brep_name,
    resultMesh.product_name,
    resultMesh.face_name
  ].filter(Boolean).join(" ").toLowerCase();

  return meshName.includes("lid");
}

function frameModel(model, camera, controls) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z);
  const distance = maxSize / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));

  model.position.sub(center);
  camera.position.set(distance * 0.9, distance * -1.25, distance * 0.78);
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.minDistance = distance * 0.25;
  controls.maxDistance = distance * 5;
  controls.update();
}

function setStatus(viewer, text) {
  viewer.querySelector(".viewer-status").textContent = text;
}
