// opentags web console — two-tag operation over Web Serial + WebUSB DFU.
//
// Two tags plugged in via two USB cables. Each "slot" (A, B) tracks one
// CDC port. The Flash button uses WebUSB to talk to the STM32 ROM bootloader
// (BOOT0 held). Calibration drives both tags: sets one initiator, the other
// responder, captures the responder's distance stream, computes a new
// antenna-delay offset, and writes it back via CALIB.

import { detectDevice as detectDfu, flash as dfuFlash } from "./dfu.js";

// Firmware computes:  dist_mm = tof_dtu × 299_792_458 / 63_897_600  ≈ tof_dtu × 4.69
// So one DTU step in the offset corresponds to ~4.69 mm of reported distance.
const MM_PER_DTU = 299_792_458 / 63_897_600; // ≈ 4.6917

// ─── App state ────────────────────────────────────────────────────────────────
const tags = { A: null, B: null }; // filled with TagConnection
const firmwareCache = new Map();   // url -> ArrayBuffer

// Live distance stream (whichever tag emits D lines)
const samples = []; // {seq, mm, t, src}
const MAX_SAMPLES = 200;
const LIVE_RENDER_INTERVAL_MS = 50;
let paused = false;
let renderPending = false;
let liveMissing = 0;
const liveLastSeq = { A: null, B: null };

// Static test runtime
const DISTANCE_UNITS = {
  ft: 304.8,
  in: 25.4,
  m: 1000,
  cm: 10,
  mm: 1,
};
let testActive = false;
let testTimer = null;
let testStatusTimer = null;
let testStartPerf = 0;
let testStartWall = null;
let testTargetMs = 0;
let testInputDistance = 0;
let testInputUnit = "ft";
let testTrueMm = 0;
let testSamples = [];
let testLastSummary = null;
let testRunningStats = null;
let testMissingSamples = 0;
let testFirstSamplePerf = null;
let testLastSamplePerf = null;
let testLastSeq = { A: null, B: null };

// Calibration runtime
let calibActive = false;
let calibTarget = 0;
let calibNeeded = 0;
let calibCollected = [];
let calibRespSlot = null;

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

async function loadFirmware(url) {
  if (firmwareCache.has(url)) return firmwareCache.get(url);
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  firmwareCache.set(url, buf);
  return buf;
}

// ─── Calibration persistence ──────────────────────────────────────────────────
const CALIB_KEY_PREFIX = "opentag.calib_offset_dtu.v2.";
const CALIB_MAGIC = "OTAG-CALIB-DEF\0\0";

function savedCalib(deviceId) {
  if (!deviceId) return null;
  const v = localStorage.getItem(CALIB_KEY_PREFIX + deviceId);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function rememberCalib(deviceId, n) {
  if (deviceId) localStorage.setItem(CALIB_KEY_PREFIX + deviceId, String(n));
}

// Find the CALIB_MAGIC byte sequence in the .bin and overwrite the i32
// (LE) immediately after it with `offset`. Returns a NEW ArrayBuffer.
function patchFirmware(buf, offset) {
  const src = new Uint8Array(buf);
  const magic = new TextEncoder().encode(CALIB_MAGIC);
  let pos = -1;
  outer: for (let i = 0; i + magic.length + 4 <= src.length; i++) {
    for (let j = 0; j < magic.length; j++) {
      if (src[i + j] !== magic[j]) continue outer;
    }
    pos = i;
    break;
  }
  if (pos < 0) return null;
  const out = new Uint8Array(src.length);
  out.set(src);
  const dv = new DataView(out.buffer);
  dv.setInt32(pos + magic.length, offset, /*littleEndian=*/ true);
  return out.buffer;
}

// ─── Per-slot connection ──────────────────────────────────────────────────────
class TagConnection {
  constructor(slot, root) {
    this.slot = slot;       // "A" or "B"
    this.root = root;       // .panel.tag element
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readLoopP = null;
    this.lineBuf = "";
    this.mode = "—";
    this.calib = null;
    this.fw = "—";
    this.id = null;
    this.targetHz = null;
    this.drops = null;
    this.logLines = [];

    $(".connect-btn", root).addEventListener("click", () => this.connect());
    $(".disconnect-btn", root).addEventListener("click", () => this.disconnect());
    $(".info-btn", root).addEventListener("click", () => this.send("INFO"));
    $$(".flash-btn", root).forEach((b) =>
      b.addEventListener("click", () => this.flash(b.dataset.fw, b.textContent.trim()))
    );
  }

  log(msg) {
    const pre = $(".tag-log", this.root);
    const ts = new Date().toLocaleTimeString();
    this.logLines.push(`[${ts}] ${msg}`);
    if (this.logLines.length > 200) this.logLines.shift();
    pre.textContent = this.logLines.join("\n") + "\n";
    pre.scrollTop = pre.scrollHeight;
  }

  setStatus(text, cls) {
    const pill = $(".status-pill", this.root);
    pill.textContent = text;
    pill.className = "status-pill " + (cls ?? "");
  }

  setButtons() {
    const connected = !!this.port;
    $(".connect-btn", this.root).disabled = connected;
    $(".disconnect-btn", this.root).disabled = !connected;
    $(".info-btn", this.root).disabled = !connected;
    refreshGlobalButtons();
  }

  setModeIndicator(mode) {
    this.mode = mode;
    $(".info-mode", this.root).textContent = mode;
  }

  async connect() {
    if (!("serial" in navigator)) {
      alert("Web Serial is unavailable. Use Chrome or Edge.");
      return;
    }
    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 115200 });
      this.writer = this.port.writable.getWriter();
      this.setStatus("Connected", "connected");
      this.setButtons();
      this.log("Port opened");
      this.readLoopP = this.readLoop();
      setTimeout(() => this.send("INFO"), 200);
    } catch (e) {
      this.log(`Connect failed: ${e.message}`);
      this.port = null;
      this.setStatus("Disconnected", "");
      this.setButtons();
    }
  }

  async disconnect() {
    try {
      if (this.reader) await this.reader.cancel().catch(() => {});
      if (this.writer) { try { this.writer.releaseLock(); } catch {} }
      if (this.readLoopP) await this.readLoopP.catch(() => {});
      if (this.port) await this.port.close().catch(() => {});
    } finally {
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.readLoopP = null;
      this.setStatus("Disconnected", "");
      this.setModeIndicator("—");
      $(".info-calib", this.root).textContent = "—";
      $(".info-fw", this.root).textContent = "—";
      this.setButtons();
      this.log("Disconnected");
    }
  }

  async send(line) {
    if (!this.writer) return;
    const enc = new TextEncoder();
    await this.writer.write(enc.encode(line + "\n"));
    this.log(`> ${line}`);
  }

  async readLoop() {
    const dec = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.lineBuf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = this.lineBuf.indexOf("\n")) >= 0) {
          const line = this.lineBuf.slice(0, nl).replace(/\r$/, "").trim();
          this.lineBuf = this.lineBuf.slice(nl + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch (e) {
      this.log(`read err: ${e.message}`);
    } finally {
      try { this.reader.releaseLock(); } catch {}
    }
  }

  handleLine(line) {
    if (line.startsWith("D ")) {
      const m = line.match(/^D\s+(-?\d+)\s+(-?\d+)(?:\s+(\d+))?/);
      if (m) {
        onDistance(
          this.slot,
          parseInt(m[1], 10),
          parseInt(m[2], 10),
          m[3] === undefined ? null : parseInt(m[3], 10)
        );
      }
      return;
    }

    this.log(`< ${line}`);

    if (line === "READY") {
      this.send("INFO");
      return;
    }
    if (line.startsWith("INFO ")) {
      const kv = Object.fromEntries(
        line.slice(5).split(/\s+/).map((p) => p.split("="))
          .filter((p) => p.length === 2)
      );
      if (kv.mode) this.setModeIndicator(kv.mode);
      if (kv.calib !== undefined) {
        this.calib = parseInt(kv.calib, 10);
        $(".info-calib", this.root).textContent = this.calib;
      }
      if (kv.fw) {
        this.fw = kv.fw;
        $(".info-fw", this.root).textContent = kv.fw;
      }
      if (kv.id) {
        this.id = kv.id;
        $(".info-id", this.root).textContent = kv.id.slice(-8);
      }
      if (kv.target_hz) {
        this.targetHz = parseFloat(kv.target_hz);
        $(".info-target", this.root).textContent = kv.target_hz;
      }
      if (kv.drops !== undefined) {
        this.drops = parseInt(kv.drops, 10);
        $(".info-drops", this.root).textContent = kv.drops;
      }
      if (this.mode === "R" && this.id && this.calib !== null) {
        const saved = savedCalib(this.id);
        if (saved !== null && saved !== this.calib) this.send(`CALIB ${saved}`);
      }
      return;
    }
    if (line.startsWith("OK CALIB ")) {
      this.calib = parseInt(line.slice(9).trim(), 10);
      $(".info-calib", this.root).textContent = this.calib;
      rememberCalib(this.id, this.calib);
      this.log(`Saved calib=${this.calib} for ${this.id ?? "unknown device"}`);
      return;
    }
    // ERR / MISS / PONG / unknown — already in log
  }

  async flash(fwUrl, label) {
    if (this.port) {
      const ok = confirm(
        `Slot ${this.slot} is connected as serial. Disconnect, hold BOOT0, ` +
        `replug, then click Flash. Disconnect now?`
      );
      if (!ok) return;
      await this.disconnect();
      return;
    }
    const prog = $(".flash-progress", this.root);
    const bar = $(".bar", prog);
    const msg = $(".msg", prog);
    prog.classList.add("active");
    bar.style.setProperty("--p", "0%");
    msg.textContent = `Loading ${label}…`;
    this.setStatus("Flashing", "dfu");
    this.log(`Flashing ${label} from ${fwUrl}`);

    try {
      let fw = await loadFirmware(fwUrl);
      // If this firmware contains the CALIB magic and we have a saved
      // calibration, patch the bin in-flight so the new image boots with
      // the user's last-calibrated offset.
      const saved = savedCalib(this.id);
      if (saved !== null) {
        const patched = patchFirmware(fw, saved);
        if (patched) {
          fw = patched;
          this.log(`Patched ${label} with saved calib=${saved}`);
        }
      }
      msg.textContent = `${label} (${(fw.byteLength / 1024).toFixed(1)} KB) — Pick DFU device`;
      const dev = await detectDfu();
      msg.textContent = `Device opened — ${dev.productName ?? "STM32 DFU"}`;
      await dfuFlash(
        dev,
        fw,
        0x08000000,
        (p) => {
          bar.style.setProperty("--p", `${(p * 100).toFixed(1)}%`);
          msg.textContent = `Flashing ${label}… ${(p * 100).toFixed(1)}%`;
        },
        (m) => this.log(`DFU ${m}`)
      );
      bar.style.setProperty("--p", "100%");
      msg.textContent = `${label} done. Unplug, release BOOT0, replug.`;
      this.setStatus("Flashed", "connected");
    } catch (e) {
      this.log(`DFU error: ${e.message}`);
      msg.textContent = `Error: ${e.message}`;
      this.setStatus("Error", "error");
    }
  }
}

// ─── Distance pipeline ────────────────────────────────────────────────────────
function sequenceGap(previous, current) {
  if (previous === null) return 0;
  const advance = (current - previous + 256) % 256;
  return advance > 1 && advance < 128 ? advance - 1 : 0;
}

function onDistance(slot, seq, mm, exchangeUs) {
  const now = performance.now();
  liveMissing += sequenceGap(liveLastSeq[slot], seq);
  liveLastSeq[slot] = seq;
  if (!paused) {
    samples.push({ seq, mm, t: now, src: slot, exchangeUs });
    if (samples.length > MAX_SAMPLES) samples.shift();
    scheduleLiveRender();
  }
  if (testActive) recordTestSample(slot, seq, mm, exchangeUs, now);
  if (calibActive && slot === calibRespSlot) {
    calibCollected.push(mm);
    $("#cal-status").textContent =
      `Collecting… ${calibCollected.length} / ${calibNeeded}`;
    if (calibCollected.length >= calibNeeded) finishCalibration();
  }
}

function scheduleLiveRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => {
    requestAnimationFrame(() => {
      renderPending = false;
      drawChart();
      updateStats();
    });
  }, LIVE_RENDER_INTERVAL_MS);
}

function updateStats() {
  if (samples.length === 0) {
    $("#stat-last").textContent = "—";
    $("#stat-mean").textContent = "—";
    $("#stat-std").textContent = "—";
    $("#stat-rate").textContent = "—";
    $("#stat-missing").textContent = String(liveMissing);
    $("#stat-n").textContent = "0";
    return;
  }
  const xs = samples.map((s) => s.mm);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  $("#stat-last").textContent = xs[xs.length - 1].toFixed(0);
  $("#stat-mean").textContent = mean.toFixed(0);
  $("#stat-std").textContent = Math.sqrt(variance).toFixed(0);
  const elapsedMs = samples[xs.length - 1].t - samples[0].t;
  const rateHz = elapsedMs > 0 ? (samples.length - 1) * 1000 / elapsedMs : NaN;
  $("#stat-rate").textContent = formatMetric(rateHz, 1);
  $("#stat-missing").textContent = String(liveMissing);
  $("#stat-n").textContent = String(xs.length);
}

function summarizeValues(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return {
    n: xs.length,
    mean,
    stdev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentileSorted(sorted, 0.5),
    p95: percentileSorted(sorted, 0.95),
  };
}

function percentileSorted(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

function formatMetric(v, digits = 1) {
  return Number.isFinite(v) ? v.toFixed(digits) : "-";
}

function escapeCsv(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values) {
  return values.map(escapeCsv).join(",");
}

// ─── Tiny canvas chart ────────────────────────────────────────────────────────
const canvas = $("#chart");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}
window.addEventListener("resize", resizeCanvas);

function drawChart() {
  const rect = canvas.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const padL = 56, padR = 10, padT = 10, padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, innerW, innerH);

  if (samples.length === 0) {
    ctx.fillStyle = "#777";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText(
      "Waiting for distance samples — set one tag I, the other R…",
      padL + 8,
      padT + 18
    );
    return;
  }

  const xs = samples.map((s) => s.mm);
  let lo = Math.min(...xs);
  let hi = Math.max(...xs);
  if (hi === lo) { lo -= 100; hi += 100; }
  const span = hi - lo;
  lo -= span * 0.1;
  hi += span * 0.1;

  ctx.fillStyle = "#777";
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * (1 - i / 4);
    const y = padT + (innerH * i) / 4;
    ctx.fillText(v.toFixed(0), padL - 6, y + 4);
    ctx.strokeStyle = "#0f0f0f";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + innerW, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#C1FF43";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = padL + (i / (MAX_SAMPLES - 1)) * innerW;
    const y = padT + ((hi - samples[i].mm) / (hi - lo)) * innerH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const last = samples[samples.length - 1];
  const lx = padL + ((samples.length - 1) / (MAX_SAMPLES - 1)) * innerW;
  const ly = padT + ((hi - last.mm) / (hi - lo)) * innerH;
  ctx.fillStyle = "#C1FF43";
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = "left";
  ctx.fillStyle = "#777";
  ctx.fillText("mm", 8, padT + 12);
  ctx.fillText(`From ${last.src}`, padL + innerW - 70, padT + 12);
}

// ─── Static test logging ──────────────────────────────────────────────────────
function distanceInputMm() {
  const value = parseFloat($("#test-dist").value);
  const unit = $("#test-unit").value;
  if (!Number.isFinite(value) || value <= 0 || !DISTANCE_UNITS[unit]) return NaN;
  return value * DISTANCE_UNITS[unit];
}

function updateTestDistanceDisplay() {
  const mm = distanceInputMm();
  $("#test-dist-mm").textContent = Number.isFinite(mm) ? mm.toFixed(0) : "-";
}

function startStaticTest() {
  if (!tags.A.port && !tags.B.port) {
    setTestStatus("error", "Connect at least one tag before starting a test.");
    return;
  }

  const trueMm = distanceInputMm();
  const durationMin = parseFloat($("#test-duration").value);
  if (!Number.isFinite(trueMm) || trueMm <= 0 || !Number.isFinite(durationMin) || durationMin <= 0) {
    setTestStatus("error", "Enter a positive distance and duration.");
    return;
  }

  if (testTimer) clearTimeout(testTimer);
  testActive = true;
  testStartPerf = performance.now();
  testStartWall = new Date();
  testTargetMs = durationMin * 60_000;
  testInputDistance = parseFloat($("#test-dist").value);
  testInputUnit = $("#test-unit").value;
  testTrueMm = trueMm;
  testSamples = [];
  testLastSummary = null;
  testRunningStats = { n: 0, mean: 0, m2: 0 };
  testMissingSamples = 0;
  testFirstSamplePerf = null;
  testLastSamplePerf = null;
  testLastSeq = { A: null, B: null };

  $("#test-start").disabled = true;
  $("#test-stop").disabled = false;
  $("#test-download").disabled = true;
  testTimer = setTimeout(() => finishStaticTest("done"), testTargetMs);
  testStatusTimer = setInterval(updateTestStatus, 1000);
  updateTestStatus();
}

function stopStaticTest() {
  if (!testActive) return;
  finishStaticTest("stopped");
}

function finishStaticTest(reason) {
  testActive = false;
  if (testTimer) clearTimeout(testTimer);
  if (testStatusTimer) clearInterval(testStatusTimer);
  testTimer = null;
  testStatusTimer = null;
  testLastSummary = computeTestSummary();
  $("#test-stop").disabled = true;
  $("#test-download").disabled = testSamples.length === 0;
  refreshGlobalButtons();

  const prefix = reason === "done" ? "Done" : "Stopped";
  if (!testLastSummary) {
    setTestStatus(reason, `${prefix}: no samples collected.`);
    return;
  }
  setTestStatus(
    reason,
    `${prefix}: N=${testLastSummary.n}  Mean error=${formatMetric(testLastSummary.meanErrorMm)} mm  ` +
      `Stdev=${formatMetric(testLastSummary.stdevMm)} mm`
  );
}

function recordTestSample(slot, seq, mm, exchangeUs, now) {
  const elapsedMs = now - testStartPerf;
  const wall = new Date(testStartWall.getTime() + elapsedMs);
  const errorMm = mm - testTrueMm;
  testSamples.push({
    elapsedMs,
    timestamp: wall.toISOString(),
    seq,
    src: slot,
    measuredMm: mm,
    trueMm: testTrueMm,
    errorMm,
    errorCm: errorMm / 10,
    errorIn: errorMm / 25.4,
    exchangeUs,
  });
  if (testFirstSamplePerf === null) testFirstSamplePerf = now;
  testLastSamplePerf = now;
  testMissingSamples += sequenceGap(testLastSeq[slot], seq);
  testLastSeq[slot] = seq;
  testRunningStats.n += 1;
  const delta = errorMm - testRunningStats.mean;
  testRunningStats.mean += delta / testRunningStats.n;
  testRunningStats.m2 += delta * (errorMm - testRunningStats.mean);
}

function computeTestSummary() {
  if (testSamples.length === 0) return null;
  const measured = testSamples.map((s) => s.measuredMm);
  const errors = testSamples.map((s) => s.errorMm);
  const absErrors = errors.map(Math.abs);
  const measuredSummary = summarizeValues(measured);
  const errorSummary = summarizeValues(errors);
  const absErrorSummary = summarizeValues(absErrors);
  const exchanges = testSamples.map((s) => s.exchangeUs).filter(Number.isFinite);
  const rmse = Math.sqrt(errors.reduce((sum, e) => sum + e ** 2, 0) / errors.length);
  const sampleElapsedMs = testLastSamplePerf - testFirstSamplePerf;
  const actualRateHz = sampleElapsedMs > 0 ? (testSamples.length - 1) * 1000 / sampleElapsedMs : NaN;
  const expectedSamples = testSamples.length + testMissingSamples;
  return {
    n: testSamples.length,
    meanMeasuredMm: measuredSummary.mean,
    meanErrorMm: errorSummary.mean,
    stdevMm: errorSummary.stdev,
    minMeasuredMm: measuredSummary.min,
    maxMeasuredMm: measuredSummary.max,
    p50AbsErrorMm: absErrorSummary.p50,
    p95AbsErrorMm: absErrorSummary.p95,
    rmseMm: rmse,
    actualRateHz,
    missingSamples: testMissingSamples,
    packetSuccessPct: expectedSamples > 0 ? 100 * testSamples.length / expectedSamples : NaN,
    meanExchangeUs: exchanges.length ? summarizeValues(exchanges).mean : NaN,
    p95ExchangeUs: exchanges.length ? summarizeValues(exchanges).p95 : NaN,
  };
}

function updateTestStatus() {
  if (!testActive) return;
  const elapsed = performance.now() - testStartPerf;
  const stats = testRunningStats;
  const stdev = stats?.n ? Math.sqrt(stats.m2 / stats.n) : NaN;
  const rate = testFirstSamplePerf !== null && testLastSamplePerf > testFirstSamplePerf
    ? (stats.n - 1) * 1000 / (testLastSamplePerf - testFirstSamplePerf)
    : NaN;
  const body = stats?.n
    ? `N=${stats.n}  Mean error=${formatMetric(stats.mean)} mm  Stdev=${formatMetric(stdev)} mm  Rate=${formatMetric(rate)} Hz  Missing=${testMissingSamples}`
    : "N=0  Waiting for distance samples";
  setTestStatus(
    "running",
    `Running ${formatMetric(elapsed / 1000, 1)}s / ${formatMetric(testTargetMs / 1000, 1)}s  ${body}`
  );
}

function setTestStatus(cls, text) {
  const el = $("#test-status");
  el.className = "test-status " + (cls ?? "");
  el.textContent = text;
}

function downloadStaticTestCsv() {
  if (testSamples.length === 0) return;
  const summary = testLastSummary ?? computeTestSummary();
  const lines = [
    csvRow(["section", "field", "value"]),
    csvRow(["metadata", "start_time", testStartWall.toISOString()]),
    csvRow(["metadata", "duration_target_ms", testTargetMs.toFixed(0)]),
    csvRow(["metadata", "distance_input", testInputDistance]),
    csvRow(["metadata", "distance_unit", testInputUnit]),
    csvRow(["metadata", "true_distance_mm", testTrueMm.toFixed(1)]),
    csvRow(["metadata", "sample_count", testSamples.length]),
    csvRow(["metadata", "tag_a_id", tags.A?.id ?? ""]),
    csvRow(["metadata", "tag_a_fw", tags.A?.fw ?? ""]),
    csvRow(["metadata", "tag_b_id", tags.B?.id ?? ""]),
    csvRow(["metadata", "tag_b_fw", tags.B?.fw ?? ""]),
    csvRow(["metadata", "responder_calib_dtu", tags.A?.mode === "R" ? tags.A.calib : tags.B?.calib]),
    csvRow(["metadata", "target_rate_hz", tags.A?.targetHz ?? tags.B?.targetHz ?? ""]),
    csvRow(["metadata", "tag_a_output_drops", tags.A?.drops ?? ""]),
    csvRow(["metadata", "tag_b_output_drops", tags.B?.drops ?? ""]),
    "",
    csvRow(["section", "metric", "value", "unit"]),
    csvRow(["summary", "mean_measured", formatMetric(summary.meanMeasuredMm), "mm"]),
    csvRow(["summary", "mean_error", formatMetric(summary.meanErrorMm), "mm"]),
    csvRow(["summary", "stdev_error", formatMetric(summary.stdevMm), "mm"]),
    csvRow(["summary", "min_measured", formatMetric(summary.minMeasuredMm), "mm"]),
    csvRow(["summary", "max_measured", formatMetric(summary.maxMeasuredMm), "mm"]),
    csvRow(["summary", "p50_abs_error", formatMetric(summary.p50AbsErrorMm), "mm"]),
    csvRow(["summary", "p95_abs_error", formatMetric(summary.p95AbsErrorMm), "mm"]),
    csvRow(["summary", "rmse", formatMetric(summary.rmseMm), "mm"]),
    csvRow(["summary", "actual_rate", formatMetric(summary.actualRateHz, 3), "Hz"]),
    csvRow(["summary", "missing_sequences", summary.missingSamples, "count"]),
    csvRow(["summary", "packet_success", formatMetric(summary.packetSuccessPct, 3), "percent"]),
    csvRow(["summary", "mean_exchange", formatMetric(summary.meanExchangeUs), "us"]),
    csvRow(["summary", "p95_exchange", formatMetric(summary.p95ExchangeUs), "us"]),
    "",
    csvRow(["elapsed_ms", "timestamp_iso", "seq", "src", "measured_mm", "true_mm", "error_mm", "error_cm", "error_in", "exchange_us"]),
  ];

  for (const s of testSamples) {
    lines.push(csvRow([
      s.elapsedMs.toFixed(1),
      s.timestamp,
      s.seq,
      s.src,
      s.measuredMm,
      s.trueMm.toFixed(1),
      s.errorMm.toFixed(1),
      s.errorCm.toFixed(2),
      s.errorIn.toFixed(3),
      s.exchangeUs ?? "",
    ]));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `opentags-static-${testInputDistance}${testInputUnit}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ─── Calibration ──────────────────────────────────────────────────────────────
async function startCalibration() {
  const respSlot = document.querySelector('input[name="cal-resp"]:checked').value;
  const resp = tags[respSlot];

  if (!tags.A.port || !tags.B.port) {
    setCalStatus("error", `Both slots must be connected (A: ${!!tags.A.port}, B: ${!!tags.B.port})`);
    return;
  }
  if (resp.calib === null) {
    setCalStatus("error", `Slot ${respSlot} hasn't reported calib yet — press its INFO`);
    return;
  }

  calibTarget = parseInt($("#cal-dist").value, 10);
  calibNeeded = parseInt($("#cal-n").value, 10);
  if (!isFinite(calibTarget) || calibTarget <= 0 || !isFinite(calibNeeded) || calibNeeded < 10) {
    setCalStatus("error", "Bad inputs");
    return;
  }

  calibCollected = [];
  calibRespSlot = respSlot;
  calibActive = true;
  $("#cal-start").disabled = true;
  setCalStatus("running", `Collecting 0 / ${calibNeeded}…`);
}

function finishCalibration() {
  calibActive = false;
  $("#cal-start").disabled = false;

  const sorted = [...calibCollected].sort((a, b) => a - b);
  const n = sorted.length;
  const trimmed = sorted.slice(Math.floor(n * 0.1), Math.ceil(n * 0.9));
  const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

  const resp = tags[calibRespSlot];
  const delta = (mean - calibTarget) / MM_PER_DTU;
  const newOffset = Math.round(resp.calib + delta);

  setCalStatus(
    "done",
    `Slot ${calibRespSlot}: Mean=${mean.toFixed(1)} mm  True=${calibTarget} mm  ` +
      `Δ=${delta.toFixed(1)} dtu  →  calib=${newOffset} (was ${resp.calib})`
  );
  resp.send(`CALIB ${newOffset}`);
}

function setCalStatus(cls, text) {
  const el = $("#cal-status");
  el.className = "cal-status " + (cls ?? "");
  el.textContent = text;
}

// ─── Wire-up ──────────────────────────────────────────────────────────────────
function refreshGlobalButtons() {
  const anyConnected = !!(tags.A?.port || tags.B?.port);
  const bothConnected = !!(tags.A?.port && tags.B?.port);
  $("#pause").disabled = !anyConnected;
  $("#clear").disabled = !anyConnected;
  $("#export").disabled = !anyConnected;
  $("#test-start").disabled = !anyConnected || testActive;
  $("#test-stop").disabled = !testActive;
  $("#cal-start").disabled = !bothConnected || calibActive;
}


$("#pause").addEventListener("click", () => {
  paused = !paused;
  $("#pause").textContent = paused ? "Resume" : "Pause";
});

$("#clear").addEventListener("click", () => {
  samples.length = 0;
  liveMissing = 0;
  liveLastSeq.A = null;
  liveLastSeq.B = null;
  drawChart();
  updateStats();
});

$("#export").addEventListener("click", () => {
  if (samples.length === 0) return;
  const t0 = samples[0].t;
  const lines = ["t_ms,seq,mm,src"];
  for (const s of samples) {
    lines.push(`${(s.t - t0).toFixed(1)},${s.seq},${s.mm},${s.src}`);
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `opentags-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
});

$("#test-dist").addEventListener("input", updateTestDistanceDisplay);
$("#test-unit").addEventListener("change", updateTestDistanceDisplay);
$("#test-start").addEventListener("click", startStaticTest);
$("#test-stop").addEventListener("click", stopStaticTest);
$("#test-download").addEventListener("click", downloadStaticTestCsv);
$("#cal-start").addEventListener("click", startCalibration);

tags.A = new TagConnection("A", $('.tag[data-slot="A"]'));
tags.B = new TagConnection("B", $('.tag[data-slot="B"]'));
tags.A.setButtons();
tags.B.setButtons();
updateTestDistanceDisplay();
resizeCanvas();
