// Minimal WebUSB DFU / DfuSe client for STM32 ROM bootloader.
// Targets the STM32 system memory bootloader (VID 0x0483, PID 0xDF11).
//
// Workflow:
//   1. Hold BOOT0 and reset/replug the tag — it enumerates as the STM32 DFU
//      device.
//   2. Call detectDevice() to pop the WebUSB chooser.
//   3. Call flash(buffer, baseAddr, onProgress) with raw firmware bytes.
//
// Implements just what's needed for STM32G4: mass erase, set address pointer,
// chunked download to internal flash at 0x08000000, manifestation.
//
// Spec refs:
//   USB DFU 1.1 (Universal Serial Bus Device Class Specification for DFU)
//   ST AN3156 + UM0412 (DfuSe extension): commands 0x21 set-address, 0x41 erase

// DFU class requests
const DFU_DNLOAD    = 1;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT     = 6;

// DFU states (subset)
const STATE_DFU_IDLE             = 2;
const STATE_DFU_DNLOAD_SYNC      = 3;
const STATE_DFU_DNBUSY           = 4;
const STATE_DFU_DNLOAD_IDLE      = 5;
const STATE_DFU_MANIFEST_SYNC    = 6;
const STATE_DFU_MANIFEST         = 7;
const STATE_DFU_MANIFEST_WAIT_RESET = 8;
const STATE_DFU_ERROR            = 10;

const FLASH_BASE = 0x08000000;
const TRANSFER_SIZE_FALLBACK = 1024; // used if the device descriptor doesn't say

// ─── Public API ───────────────────────────────────────────────────────────────
export async function detectDevice() {
  if (!("usb" in navigator)) {
    throw new Error("WebUSB unavailable. Use Chrome or Edge.");
  }
  return await navigator.usb.requestDevice({
    filters: [{ vendorId: 0x0483, productId: 0xdf11 }],
  });
}

export async function flash(device, firmware, baseAddr, onProgress, onLog) {
  const log = (m) => { if (onLog) onLog(m); };
  const progress = (p) => { if (onProgress) onProgress(p); };
  baseAddr = baseAddr ?? FLASH_BASE;

  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);

  // Read the configuration descriptor and find the DFU functional
  // descriptor — its wTransferSize is what the bootloader actually wants.
  const transferSize = await readDfuTransferSize(device, log);
  log(`wTransferSize = ${transferSize}`);

  // Find a DFU interface (class 0xFE, subclass 0x01).
  let intfNum = null;
  let altSetting = 0;
  for (const intf of device.configuration.interfaces) {
    for (const alt of intf.alternates) {
      if (alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x01) {
        intfNum = intf.interfaceNumber;
        altSetting = alt.alternateSetting;
        log(`DFU interface ${intfNum} alt ${altSetting}: ${alt.interfaceName ?? "(no name)"}`);
        break;
      }
    }
    if (intfNum !== null) break;
  }
  if (intfNum === null) throw new Error("no DFU interface on device");

  await device.claimInterface(intfNum);
  if (altSetting !== 0) {
    await device.selectAlternateInterface(intfNum, altSetting);
  }

  const ctx = { device, intfNum, log };

  // Dump interface map so we can see what the bootloader is offering.
  for (const intf of device.configuration.interfaces) {
    for (const alt of intf.alternates) {
      log(
        `  iface ${intf.interfaceNumber} alt ${alt.alternateSetting} ` +
        `class=0x${alt.interfaceClass.toString(16)} ` +
        `sub=0x${alt.interfaceSubclass.toString(16)} ` +
        `proto=0x${alt.interfaceProtocol.toString(16)} ` +
        `name=${JSON.stringify(alt.interfaceName ?? null)}`
      );
    }
  }

  // Brief settle delay; some STM32 bootloaders aren't ready for the first
  // GETSTATUS the moment WebUSB hands us the device.
  await sleep(100);

  await ensureIdle(ctx, log);

  // ── 1. Mass erase ────────────────────────────────────────────────────────
  log("erasing flash (mass erase)…");
  await dnloadCommand(ctx, new Uint8Array([0x41]));
  await pollUntil(ctx, [STATE_DFU_DNLOAD_IDLE, STATE_DFU_IDLE], 30_000, log);
  log("erase complete");

  // ── 2. Set address pointer ───────────────────────────────────────────────
  log(`setting address 0x${baseAddr.toString(16).padStart(8, "0")}`);
  await dnloadCommand(ctx, encodeAddrCmd(0x21, baseAddr));
  await pollUntil(ctx, [STATE_DFU_DNLOAD_IDLE], 5_000, log);

  // ── 3. Download chunks ───────────────────────────────────────────────────
  const total = firmware.byteLength;
  const data = new Uint8Array(firmware);
  let blockNum = 2;
  for (let off = 0; off < total; off += transferSize) {
    const end = Math.min(off + transferSize, total);
    const chunk = data.subarray(off, end);
    await dnload(ctx, blockNum++, chunk);
    await pollUntil(ctx, [STATE_DFU_DNLOAD_IDLE], 5_000, null);
    progress(end / total);
  }
  log(`downloaded ${total} bytes in ${blockNum - 2} blocks`);

  // ── 4. Manifestation: zero-length DNLOAD ─────────────────────────────────
  log("starting manifestation (device will reset)…");
  try {
    await dnload(ctx, 0, new Uint8Array(0));
    // After manifestation the device often detaches; getStatus may fail.
    await pollUntil(
      ctx,
      [STATE_DFU_MANIFEST, STATE_DFU_MANIFEST_WAIT_RESET, STATE_DFU_IDLE],
      5_000,
      null
    ).catch(() => {});
  } catch (e) {
    log(`(manifestation: ${e.message} — usually fine, device reset)`);
  }

  try { await device.releaseInterface(intfNum); } catch {}
  try { await device.close(); } catch {}
  log("done. unplug, release BOOT0, replug to run new firmware.");
}

// Read the configuration descriptor and walk it for the DFU functional
// descriptor (bDescriptorType=0x21). Returns wTransferSize, or the fallback.
async function readDfuTransferSize(device, log) {
  try {
    const r = await device.controlTransferIn(
      {
        requestType: "standard",
        recipient: "device",
        request: 0x06, // GET_DESCRIPTOR
        value: 0x0200, // (CONFIGURATION << 8) | 0
        index: 0,
      },
      256
    );
    if (r.status !== "ok") {
      log(`GET_DESCRIPTOR(config) status=${r.status}, falling back`);
      return TRANSFER_SIZE_FALLBACK;
    }
    const dv = r.data;
    let i = 0;
    while (i + 1 < dv.byteLength) {
      const len = dv.getUint8(i);
      const type = dv.getUint8(i + 1);
      if (len === 0) break;
      if (type === 0x21 && len >= 9 && i + 6 < dv.byteLength) {
        // bLen, bDescType, bmAttr, wDetachTimeout(2), wTransferSize(2), bcdDFUVer(2)
        const wts = dv.getUint8(i + 5) | (dv.getUint8(i + 6) << 8);
        const attrs = dv.getUint8(i + 2);
        log(`DFU functional descriptor: bmAttributes=0x${attrs.toString(16)} wTransferSize=${wts}`);
        return wts || TRANSFER_SIZE_FALLBACK;
      }
      i += len;
    }
    log("no DFU functional descriptor found, falling back");
    return TRANSFER_SIZE_FALLBACK;
  } catch (e) {
    log(`descriptor read failed: ${e.message}; falling back`);
    return TRANSFER_SIZE_FALLBACK;
  }
}

// ─── Internal: low-level DFU control transfers ────────────────────────────────
async function dnload(ctx, blockNum, data) {
  const result = await ctx.device.controlTransferOut(
    {
      requestType: "class",
      recipient: "interface",
      request: DFU_DNLOAD,
      value: blockNum,
      index: ctx.intfNum,
    },
    data
  );
  if (result.status !== "ok") {
    throw new Error(`DNLOAD failed: ${result.status}`);
  }
}

// DfuSe commands ride on block 0 of DNLOAD.
function dnloadCommand(ctx, data) {
  return dnload(ctx, 0, data);
}

function encodeAddrCmd(cmd, addr) {
  const buf = new Uint8Array(5);
  buf[0] = cmd;
  buf[1] = addr & 0xff;
  buf[2] = (addr >> 8) & 0xff;
  buf[3] = (addr >> 16) & 0xff;
  buf[4] = (addr >> 24) & 0xff;
  return buf;
}

async function getStatus(ctx) {
  const r = await ctx.device.controlTransferIn(
    {
      requestType: "class",
      recipient: "interface",
      request: DFU_GETSTATUS,
      value: 0,
      index: ctx.intfNum,
    },
    6
  );
  if (r.status !== "ok") throw new Error(`GETSTATUS failed: ${r.status}`);
  const dv = r.data;
  const bytes = [];
  for (let i = 0; i < dv.byteLength; i++) bytes.push(dv.getUint8(i));
  if (dv.byteLength < 6) {
    throw new Error(`GETSTATUS short reply (${dv.byteLength}B): ${bytes.map(b => b.toString(16)).join(" ")}`);
  }
  const status = {
    bStatus: dv.getUint8(0),
    bwPollTimeout: dv.getUint8(1) | (dv.getUint8(2) << 8) | (dv.getUint8(3) << 16),
    bState: dv.getUint8(4),
    raw: bytes,
  };
  if (ctx.log) ctx.log(`getStatus raw=[${bytes.map(b => "0x" + b.toString(16).padStart(2, "0")).join(", ")}]`);
  return status;
}

async function clrStatus(ctx) {
  await ctx.device.controlTransferOut(
    {
      requestType: "class",
      recipient: "interface",
      request: DFU_CLRSTATUS,
      value: 0,
      index: ctx.intfNum,
    },
    new Uint8Array(0)
  );
}

async function abort(ctx) {
  await ctx.device.controlTransferOut(
    {
      requestType: "class",
      recipient: "interface",
      request: DFU_ABORT,
      value: 0,
      index: ctx.intfNum,
    },
    new Uint8Array(0)
  );
}

async function ensureIdle(ctx, log) {
  let s = await getStatus(ctx);
  if (s.bState === STATE_DFU_ERROR) {
    log(`device in error state (status=${s.bStatus}); clearing`);
    await clrStatus(ctx);
    s = await getStatus(ctx);
  }
  if (s.bState !== STATE_DFU_IDLE) {
    try { await abort(ctx); } catch {}
    s = await getStatus(ctx);
  }
  if (s.bState !== STATE_DFU_IDLE) {
    throw new Error(`device not idle (state=${s.bState}, status=${s.bStatus})`);
  }
}

async function pollUntil(ctx, targetStates, timeoutMs, log) {
  const t0 = performance.now();
  while (true) {
    const s = await getStatus(ctx);
    if (s.bStatus !== 0) {
      throw new Error(`DFU error status=${s.bStatus} state=${s.bState}`);
    }
    if (targetStates.includes(s.bState)) return s;
    if (s.bState === STATE_DFU_ERROR) {
      throw new Error(`device entered DFU_ERROR state=${s.bState}`);
    }
    if (performance.now() - t0 > timeoutMs) {
      throw new Error(`timeout waiting for states ${targetStates.join(",")}, last=${s.bState}`);
    }
    await sleep(Math.max(1, s.bwPollTimeout));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
