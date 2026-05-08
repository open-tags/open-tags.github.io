// OpenTag web console — two-tag operation over Web Serial + WebUSB DFU.
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
let paused = false;

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
const CALIB_KEY = "opentag.calib_offset_dtu";
const CALIB_MAGIC = "OTAG-CALIB-DEF\0\0";

function savedCalib() {
  const v = localStorage.getItem(CALIB_KEY);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function rememberCalib(n) {
  localStorage.setItem(CALIB_KEY, String(n));
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
    pre.textContent += `[${ts}] ${msg}\n`;
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
      this.setStatus("connected", "connected");
      this.setButtons();
      this.log("port opened");
      this.readLoopP = this.readLoop();
      setTimeout(() => this.send("INFO"), 200);
    } catch (e) {
      this.log(`connect failed: ${e.message}`);
      this.port = null;
      this.setStatus("disconnected", "");
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
      this.setStatus("disconnected", "");
      this.setModeIndicator("—");
      $(".info-calib", this.root).textContent = "—";
      $(".info-fw", this.root).textContent = "—";
      this.setButtons();
      this.log("disconnected");
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
      return;
    }
    if (line.startsWith("OK CALIB ")) {
      this.calib = parseInt(line.slice(9).trim(), 10);
      $(".info-calib", this.root).textContent = this.calib;
      rememberCalib(this.calib);
      this.log(`saved calib=${this.calib} to local storage`);
      return;
    }
    if (line.startsWith("D ")) {
      const m = line.match(/^D\s+(-?\d+)\s+(-?\d+)/);
      if (!m) return;
      onDistance(this.slot, parseInt(m[1], 10), parseInt(m[2], 10));
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
    msg.textContent = `loading ${label}…`;
    this.setStatus("flashing", "dfu");
    this.log(`flashing ${label} from ${fwUrl}`);

    try {
      let fw = await loadFirmware(fwUrl);
      // If this firmware contains the CALIB magic and we have a saved
      // calibration, patch the bin in-flight so the new image boots with
      // the user's last-calibrated offset.
      const saved = savedCalib();
      if (saved !== null) {
        const patched = patchFirmware(fw, saved);
        if (patched) {
          fw = patched;
          this.log(`patched ${label} with saved calib=${saved}`);
        }
      }
      msg.textContent = `${label} (${(fw.byteLength / 1024).toFixed(1)} KB) — pick DFU device`;
      const dev = await detectDfu();
      msg.textContent = `device opened — ${dev.productName ?? "STM32 DFU"}`;
      await dfuFlash(
        dev,
        fw,
        0x08000000,
        (p) => {
          bar.style.setProperty("--p", `${(p * 100).toFixed(1)}%`);
          msg.textContent = `flashing ${label}… ${(p * 100).toFixed(1)}%`;
        },
        (m) => this.log(`DFU ${m}`)
      );
      bar.style.setProperty("--p", "100%");
      msg.textContent = `${label} done. Unplug, release BOOT0, replug.`;
      this.setStatus("flashed", "connected");
    } catch (e) {
      this.log(`DFU error: ${e.message}`);
      msg.textContent = `error: ${e.message}`;
      this.setStatus("error", "error");
    }
  }
}

// ─── Distance pipeline ────────────────────────────────────────────────────────
function onDistance(slot, seq, mm) {
  if (!paused) {
    samples.push({ seq, mm, t: performance.now(), src: slot });
    if (samples.length > MAX_SAMPLES) samples.shift();
    drawChart();
    updateStats();
  }
  if (calibActive && slot === calibRespSlot) {
    calibCollected.push(mm);
    $("#cal-status").textContent =
      `collecting… ${calibCollected.length} / ${calibNeeded}`;
    if (calibCollected.length >= calibNeeded) finishCalibration();
  }
}

function updateStats() {
  if (samples.length === 0) {
    $("#stat-last").textContent = "—";
    $("#stat-mean").textContent = "—";
    $("#stat-std").textContent = "—";
    $("#stat-n").textContent = "0";
    return;
  }
  const xs = samples.map((s) => s.mm);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  $("#stat-last").textContent = xs[xs.length - 1].toFixed(0);
  $("#stat-mean").textContent = mean.toFixed(0);
  $("#stat-std").textContent = Math.sqrt(variance).toFixed(0);
  $("#stat-n").textContent = String(xs.length);
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
      "waiting for distance samples — set one tag I, the other R…",
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
  ctx.fillText(`from ${last.src}`, padL + innerW - 70, padT + 12);
}

// ─── Calibration ──────────────────────────────────────────────────────────────
async function startCalibration() {
  const respSlot = document.querySelector('input[name="cal-resp"]:checked').value;
  const resp = tags[respSlot];

  if (!tags.A.port || !tags.B.port) {
    setCalStatus("error", `both slots must be connected (A: ${!!tags.A.port}, B: ${!!tags.B.port})`);
    return;
  }
  if (resp.calib === null) {
    setCalStatus("error", `slot ${respSlot} hasn't reported calib yet — press its INFO`);
    return;
  }

  calibTarget = parseInt($("#cal-dist").value, 10);
  calibNeeded = parseInt($("#cal-n").value, 10);
  if (!isFinite(calibTarget) || calibTarget <= 0 || !isFinite(calibNeeded) || calibNeeded < 10) {
    setCalStatus("error", "bad inputs");
    return;
  }

  calibCollected = [];
  calibRespSlot = respSlot;
  calibActive = true;
  $("#cal-start").disabled = true;
  setCalStatus("running", `collecting 0 / ${calibNeeded}…`);
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
    `slot ${calibRespSlot}: mean=${mean.toFixed(1)} mm  true=${calibTarget} mm  ` +
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
  $("#cal-start").disabled = !bothConnected;
}


$("#pause").addEventListener("click", () => {
  paused = !paused;
  $("#pause").textContent = paused ? "Resume" : "Pause";
});

$("#clear").addEventListener("click", () => {
  samples.length = 0;
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
  a.download = `opentag-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
});

$("#cal-start").addEventListener("click", startCalibration);

tags.A = new TagConnection("A", $('.tag[data-slot="A"]'));
tags.B = new TagConnection("B", $('.tag[data-slot="B"]'));
tags.A.setButtons();
tags.B.setButtons();
resizeCanvas();
