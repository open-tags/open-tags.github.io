const LABEL_WIDTH_PX = 600;
const LABEL_HEIGHT_PX = 300;
const LABELS_PER_SHEET = 48;
const MAX_START = 99999 - LABELS_PER_SHEET + 1;
const AVAILABLE_MODULE_COUNT = 15;

const input = document.querySelector("#barcode-start");
const preview = document.querySelector("#barcode-preview");
const summary = document.querySelector("#barcode-summary");
const status = document.querySelector("#barcode-status");
const pngButton = document.querySelector("#download-png");
const pdfButton = document.querySelector("#download-pdf");
const printButton = document.querySelector("#print-sheet");
const packedByInput = document.querySelector("#packed-by");
const shippingStatus = document.querySelector("#shipping-status");
const insertPrintButtons = document.querySelectorAll("[data-print-insert]");
const inserts = {
  distance: {
    title: "Distance",
    url: "https://open-tags.com/firmware/#distance",
    defaultModules: [1, 2],
    moduleSearch: document.querySelector("#distance-module-search"),
    moduleOptions: document.querySelector("#distance-module-options"),
    moduleCount: document.querySelector("#distance-module-count"),
    qr: document.querySelector("#distance-qr"),
  },
  location: {
    title: "Location",
    url: "https://open-tags.com/firmware/#location",
    defaultModules: [1, 2, 3, 4, 5],
    moduleSearch: document.querySelector("#location-module-search"),
    moduleOptions: document.querySelector("#location-module-options"),
    moduleCount: document.querySelector("#location-module-count"),
    qr: document.querySelector("#location-qr"),
  },
};

function serialNumber(value) {
  return String(value).padStart(5, "0");
}

function serialValue(value) {
  return `opentag1${serialNumber(value)}`;
}

function currentStart() {
  const digits = input.value.replace(/\D/g, "").slice(0, 5);
  const parsed = Number.parseInt(digits || "0", 10);
  return Math.max(0, Math.min(MAX_START, parsed));
}

function makeLabelCanvas(serial) {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_WIDTH_PX;
  canvas.height = LABEL_HEIGHT_PX;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const bars = document.createElement("canvas");
  window.JsBarcode(bars, serial, {
    format: "CODE128",
    width: 3,
    height: 166,
    margin: 0,
    displayValue: false,
    background: "#fff",
    lineColor: "#000",
  });

  const barcodeX = Math.round((canvas.width - bars.width) / 2);
  context.drawImage(bars, barcodeX, 34);
  context.fillStyle = "#111";
  context.font = "600 34px system-ui, -apple-system, 'Segoe UI', sans-serif";
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillText(serial, canvas.width / 2, 252);
  return canvas;
}

function drawPreview() {
  if (!window.JsBarcode) {
    setStatus("Barcode library could not load. Check your connection and reload.", true);
    return;
  }
  const start = currentStart();
  const canvas = makeLabelCanvas(serialValue(start));
  const context = preview.getContext("2d");
  context.clearRect(0, 0, preview.width, preview.height);
  context.drawImage(canvas, 0, 0);
  summary.textContent = `PDF sequence: ${serialValue(start)}–${serialValue(start + LABELS_PER_SHEET - 1)}`;
  setStatus("");
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function setShippingStatus(message, isError = false) {
  shippingStatus.textContent = message;
  shippingStatus.classList.toggle("error", isError);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function packingTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")} ${value("timeZoneName")}`;
}

function moduleList(mode) {
  return Array.from(inserts[mode].moduleOptions.querySelectorAll('input[type="checkbox"]:checked'))
    .map((checkbox) => checkbox.value);
}

function updateModuleCount(mode) {
  const count = moduleList(mode).length;
  inserts[mode].moduleCount.textContent = `${count} selected`;
}

function filterModules(mode) {
  const insert = inserts[mode];
  const query = insert.moduleSearch.value.trim().toLowerCase();
  let visible = 0;

  insert.moduleOptions.querySelectorAll(".module-option").forEach((option) => {
    const matches = option.dataset.module.includes(query);
    option.hidden = !matches;
    if (matches) visible += 1;
  });

  insert.moduleOptions.querySelector(".module-empty").hidden = visible > 0;
}

function renderModulePicker(mode) {
  const insert = inserts[mode];
  const selected = new Set(insert.defaultModules.map((number) => serialValue(number)));

  for (let number = 1; number <= AVAILABLE_MODULE_COUNT; number += 1) {
    const serial = serialValue(number);
    const option = document.createElement("label");
    option.className = "module-option";
    option.dataset.module = serial.toLowerCase();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = serial;
    checkbox.checked = selected.has(serial);
    checkbox.addEventListener("change", () => {
      updateModuleCount(mode);
      refreshShippingPreview();
    });

    const label = document.createElement("span");
    label.textContent = serial;
    option.append(checkbox, label);
    insert.moduleOptions.appendChild(option);
  }

  const empty = document.createElement("p");
  empty.className = "module-empty";
  empty.textContent = "No modules found.";
  empty.hidden = true;
  insert.moduleOptions.appendChild(empty);

  insert.moduleSearch.addEventListener("input", () => filterModules(mode));
  updateModuleCount(mode);
}

function refreshShippingPreview() {
  const packedBy = packedByInput.value.trim() || "—";
  const timestamp = packingTimestamp();

  for (const mode of Object.keys(inserts)) {
    const modules = moduleList(mode);
    document.querySelector(`[data-packed-meta="${mode}"]`).textContent = `Packed ${timestamp} · by ${packedBy}`;
    document.querySelector(`[data-modules-meta="${mode}"]`).textContent = `Modules: ${modules.join(" · ") || "—"}`;
  }
}

function renderShippingQr(mode) {
  const insert = inserts[mode];
  insert.qr.replaceChildren();
  new window.QRCode(insert.qr, {
    text: insert.url,
    width: 512,
    height: 512,
    colorDark: "#111111",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

function shippingQrDataUrl(mode) {
  const canvas = inserts[mode].qr.querySelector("canvas");
  if (!canvas) throw new Error("QR code is unavailable");
  return canvas.toDataURL("image/png");
}

function insertPrintHtml(mode, packedBy, timestamp, modules, qrDataUrl) {
  const insert = inserts[mode];
  const fontUrl = `${window.location.origin}/assets/fonts/EditorialNew-Regular.woff2`;
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>opentag ${escapeHtml(insert.title)} package insert</title>
        <style>
          @font-face {
            font-family: "Editorial New";
            src: url("${fontUrl}") format("woff2");
            font-display: swap;
          }
          @page { size: 4in 6in; margin: 0; }
          * { box-sizing: border-box; }
          html, body { width: 4in; height: 6in; margin: 0; background: #fff; }
          body {
            overflow: hidden;
            color: #111;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .sheet { width: 4in; height: 6in; background: #fff; }
          .blank { width: 4in; height: 2in; background: #fff; }
          .content {
            display: grid;
            width: 4in;
            height: 4in;
            grid-template-rows: auto 1fr auto;
            padding: 0.3in;
            background: #fff;
          }
          .kicker {
            color: #666;
            font-size: 9pt;
            font-weight: 650;
            letter-spacing: 0.08em;
            text-transform: uppercase;
          }
          h1 {
            margin: 0.03in 0 0;
            color: #111;
            font-family: "Editorial New", "Iowan Old Style", Georgia, serif;
            font-size: 46pt;
            font-weight: 800;
            line-height: 0.9;
            letter-spacing: -0.04em;
          }
          .setup {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 1.42in;
            column-gap: 0.22in;
            row-gap: 0.08in;
            align-items: center;
          }
          .setup strong { display: block; font-size: 15pt; line-height: 1.15; }
          .url {
            display: block;
            margin-top: 0.09in;
            color: #777;
            font-size: 7pt;
            line-height: 1.2;
            white-space: nowrap;
          }
          .qr { width: 1.42in; height: 1.42in; padding: 0.09in; border: 0.5pt solid #ddd; background: #fff; }
          .qr img { display: block; width: 100%; height: 100%; }
          .meta { padding-top: 0.12in; border-top: 0.5pt solid #ddd; color: #777; font-size: 9pt; line-height: 1.35; }
          .meta p { margin: 0; color: #777; }
          .meta p + p { margin-top: 0.025in; }
        </style>
      </head>
      <body>
        <main class="sheet">
          <div class="blank" aria-hidden="true"></div>
          <section class="content">
            <header><span class="kicker">opentag one</span><h1>${escapeHtml(insert.title)}</h1></header>
            <div class="setup">
              <div><strong>Quickstart</strong><span class="url">${escapeHtml(insert.url.replace("https://", ""))}</span></div>
              <div class="qr"><img src="${qrDataUrl}" alt="QR code to the ${escapeHtml(insert.title)} console"></div>
            </div>
            <footer class="meta">
              <p>Packed ${escapeHtml(timestamp)} · by ${escapeHtml(packedBy)}</p>
              <p>Modules: ${escapeHtml(modules.join(" · ") || "—")}</p>
            </footer>
          </section>
        </main>
      </body>
    </html>`;
}

async function printPackageInsert(mode, button) {
  const packedBy = packedByInput.value.trim();
  if (!packedBy) {
    setShippingStatus("Add who packed the order before printing.", true);
    packedByInput.focus();
    return;
  }

  if (!window.QRCode) {
    setShippingStatus("QR library could not load. Check your connection and reload.", true);
    return;
  }

  const timestamp = packingTimestamp();
  const modules = moduleList(mode);
  if (!modules.length) {
    setShippingStatus(`List the modules in the ${inserts[mode].title} package before printing.`, true);
    inserts[mode].moduleSearch.focus();
    return;
  }

  const printFrame = document.createElement("iframe");
  printFrame.title = `Printable ${inserts[mode].title} package insert`;
  printFrame.style.position = "fixed";
  printFrame.style.right = "0";
  printFrame.style.bottom = "0";
  printFrame.style.width = "1px";
  printFrame.style.height = "1px";
  printFrame.style.border = "0";
  printFrame.style.opacity = "0";
  printFrame.style.pointerEvents = "none";
  document.body.appendChild(printFrame);

  button.disabled = true;
  button.textContent = `Preparing ${inserts[mode].title}…`;
  setShippingStatus(`Preparing the ${inserts[mode].title} insert…`);

  try {
    const html = insertPrintHtml(mode, packedBy, timestamp, modules, shippingQrDataUrl(mode));
    const loaded = new Promise((resolve) => printFrame.addEventListener("load", resolve, { once: true }));
    printFrame.srcdoc = html;
    await loaded;

    const printDocument = printFrame.contentDocument;
    const printContext = printFrame.contentWindow;
    await Promise.all(Array.from(printDocument.images).map((image) => (
      image.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })
    )));
    if (printDocument.fonts?.ready) await printDocument.fonts.ready;

    const cleanup = () => printFrame.remove();
    printContext.addEventListener("afterprint", cleanup, { once: true });
    window.setTimeout(cleanup, 60000);
    printContext.focus();
    printContext.print();
    setShippingStatus(`${inserts[mode].title} 4 × 6 inch print dialog opened.`);
  } catch (error) {
    console.error(error);
    printFrame.remove();
    setShippingStatus(`Could not prepare the ${inserts[mode].title} insert. Reload and try again.`, true);
  } finally {
    button.disabled = false;
    button.textContent = `Print ${inserts[mode].title} insert`;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDensityChunk(dpi) {
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4);
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  return chunk;
}

async function pngWithDpi(blob, dpi) {
  const source = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const pieces = [source.slice(0, 8)];
  let offset = 8;

  while (offset < source.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    const type = String.fromCharCode(...source.slice(offset + 4, offset + 8));
    if (type !== "pHYs") pieces.push(source.slice(offset, end));
    if (type === "IHDR") pieces.push(pngDensityChunk(dpi));
    offset = end;
  }

  return new Blob(pieces, { type: "image/png" });
}

input.addEventListener("input", () => {
  input.value = input.value.replace(/\D/g, "").slice(0, 5);
  drawPreview();
});

input.addEventListener("blur", () => {
  input.value = serialNumber(currentStart());
  drawPreview();
});

pngButton.addEventListener("click", () => {
  const serial = serialValue(currentStart());
  const canvas = makeLabelCanvas(serial);
  canvas.toBlob(async (blob) => {
    if (!blob) {
      setStatus("PNG generation failed. Try again.", true);
      return;
    }
    const printReadyBlob = await pngWithDpi(blob, 600);
    downloadBlob(printReadyBlob, `${serial}-1x0.5in-600dpi.png`);
    setStatus(`Downloaded ${serial} as a 600 × 300 px PNG with 600 DPI metadata.`);
  }, "image/png");
});

pdfButton.addEventListener("click", async () => {
  if (!window.jspdf?.jsPDF) {
    setStatus("PDF library could not load. Check your connection and reload.", true);
    return;
  }

  const start = currentStart();
  pdfButton.disabled = true;
  pngButton.disabled = true;
  printButton.disabled = true;
  pdfButton.textContent = "Building PDF…";
  setStatus("Creating 48 sequential labels…");

  try {
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "in", format: [4, 6], compress: true });

    for (let index = 0; index < LABELS_PER_SHEET; index += 1) {
      const serial = serialValue(start + index);
      const canvas = makeLabelCanvas(serial);
      const column = index % 4;
      const row = Math.floor(index / 4);
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", column, row * 0.5, 1, 0.5, undefined, "FAST");
    }

    pdf.setDrawColor(210, 210, 210);
    pdf.setLineWidth(0.002);
    for (let column = 1; column < 4; column += 1) pdf.line(column, 0, column, 6);
    for (let row = 1; row < 12; row += 1) pdf.line(0, row * 0.5, 4, row * 0.5);

    const first = serialNumber(start);
    const last = serialNumber(start + LABELS_PER_SHEET - 1);
    pdf.save(`opentag-labels-${first}-${last}-4x6.pdf`);
    setStatus(`Downloaded 48 labels: ${serialValue(start)}–${serialValue(start + LABELS_PER_SHEET - 1)}.`);
  } catch (error) {
    console.error(error);
    setStatus("PDF generation failed. Reload and try again.", true);
  } finally {
    pdfButton.disabled = false;
    pngButton.disabled = false;
    printButton.disabled = false;
    pdfButton.textContent = "Download 4 × 6 inch PDF";
  }
});

printButton.addEventListener("click", async () => {
  const start = currentStart();
  const printFrame = document.createElement("iframe");
  printFrame.title = "Printable opentag label sheet";
  printFrame.style.position = "fixed";
  printFrame.style.right = "0";
  printFrame.style.bottom = "0";
  printFrame.style.width = "1px";
  printFrame.style.height = "1px";
  printFrame.style.border = "0";
  printFrame.style.opacity = "0";
  printFrame.style.pointerEvents = "none";
  document.body.appendChild(printFrame);

  printButton.disabled = true;
  pdfButton.disabled = true;
  pngButton.disabled = true;
  printButton.textContent = "Preparing sheet…";
  setStatus("Preparing 48 labels for printing…");

  try {
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    const labels = [];
    for (let index = 0; index < LABELS_PER_SHEET; index += 1) {
      const serial = serialValue(start + index);
      labels.push(`<div class="label"><img src="${makeLabelCanvas(serial).toDataURL("image/png")}" alt="${serial}"></div>`);
    }

    const printDocument = printFrame.contentDocument;
    let sheetReady = false;
    printFrame.addEventListener("load", () => {
      if (!sheetReady) return;
      const printContext = printFrame.contentWindow;
      const cleanup = () => printFrame.remove();
      printContext.addEventListener("afterprint", cleanup, { once: true });
      window.setTimeout(cleanup, 60000);
      window.setTimeout(() => {
        printContext.focus();
        printContext.print();
      }, 100);
    });

    printDocument.open();
    printDocument.write(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>opentag labels ${serialNumber(start)}-${serialNumber(start + LABELS_PER_SHEET - 1)}</title>
          <style>
            @page { size: 4in 6in; margin: 0; }
            * { box-sizing: border-box; }
            html, body { width: 4in; height: 6in; margin: 0; background: #fff; }
            body { overflow: hidden; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .sheet { display: grid; width: 4in; height: 6in; grid-template-columns: repeat(4, 1in); grid-template-rows: repeat(12, 0.5in); }
            .label { width: 1in; height: 0.5in; border-right: 0.25pt solid #ddd; border-bottom: 0.25pt solid #ddd; }
            .label:nth-child(4n) { border-right: 0; }
            .label:nth-child(n+45) { border-bottom: 0; }
            img { display: block; width: 100%; height: 100%; }
          </style>
        </head>
        <body>
          <main class="sheet">${labels.join("")}</main>
        </body>
      </html>`);
    sheetReady = true;
    printDocument.close();
    setStatus(`Print dialog opened for ${serialValue(start)}–${serialValue(start + LABELS_PER_SHEET - 1)}.`);
  } catch (error) {
    console.error(error);
    printFrame.remove();
    setStatus("Could not prepare the print sheet. Reload and try again.", true);
  } finally {
    printButton.disabled = false;
    pdfButton.disabled = false;
    pngButton.disabled = false;
    printButton.textContent = "Print 4 × 6 inch sheet";
  }
});

drawPreview();

if (window.QRCode) {
  renderShippingQr("distance");
  renderShippingQr("location");
} else {
  setShippingStatus("QR library could not load. Check your connection and reload.", true);
}

packedByInput.addEventListener("input", refreshShippingPreview);
renderModulePicker("distance");
renderModulePicker("location");
insertPrintButtons.forEach((button) => {
  button.addEventListener("click", () => printPackageInsert(button.dataset.printInsert, button));
});

refreshShippingPreview();
window.setInterval(refreshShippingPreview, 60000);
