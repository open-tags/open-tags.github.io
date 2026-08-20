import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { detectDevice as detectDfu, flash as dfuFlash } from "./dfu.js";

const FT_TO_M = 0.3048;
const IN_PER_FT = 12;
const anchorColors = [0xc7ff3d, 0xf7f9ff, 0xf7f9ff, 0xf7f9ff, 0xf7f9ff];
const presets = {
  2: [
    { id: "A0", role: "master", x: 0.75, y: 0.75, z: 6.75 },
    { id: "A1", role: "slave", x: 9.25, y: 0.75, z: 6.75 },
    { id: "A2", role: "slave", x: 5, y: 9.25, z: 6.75 },
  ],
  3: [
    { id: "A0", role: "master", x: 0.75, y: 0.75, z: 6.75 },
    { id: "A1", role: "slave", x: 9.25, y: 0.75, z: 2 },
    { id: "A2", role: "slave", x: 9.25, y: 9.25, z: 6.75 },
    { id: "A3", role: "slave", x: 0.75, y: 9.25, z: 2 },
  ],
};

const room = { x: 10, y: 10, z: 8 };
let dimensions = 3;
let anchors = presets[dimensions].map((a) => ({ ...a }));
let dataset = [];
let heatmapVisible = true;
let locationPort = null;
let locationReader = null;
let locationWriter = null;
let locationLineBuffer = "";
let liveTruth = { x: 5, y: 5, z: 3 };
let liveMisses = 0;
let liveFixes = 0;
let tdoaBiases = [0, 0, 0, 0];

const $ = (selector) => document.querySelector(selector);
const viewport = $("#tdoa-viewport");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080808);
scene.fog = new THREE.FogExp2(0x080808, 0.036);

const camera = new THREE.PerspectiveCamera(43, 1, 0.02, 250);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.minDistance = 3;
controls.maxDistance = 50;
controls.maxPolarAngle = Math.PI * 0.91;

scene.add(new THREE.HemisphereLight(0xffffff, 0x111111, 1.7));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(6, 12, 4);
scene.add(keyLight);

const roomGroup = new THREE.Group();
const anchorGroup = new THREE.Group();
const heatmapGroup = new THREE.Group();
const dataGroup = new THREE.Group();
scene.add(roomGroup, heatmapGroup, anchorGroup, dataGroup);

function worldPoint(x, y, z) {
  return new THREE.Vector3(x, z, y);
}

function disposeGroup(group) {
  while (group.children.length) {
    const child = group.children.pop();
    child.traverse?.((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach((m) => m.dispose?.());
      else object.material?.dispose?.();
      object.material?.map?.dispose?.();
    });
  }
}

function makeLabel(text, color = "#ffffff") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(0,0,0,.82)";
  ctx.beginPath();
  ctx.roundRect(18, 12, 220, 62, 22);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 44);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(1.55, 0.58, 1);
  return sprite;
}

function buildRoom() {
  disposeGroup(roomGroup);
  const W = room.x;
  const D = room.y;
  const H = room.z;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.86, metalness: 0.08 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, 0, D / 2);
  roomGroup.add(floor);

  const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D) * 2), 0x444444, 0x242424);
  grid.position.set(W / 2, 0.006, D / 2);
  if (W !== D) grid.scale.set(W / Math.max(W, D), 1, D / Math.max(W, D));
  grid.material.transparent = true;
  grid.material.opacity = 0.54;
  roomGroup.add(grid);

  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D)),
    new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.5 })
  );
  box.position.set(W / 2, H / 2, D / 2);
  roomGroup.add(box);

  const wallMaterial = new THREE.MeshBasicMaterial({
    color: 0x333333,
    transparent: true,
    opacity: 0.055,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMaterial);
  back.position.set(W / 2, H / 2, D);
  roomGroup.add(back);
  const side = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMaterial.clone());
  side.rotation.y = Math.PI / 2;
  side.position.set(0, H / 2, D / 2);
  roomGroup.add(side);

  for (let i = 0; i <= Math.ceil(W); i += 1) {
    if (i % 2 !== 0) continue;
    const label = makeLabel(`${i} ft`, "#888888");
    label.scale.set(0.9, 0.34, 1);
    label.position.set(i, 0.18, -0.22);
    roomGroup.add(label);
  }
}

function buildAnchors() {
  disposeGroup(anchorGroup);
  anchors.forEach((anchor, index) => {
    const color = anchorColors[index];
    const position = worldPoint(anchor.x, anchor.y, anchor.z);
    const node = new THREE.Group();
    node.position.copy(position);
    node.userData.pulseIndex = index;

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(index === 0 ? 0.19 : 0.16, 1),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: index === 0 ? 1.9 : 1.15,
        roughness: 0.3,
      })
    );
    node.add(core);

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.23, 0.265, 36),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false })
    );
    halo.rotation.x = Math.PI / 2;
    halo.userData.halo = true;
    node.add(halo);

    const stemGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -anchor.z, 0),
    ]);
    node.add(new THREE.Line(stemGeometry, new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.25, dashSize: 0.14, gapSize: 0.09 })));
    node.children[node.children.length - 1].computeLineDistances();

    const label = makeLabel(index === 0 ? "A0 · MASTER" : anchor.id, index === 0 ? "#c7ff3d" : "#f7f7f7");
    label.position.y = 0.47;
    node.add(label);
    anchorGroup.add(node);
  });

  const master = worldPoint(anchors[0].x, anchors[0].y, anchors[0].z);
  anchors.slice(1).forEach((anchor) => {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([master, worldPoint(anchor.x, anchor.y, anchor.z)]),
      new THREE.LineDashedMaterial({ color: 0xc7ff3d, transparent: true, opacity: 0.18, dashSize: 0.15, gapSize: 0.12 })
    );
    line.computeLineDistances();
    anchorGroup.add(line);
  });
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length < 1e-7) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function inverse3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) return null;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}

function gdopAt(point) {
  const a0 = [anchors[0].x, anchors[0].y, anchors[0].z];
  const u0 = normalize(subtract(point, a0));
  if (!u0) return Infinity;
  const rows = anchors.slice(1).map((anchor) => {
    const ui = normalize(subtract(point, [anchor.x, anchor.y, anchor.z]));
    return ui ? subtract(ui, u0) : null;
  });
  if (rows.some((row) => !row)) return Infinity;
  if (dimensions === 2) {
    let xx = 0, xy = 0, yy = 0;
    rows.forEach((row) => {
      xx += row[0] * row[0];
      xy += row[0] * row[1];
      yy += row[1] * row[1];
    });
    const det = xx * yy - xy * xy;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-10) return Infinity;
    return Math.sqrt((xx + yy) / det);
  }
  const normal = Array(9).fill(0);
  rows.forEach((row) => {
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) normal[r * 3 + c] += row[r] * row[c];
    }
  });
  const inverse = inverse3(normal);
  if (!inverse) return Infinity;
  return Math.sqrt(Math.max(0, inverse[0] + inverse[4] + inverse[8]));
}

function gdopColor(value) {
  const t = THREE.MathUtils.clamp((value - 1.1) / 3.4, 0, 1);
  const color = new THREE.Color();
  if (t < 0.5) color.lerpColors(new THREE.Color(0x5effb1), new THREE.Color(0xffd04f), t * 2);
  else color.lerpColors(new THREE.Color(0xffd04f), new THREE.Color(0xff4f77), (t - 0.5) * 2);
  return color;
}

function geometrySamples() {
  const values = [];
  const zLayers = dimensions === 2 ? 1 : 4;
  for (let iz = 0; iz < zLayers; iz += 1) {
    const z = dimensions === 2 ? Number($("#tdoa-cal-z")?.value || 3) : room.z * (0.18 + iz * 0.19);
    for (let ix = 0; ix < 7; ix += 1) {
      const x = room.x * (0.09 + ix * 0.137);
      for (let iy = 0; iy < 7; iy += 1) {
        const y = room.y * (0.09 + iy * 0.137);
        values.push({ x, y, z, gdop: gdopAt([x, y, z]) });
      }
    }
  }
  return values;
}

function buildHeatmap() {
  disposeGroup(heatmapGroup);
  const samples = geometrySamples();
  const cubeSize = Math.min(room.x, room.y) / 21;
  const geometry = new THREE.BoxGeometry(cubeSize, cubeSize * 0.42, cubeSize);
  samples.forEach((sample) => {
    const material = new THREE.MeshBasicMaterial({
      color: gdopColor(sample.gdop),
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    });
    const cube = new THREE.Mesh(geometry, material);
    cube.position.copy(worldPoint(sample.x, sample.y, sample.z));
    heatmapGroup.add(cube);
  });
  heatmapGroup.visible = heatmapVisible;
  updateGeometryReadout(samples.map((sample) => sample.gdop).filter(Number.isFinite));
}

function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function updateGeometryReadout(values) {
  const centerZ = dimensions === 2 ? Number($("#tdoa-cal-z")?.value || 3) : room.z / 2;
  const center = gdopAt([room.x / 2, room.y / 2, centerZ]);
  const p95 = percentile(values, 0.95);
  const zValues = anchors.map((a) => a.z);
  const spread = Math.max(...zValues) - Math.min(...zValues);
  $("#tdoa-gdop-center").textContent = Number.isFinite(center) ? center.toFixed(2) : "∞";
  $("#tdoa-gdop-p95").textContent = Number.isFinite(p95) ? p95.toFixed(2) : "∞";
  $("#tdoa-z-spread").textContent = `${spread.toFixed(2)} ft`;
  const grade = $("#tdoa-geometry-grade");
  const worstSignal = Math.max(center, p95);
  const verticalOkay = dimensions === 2 || spread >= room.z * 0.35;
  const verticalFair = dimensions === 2 || spread >= room.z * 0.2;
  if (worstSignal < 3 && verticalOkay) {
    grade.textContent = "Good geometry";
    grade.className = "tdoa-grade good";
  } else if (worstSignal < 5 && verticalFair) {
    grade.textContent = "Fair geometry";
    grade.className = "tdoa-grade fair";
  } else {
    grade.textContent = "Weak geometry";
    grade.className = "tdoa-grade poor";
  }
}

function renderAnchorRows() {
  const root = $("#tdoa-anchor-rows");
  root.textContent = "";
  anchors.forEach((anchor, index) => {
    const row = document.createElement("div");
    row.className = "tdoa-anchor-row";
    row.setAttribute("role", "row");
    row.innerHTML = `
      <span class="tdoa-anchor-name ${index === 0 ? "master" : ""}"><i></i>${anchor.id} <small>${anchor.role}</small></span>
      ${["x", "y", "z"].map((axis) => `<input type="number" data-anchor="${index}" data-axis="${axis}" min="0" step="0.05" value="${anchor[axis]}" aria-label="${anchor.id} ${axis.toUpperCase()} coordinate in feet" />`).join("")}
    `;
    root.appendChild(row);
  });
  root.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      const index = Number(input.dataset.anchor);
      const axis = input.dataset.axis;
      const limit = room[axis];
      const value = THREE.MathUtils.clamp(Number(input.value) || 0, 0, limit);
      anchors[index][axis] = value;
      input.value = String(value);
      buildAnchors();
      buildHeatmap();
    });
  });
}

function rebuildAll() {
  buildRoom();
  buildAnchors();
  buildHeatmap();
  buildDatasetView();
}

function resetView() {
  const span = Math.max(room.x, room.y, room.z);
  camera.position.set(room.x * 1.48, room.z * 1.34, room.y * 1.6);
  controls.target.set(room.x / 2, room.z * 0.4, room.y / 2);
  controls.minDistance = span * 0.35;
  controls.maxDistance = span * 5;
  camera.near = Math.max(0.02, span / 1000);
  camera.far = span * 20;
  camera.updateProjectionMatrix();
  controls.update();
}

function resize() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  drawCharts();
}

new ResizeObserver(resize).observe(viewport);

function animate(time) {
  controls.update();
  anchorGroup.children.forEach((node) => {
    if (!node.userData || node.userData.pulseIndex === undefined) return;
    const halo = node.children.find((child) => child.userData?.halo);
    if (!halo) return;
    const phase = time * 0.0018 + node.userData.pulseIndex * 0.85;
    const scale = 1 + (Math.sin(phase) + 1) * 0.28;
    halo.scale.setScalar(scale);
    halo.material.opacity = 0.22 + (Math.sin(phase) + 1) * 0.2;
  });
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function buildDatasetView() {
  disposeGroup(dataGroup);
  const valid = dataset.filter((row) => row.valid);
  if (!valid.length) {
    const truth = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 20, 20),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.2 })
    );
    truth.position.copy(worldPoint(room.x / 2, room.y / 2, room.z * 0.45));
    dataGroup.add(truth);
    return;
  }

  const maxPoints = 800;
  const stride = Math.max(1, Math.ceil(valid.length / maxPoints));
  const sampled = valid.filter((_, index) => index % stride === 0);
  const truthPositions = [];
  const estimatePositions = [];
  const errorLines = [];
  sampled.forEach((row) => {
    const truth = worldPoint(row.trueX, row.trueY, row.trueZ);
    const estimate = worldPoint(row.estX, row.estY, row.estZ);
    truthPositions.push(truth.x, truth.y, truth.z);
    estimatePositions.push(estimate.x, estimate.y, estimate.z);
    errorLines.push(truth.x, truth.y, truth.z, estimate.x, estimate.y, estimate.z);
  });

  const truthGeometry = new THREE.BufferGeometry();
  truthGeometry.setAttribute("position", new THREE.Float32BufferAttribute(truthPositions, 3));
  dataGroup.add(new THREE.Points(truthGeometry, new THREE.PointsMaterial({ color: 0xffffff, size: 0.105, sizeAttenuation: true })));

  const estimateGeometry = new THREE.BufferGeometry();
  estimateGeometry.setAttribute("position", new THREE.Float32BufferAttribute(estimatePositions, 3));
  dataGroup.add(new THREE.Points(estimateGeometry, new THREE.PointsMaterial({ color: 0xff4fb8, size: 0.09, sizeAttenuation: true, transparent: true, opacity: 0.9 })));

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(errorLines, 3));
  dataGroup.add(new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: 0xff4fb8, transparent: true, opacity: 0.16 })));

  const truthPath = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(sampled.map((row) => worldPoint(row.trueX, row.trueY, row.trueZ))),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })
  );
  dataGroup.add(truthPath);
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else value += char;
  }
  values.push(value.trim());
  return values;
}

function parseDataset(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("The CSV needs a header and at least one data row.");
  const header = parseCsvLine(lines[0]).map((key) => key.trim().toLowerCase());
  const required = ["true_x_ft", "true_y_ft", "true_z_ft", "est_x_ft", "est_y_ft", "est_z_ft"];
  const missing = required.filter((key) => !header.includes(key));
  if (missing.length) throw new Error(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  const index = Object.fromEntries(header.map((key, i) => [key, i]));
  const rows = lines.slice(1).map((line, rowIndex) => {
    const values = parseCsvLine(line);
    const number = (key) => Number(values[index[key]]);
    const validRaw = index.valid === undefined ? "1" : String(values[index.valid]).trim().toLowerCase();
    const valid = !["0", "false", "no", "invalid"].includes(validRaw);
    const row = {
      trueX: number("true_x_ft"), trueY: number("true_y_ft"), trueZ: number("true_z_ft"),
      estX: number("est_x_ft"), estY: number("est_y_ft"), estZ: number("est_z_ft"),
      timestamp: index.timestamp_ms === undefined ? NaN : number("timestamp_ms"),
      seq: index.seq === undefined ? NaN : number("seq"),
      rssi: index.rssi_dbm === undefined ? NaN : number("rssi_dbm"),
      valid,
    };
    if ([row.trueX, row.trueY, row.trueZ, row.estX, row.estY, row.estZ].some((n) => !Number.isFinite(n))) {
      throw new Error(`Row ${rowIndex + 2} contains a missing or non-numeric coordinate.`);
    }
    return row;
  });
  return rows;
}

function calculateMetrics() {
  const valid = dataset.filter((row) => row.valid);
  if (!valid.length) return null;
  const errors = valid.map((row) => {
    const dx = row.estX - row.trueX;
    const dy = row.estY - row.trueY;
    const dz = row.estZ - row.trueZ;
    return { dx, dy, dz, horizontal: Math.hypot(dx, dy), vertical: Math.abs(dz), total: Math.hypot(dx, dy, dz) };
  });
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const rms = (values) => Math.sqrt(mean(values.map((value) => value * value)));
  const seqs = dataset.map((row) => row.seq).filter(Number.isFinite);
  let missing = 0;
  for (let i = 1; i < seqs.length; i += 1) {
    const step = (seqs[i] - seqs[i - 1] + 256) % 256;
    if (step > 1 && step < 128) missing += step - 1;
  }
  const timestamps = valid.map((row) => row.timestamp).filter(Number.isFinite);
  const duration = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : NaN;
  return {
    errors,
    rmse: rms(errors.map((e) => e.total)),
    horizontalRmse: rms(errors.map((e) => e.horizontal)),
    verticalRmse: rms(errors.map((e) => e.vertical)),
    median: percentile(errors.map((e) => e.total), 0.5),
    p95: percentile(errors.map((e) => e.total), 0.95),
    biasX: mean(errors.map((e) => e.dx)),
    biasY: mean(errors.map((e) => e.dy)),
    biasZ: mean(errors.map((e) => e.dz)),
    fixRate: dataset.length ? valid.length / dataset.length : 0,
    missing,
    sampleRate: Number.isFinite(duration) && duration > 0 ? (valid.length - 1) * 1000 / duration : NaN,
  };
}

function formatInches(feet) {
  return Number.isFinite(feet) ? `${(feet * IN_PER_FT).toFixed(1)} in` : "—";
}

function updateMetrics() {
  const metrics = calculateMetrics();
  const fields = ["rmse", "hrmse", "vrmse", "p95", "median", "fix"];
  if (!metrics) {
    fields.forEach((field) => { $(`#tdoa-metric-${field}`).textContent = "—"; });
    $("#tdoa-metric-n").textContent = "0 samples";
    $("#tdoa-bias-readout").textContent = "Bias X/Y/Z: —";
    return;
  }
  $("#tdoa-metric-rmse").textContent = formatInches(metrics.rmse);
  $("#tdoa-metric-hrmse").textContent = formatInches(metrics.horizontalRmse);
  $("#tdoa-metric-vrmse").textContent = formatInches(metrics.verticalRmse);
  $("#tdoa-metric-p95").textContent = formatInches(metrics.p95);
  $("#tdoa-metric-median").textContent = formatInches(metrics.median);
  $("#tdoa-metric-fix").textContent = `${(metrics.fixRate * 100).toFixed(1)}%`;
  $("#tdoa-metric-n").textContent = `${dataset.filter((row) => row.valid).length} / ${dataset.length} fixes`;
  $("#tdoa-bias-readout").textContent = `Bias X/Y/Z: ${[metrics.biasX, metrics.biasY, metrics.biasZ].map((v) => `${v >= 0 ? "+" : ""}${(v * IN_PER_FT).toFixed(1)}`).join(" / ")} in`;
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(280, rect.width);
  const height = Math.max(180, rect.height);
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function chartFrame(ctx, width, height, xLabel, yLabel) {
  const pad = { left: 42, right: 12, top: 12, bottom: 30 };
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,.1)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#858585";
  ctx.font = "9px system-ui, sans-serif";
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + ((height - pad.top - pad.bottom) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }
  ctx.fillText(yLabel, 4, pad.top + 7);
  ctx.textAlign = "right";
  ctx.fillText(xLabel, width - pad.right, height - 7);
  ctx.textAlign = "left";
  return pad;
}

function drawHistogram(metrics) {
  const canvas = $("#tdoa-error-chart");
  const { ctx, width, height } = prepareCanvas(canvas);
  const pad = chartFrame(ctx, width, height, "3D error (in)", "fixes");
  if (!metrics) return;
  const values = metrics.errors.map((e) => e.total * IN_PER_FT);
  const max = Math.max(1, percentile(values, 0.99) * 1.08);
  const bins = Array(18).fill(0);
  values.forEach((value) => { bins[Math.min(bins.length - 1, Math.floor((value / max) * bins.length))] += 1; });
  const maxCount = Math.max(...bins, 1);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  bins.forEach((count, index) => {
    const barW = innerW / bins.length;
    const barH = (count / maxCount) * innerH;
    const gradient = ctx.createLinearGradient(0, pad.top + innerH - barH, 0, pad.top + innerH);
    gradient.addColorStop(0, "#c7ff3d");
    gradient.addColorStop(1, "rgba(255,255,255,.35)");
    ctx.fillStyle = gradient;
    ctx.fillRect(pad.left + index * barW + 1, pad.top + innerH - barH, Math.max(1, barW - 2), barH);
  });
  ctx.fillStyle = "#858585";
  ctx.font = "9px system-ui, sans-serif";
  ctx.fillText("0", pad.left, height - 7);
  ctx.textAlign = "right";
  ctx.fillText(max.toFixed(1), width - pad.right, height - 7);
  ctx.textAlign = "left";
}

function drawCdf(metrics) {
  const canvas = $("#tdoa-cdf-chart");
  const { ctx, width, height } = prepareCanvas(canvas);
  const pad = chartFrame(ctx, width, height, "error (in)", "CDF");
  if (!metrics) return;
  const sets = [
    { values: metrics.errors.map((e) => e.total * IN_PER_FT), color: "#c7ff3d", label: "3D" },
    { values: metrics.errors.map((e) => e.horizontal * IN_PER_FT), color: "#f7f7f7", label: "horizontal" },
    { values: metrics.errors.map((e) => e.vertical * IN_PER_FT), color: "#ff4fb8", label: "vertical" },
  ];
  const max = Math.max(1, ...sets.map((set) => percentile(set.values, 0.995) * 1.06));
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  sets.forEach((set, setIndex) => {
    const sorted = [...set.values].sort((a, b) => a - b);
    ctx.strokeStyle = set.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    sorted.forEach((value, index) => {
      const x = pad.left + (Math.min(value, max) / max) * innerW;
      const y = pad.top + innerH - ((index + 1) / sorted.length) * innerH;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = set.color;
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillText(set.label, pad.left + 8 + setIndex * 72, pad.top + 12);
  });
  ctx.fillStyle = "#858585";
  ctx.fillText("0", pad.left, height - 7);
  ctx.textAlign = "right";
  ctx.fillText(max.toFixed(1), width - pad.right, height - 7);
  ctx.textAlign = "left";
}

function drawCharts() {
  const metrics = calculateMetrics();
  drawHistogram(metrics);
  drawCdf(metrics);
}

function applyDataset(rows, label) {
  dataset = rows;
  updateMetrics();
  drawCharts();
  buildDatasetView();
  const metrics = calculateMetrics();
  const rate = metrics && Number.isFinite(metrics.sampleRate) ? ` · ${metrics.sampleRate.toFixed(1)} Hz` : "";
  const missing = metrics?.missing ? ` · ${metrics.missing} missing sequence${metrics.missing === 1 ? "" : "s"}` : "";
  $("#tdoa-import-status").textContent = `${label}: ${rows.filter((r) => r.valid).length} valid of ${rows.length} rows${rate}${missing}. Metrics use unfiltered coordinates.`;
  $("#tdoa-import-status").className = "tdoa-import-status";
  $("#tdoa-view-state").textContent = `${rows.filter((r) => r.valid).length} fixes plotted`;
}

function seededRandom(seedState) {
  seedState.value = (seedState.value * 1664525 + 1013904223) >>> 0;
  return seedState.value / 4294967296;
}

function gaussian(seedState) {
  const u = Math.max(1e-8, seededRandom(seedState));
  const v = seededRandom(seedState);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function exampleDataset() {
  const seed = { value: 0x0a11ce };
  const rows = [];
  for (let i = 0; i < 360; i += 1) {
    const t = i / 359;
    const trueX = room.x * (0.16 + 0.68 * t);
    const trueY = room.y * (0.5 + 0.29 * Math.sin(t * Math.PI * 2));
    const trueZ = room.z * (0.32 + 0.12 * Math.sin(t * Math.PI * 4 + 0.5));
    const edge = Math.max(Math.abs(trueX / room.x - 0.5), Math.abs(trueY / room.y - 0.5));
    const noise = 0.055 + edge * 0.09;
    const outlier = i % 113 === 0 ? 3.2 : 1;
    const valid = i % 71 !== 0;
    rows.push({
      trueX, trueY, trueZ,
      estX: trueX + 0.035 + gaussian(seed) * noise * outlier,
      estY: trueY - 0.022 + gaussian(seed) * noise * outlier,
      estZ: trueZ + 0.06 + gaussian(seed) * noise * 1.35 * outlier,
      timestamp: i * 100,
      seq: i % 256,
      rssi: -69 + gaussian(seed) * 3,
      valid,
    });
  }
  return rows;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function setRoom(nextRoom, resetAnchors = false) {
  const previous = { ...room };
  room.x = THREE.MathUtils.clamp(Number(nextRoom.x) || 10, 6, 100);
  room.y = THREE.MathUtils.clamp(Number(nextRoom.y) || 10, 6, 100);
  room.z = THREE.MathUtils.clamp(Number(nextRoom.z) || 8, 6, 40);
  if (resetAnchors) anchors = presets[dimensions].map((a) => ({ ...a }));
  else {
    anchors.forEach((anchor) => {
      anchor.x = THREE.MathUtils.clamp(anchor.x * room.x / previous.x, 0, room.x);
      anchor.y = THREE.MathUtils.clamp(anchor.y * room.y / previous.y, 0, room.y);
      anchor.z = THREE.MathUtils.clamp(anchor.z * room.z / previous.z, 0, room.z);
    });
  }
  $("#tdoa-room-x").value = room.x;
  $("#tdoa-room-y").value = room.y;
  $("#tdoa-room-z").value = room.z;
  renderAnchorRows();
  rebuildAll();
  resetView();
}

function showFirmwareMode(mode) {
  const location = mode === "location";
  $("#distance-mode").hidden = location;
  $("#location-mode").hidden = !location;
  $("#firmware-mode-distance").classList.toggle("active", !location);
  $("#firmware-mode-location").classList.toggle("active", location);
  $("#firmware-mode-distance").setAttribute("aria-selected", String(!location));
  $("#firmware-mode-location").setAttribute("aria-selected", String(location));
  if (location) setTimeout(() => { resize(); resetView(); drawCharts(); }, 0);
  history.replaceState(null, "", location ? "#location" : "#distance");
}

function setDimensions(next) {
  dimensions = Number(next) === 2 ? 2 : 3;
  anchors = presets[dimensions].map((anchor) => ({ ...anchor }));
  dataset = [];
  try {
    const saved = JSON.parse(localStorage.getItem(`opentags.tdoa.biases.${dimensions}d`) || "null");
    tdoaBiases = Array.isArray(saved) && saved.length === 4 ? saved.map(Number) : [0, 0, 0, 0];
  } catch { tdoaBiases = [0, 0, 0, 0]; }
  $("#tdoa-hardware-count").textContent = `${dimensions === 2 ? 3 : 4} + 1`;
  $("#tdoa-place-title").textContent = `Place ${dimensions === 2 ? "three" : "four"} anchors`;
  $("#tdoa-toggle-heatmap").textContent = dimensions === 2 ? "GDOP plane" : "GDOP volume";
  const a3Option = $("#tdoa-flash-anchor-id option[value='3']");
  a3Option.disabled = dimensions === 2;
  a3Option.hidden = dimensions === 2;
  if (dimensions === 2 && $("#tdoa-flash-anchor-id").value === "3") $("#tdoa-flash-anchor-id").value = "0";
  renderAnchorRows();
  rebuildAll();
  updateMetrics();
  drawCharts();
  resetView();
}

const firmwareCache = new Map();
async function loadFirmware(url) {
  if (firmwareCache.has(url)) return firmwareCache.get(url);
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Firmware download failed (${response.status})`);
  const buffer = await response.arrayBuffer();
  firmwareCache.set(url, buffer);
  return buffer;
}

function findMagic(bytes, magicText) {
  const magic = new TextEncoder().encode(magicText);
  outer: for (let offset = 0; offset <= bytes.length - magic.length; offset += 1) {
    for (let i = 0; i < magic.length; i += 1) if (bytes[offset + i] !== magic[i]) continue outer;
    return offset;
  }
  return -1;
}

function copyFirmware(buffer) {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(new Uint8Array(buffer));
  return bytes;
}

function anchorDistanceMm(index) {
  const a = anchors[index];
  const master = anchors[0];
  return Math.hypot(a.x - master.x, a.y - master.y, a.z - master.z) * FT_TO_M * 1000;
}

function configuredAnchorFirmware(buffer, anchorId) {
  const bytes = copyFirmware(buffer);
  const offset = findMagic(bytes, "OTAG-TDOA-A-V1!!");
  if (offset < 0) throw new Error("Anchor firmware configuration block not found.");
  const view = new DataView(bytes.buffer);
  bytes[offset + 17] = anchorId;
  bytes[offset + 18] = anchors.length;
  view.setInt32(offset + 20, Math.round(anchorDistanceMm(anchorId) / (299_792_458 / 63_897_600)), true);
  view.setUint32(offset + 24, (10 + anchorId * 4) * 1_000_000, true);
  return bytes.buffer;
}

function configuredTagFirmware(buffer) {
  const bytes = copyFirmware(buffer);
  const offset = findMagic(bytes, "OTAG-TDOA-T-V1!!");
  if (offset < 0) throw new Error("Tag firmware configuration block not found.");
  const view = new DataView(bytes.buffer);
  bytes[offset + 17] = anchors.length;
  bytes[offset + 18] = dimensions;
  view.setInt32(offset + 20, Math.round(Number($("#tdoa-cal-z").value) * FT_TO_M * 1000), true);
  for (let index = 0; index < 4; index += 1) {
    const anchor = anchors[index] || { x: 0, y: 0, z: 0 };
    const base = offset + 24 + index * 12;
    view.setInt32(base, Math.round(anchor.x * FT_TO_M * 1000), true);
    view.setInt32(base + 4, Math.round(anchor.y * FT_TO_M * 1000), true);
    view.setInt32(base + 8, Math.round(anchor.z * FT_TO_M * 1000), true);
    view.setInt32(offset + 72 + index * 4, tdoaBiases[index] || 0, true);
  }
  return bytes.buffer;
}

async function flashLocationFirmware(kind) {
  const isAnchor = kind === "anchor";
  const status = $(isAnchor ? "#tdoa-anchor-flash-status" : "#tdoa-tag-status");
  const bar = $(isAnchor ? "#tdoa-anchor-flash-bar" : "#tdoa-tag-flash-bar");
  const button = $(isAnchor ? "#tdoa-flash-anchor" : "#tdoa-flash-tag");
  button.disabled = true;
  bar.style.width = "0%";
  try {
    status.textContent = "Choose the STM32 DFU device…";
    const source = await loadFirmware(isAnchor ? "bins/tdoa_anchor.bin" : "bins/tdoa_tag.bin");
    const anchorId = Number($("#tdoa-flash-anchor-id").value);
    const configured = isAnchor ? configuredAnchorFirmware(source, anchorId) : configuredTagFirmware(source);
    const device = await detectDfu();
    await dfuFlash(device, configured, 0x08000000, (progress) => {
      const percent = Math.round(progress * 100);
      bar.style.width = `${percent}%`;
      status.textContent = `Flashing ${isAnchor ? `A${anchorId}` : "location tag"}… ${percent}%`;
    });
    bar.style.width = "100%";
    status.textContent = `${isAnchor ? `A${anchorId}` : "Location tag"} flashed. Unplug, release BOOT0, and reconnect.`;
  } catch (error) {
    status.textContent = `Flash failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function sendLocationCommand(command) {
  if (!locationWriter) throw new Error("Location tag is not connected.");
  await locationWriter.write(new TextEncoder().encode(`${command}\n`));
}

let liveRenderPending = false;
function scheduleLiveLocationRender() {
  if (liveRenderPending) return;
  liveRenderPending = true;
  setTimeout(() => {
    liveRenderPending = false;
    updateMetrics();
    drawCharts();
    buildDatasetView();
  }, 180);
}

function handleLocationLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === "READY") {
    $("#tdoa-tag-status").textContent = "Connected. Waiting for anchor reports…";
    sendLocationCommand("INFO").catch(() => {});
    return;
  }
  if (parts[0] === "INFO") {
    $("#tdoa-tag-status").textContent = `Connected · ${parts.slice(1).join(" · ")}`;
    return;
  }
  if (parts[0] === "P" && parts.length >= 8) {
    const [seq, xMm, yMm, zMm] = parts.slice(1, 5).map(Number);
    if (![seq, xMm, yMm, zMm].every(Number.isFinite)) return;
    liveTruth = {
      x: Number($("#tdoa-cal-x").value),
      y: Number($("#tdoa-cal-y").value),
      z: Number($("#tdoa-cal-z").value),
    };
    dataset.push({
      trueX: liveTruth.x, trueY: liveTruth.y, trueZ: liveTruth.z,
      estX: xMm / (FT_TO_M * 1000), estY: yMm / (FT_TO_M * 1000), estZ: zMm / (FT_TO_M * 1000),
      timestamp: performance.now(), seq, rssi: NaN, valid: true,
    });
    if (dataset.length > 2000) dataset.shift();
    liveFixes += 1;
    $("#tdoa-view-state").textContent = `Live · ${liveFixes} fixes · ${liveMisses} misses`;
    scheduleLiveLocationRender();
    return;
  }
  if (parts[0] === "MISS") {
    const seq = Number(parts[1]);
    liveMisses += 1;
    dataset.push({
      trueX: Number($("#tdoa-cal-x").value), trueY: Number($("#tdoa-cal-y").value), trueZ: Number($("#tdoa-cal-z").value),
      estX: 0, estY: 0, estZ: 0, timestamp: performance.now(), seq, rssi: NaN, valid: false,
    });
    if (dataset.length > 2000) dataset.shift();
    $("#tdoa-view-state").textContent = `Live · ${liveFixes} fixes · ${liveMisses} misses`;
    scheduleLiveLocationRender();
    return;
  }
  if (parts[0] === "CAL" && parts[1] === "result") {
    const values = parts.slice(2, 5).map(Number);
    if (values.every(Number.isFinite)) {
      tdoaBiases = [0, values[0], values[1], values[2]];
      localStorage.setItem(`opentags.tdoa.biases.${dimensions}d`, JSON.stringify(tdoaBiases));
      $("#tdoa-cal-status").textContent = `Complete · biases A1/A2/A3 = ${values.join(" / ")} DTU. Reflash the tag to make them persistent.`;
    }
    return;
  }
  if (line.startsWith("OK CAL START")) $("#tdoa-cal-status").textContent = "Collecting calibration samples… keep the tag still.";
}

async function readLocationSerial() {
  const decoder = new TextDecoder();
  locationReader = locationPort.readable.getReader();
  try {
    while (true) {
      const { value, done } = await locationReader.read();
      if (done) break;
      locationLineBuffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = locationLineBuffer.indexOf("\n")) >= 0) {
        const line = locationLineBuffer.slice(0, newline).replace(/\r$/, "");
        locationLineBuffer = locationLineBuffer.slice(newline + 1);
        if (line.trim()) handleLocationLine(line);
      }
    }
  } catch (error) {
    if (locationPort) $("#tdoa-tag-status").textContent = `Serial error: ${error.message}`;
  } finally {
    try { locationReader.releaseLock(); } catch {}
    locationReader = null;
  }
}

async function connectLocationTag() {
  if (!("serial" in navigator)) {
    $("#tdoa-tag-status").textContent = "Web Serial requires Chrome or Edge.";
    return;
  }
  try {
    locationPort = await navigator.serial.requestPort();
    await locationPort.open({ baudRate: 115200 });
    locationWriter = locationPort.writable.getWriter();
    $("#tdoa-connect-tag").disabled = true;
    $("#tdoa-disconnect-tag").disabled = false;
    $("#tdoa-cal-start").disabled = false;
    $("#tdoa-tag-status").textContent = "Connected. Starting live location stream…";
    readLocationSerial();
  } catch (error) {
    locationPort = null;
    $("#tdoa-tag-status").textContent = `Connection failed: ${error.message}`;
  }
}

async function disconnectLocationTag() {
  try {
    if (locationReader) await locationReader.cancel().catch(() => {});
    if (locationWriter) { locationWriter.releaseLock(); locationWriter = null; }
    if (locationPort) await locationPort.close().catch(() => {});
  } finally {
    locationPort = null;
    $("#tdoa-connect-tag").disabled = false;
    $("#tdoa-disconnect-tag").disabled = true;
    $("#tdoa-cal-start").disabled = true;
    $("#tdoa-tag-status").textContent = "Disconnected. Only the mobile tag connects to the computer.";
  }
}

setDimensions(3);
resize();
drawCharts();
requestAnimationFrame(animate);

$("#firmware-mode-distance").addEventListener("click", () => showFirmwareMode("distance"));
$("#firmware-mode-location").addEventListener("click", () => showFirmwareMode("location"));
document.querySelectorAll('input[name="tdoa-dimensions"]').forEach((input) => {
  input.addEventListener("change", () => { if (input.checked) setDimensions(input.value); });
});
$("#tdoa-flash-anchor").addEventListener("click", () => flashLocationFirmware("anchor"));
$("#tdoa-flash-tag").addEventListener("click", () => flashLocationFirmware("tag"));
$("#tdoa-connect-tag").addEventListener("click", connectLocationTag);
$("#tdoa-disconnect-tag").addEventListener("click", disconnectLocationTag);
$("#tdoa-cal-start").addEventListener("click", async () => {
  const x = Math.round(Number($("#tdoa-cal-x").value) * FT_TO_M * 1000);
  const y = Math.round(Number($("#tdoa-cal-y").value) * FT_TO_M * 1000);
  const z = Math.round(Number($("#tdoa-cal-z").value) * FT_TO_M * 1000);
  const samples = Math.max(10, Math.min(500, Number($("#tdoa-cal-samples").value) || 100));
  dataset = [];
  liveFixes = 0;
  liveMisses = 0;
  try {
    await sendLocationCommand(`CAL START ${x} ${y} ${z} ${samples}`);
    $("#tdoa-cal-status").textContent = `Starting ${samples}-sample calibration…`;
  } catch (error) {
    $("#tdoa-cal-status").textContent = error.message;
  }
});

$("#tdoa-reset-view").addEventListener("click", resetView);
$("#tdoa-toggle-heatmap").addEventListener("click", (event) => {
  heatmapVisible = !heatmapVisible;
  heatmapGroup.visible = heatmapVisible;
  event.currentTarget.classList.toggle("active", heatmapVisible);
  event.currentTarget.setAttribute("aria-pressed", String(heatmapVisible));
});

$("#tdoa-room-preset").addEventListener("click", () => setRoom({ x: 10, y: 10, z: 8 }, true));
["x", "y", "z"].forEach((axis) => {
  $(`#tdoa-room-${axis}`).addEventListener("change", () => setRoom({
    x: $("#tdoa-room-x").value,
    y: $("#tdoa-room-y").value,
    z: $("#tdoa-room-z").value,
  }));
});

$("#tdoa-import-csv").addEventListener("click", () => $("#tdoa-csv-file").click());
$("#tdoa-csv-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    applyDataset(parseDataset(await file.text()), file.name);
  } catch (error) {
    $("#tdoa-import-status").textContent = error.message;
    $("#tdoa-import-status").className = "tdoa-import-status error";
  } finally {
    event.target.value = "";
  }
});

$("#tdoa-demo").addEventListener("click", () => applyDataset(exampleDataset(), "Example surveyed path"));
$("#tdoa-clear").addEventListener("click", () => {
  dataset = [];
  updateMetrics();
  drawCharts();
  buildDatasetView();
  $("#tdoa-import-status").textContent = "Dataset cleared.";
  $("#tdoa-import-status").className = "tdoa-import-status";
  $("#tdoa-view-state").textContent = "Geometry preview";
});
$("#tdoa-template").addEventListener("click", () => downloadText(
  "opentags-3d-tdoa-template.csv",
  "timestamp_ms,seq,true_x_ft,true_y_ft,true_z_ft,est_x_ft,est_y_ft,est_z_ft,rssi_dbm,valid\n0,0,5.000,5.000,3.000,5.042,4.981,3.067,-68.4,1\n"
));

window.addEventListener("resize", drawCharts);

showFirmwareMode(location.hash === "#location" ? "location" : "distance");
