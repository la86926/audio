// Verifica atajos de teclado (X, Borrar, flechas, Espacio, ⌘/Ctrl+Z) y los efectos
// de tono, velocidad y volumen: interfaz, reproducción y archivo exportado (WAV).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const sample = path.join(ROOT, 'fx-sample-6s.wav');
const RATE = 44100, FREQ = 440, AMP = 12000;

function createWav(filePath, seconds) {
  const frames = Math.floor(RATE * seconds), dataSize = frames * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * FREQ * i / RATE) * AMP), 44 + i * 2);
  fs.writeFileSync(filePath, b);
}
function readWav(filePath) {
  const b = fs.readFileSync(filePath);
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24);
  let off = 12;
  while (b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const size = b.readUInt32LE(off + 4), start = off + 8, frames = size / (2 * channels);
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = b.readInt16LE(start + i * 2 * channels);
  return { rate, frames, seconds: frames / rate, mono };
}
function analyse(wav) {
  // Frecuencia por cruces por cero y pico en la zona central (evita bordes).
  const a = Math.floor(wav.frames * 0.2), z = Math.floor(wav.frames * 0.8);
  let crossings = 0, peak = 0;
  for (let i = a + 1; i < z; i++) {
    if ((wav.mono[i - 1] < 0) !== (wav.mono[i] < 0)) crossings++;
    peak = Math.max(peak, Math.abs(wav.mono[i]));
  }
  return { freq: crossings / 2 / ((z - a) / wav.rate), peak };
}
function assert(condition, message) { if (!condition) throw new Error(message); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function state(page) {
  return page.locator('#waveBox').evaluate(el => ({
    clipCount: Number(el.dataset.clipCount || 0),
    activeClip: Number(el.dataset.activeClip || 0),
    keptDuration: Number(el.dataset.keptDuration || 0),
    cursorProject: Number(el.dataset.cursorProject || 0),
  }));
}
async function setFx(page, key, value) {
  const open = await page.locator('.fx-panel').isVisible() && await page.locator('.fx-panel').getAttribute('data-fx') === key;
  if (!open) await page.click(`.fx-btn[data-fx="${key}"]`);
  await page.locator('.fx-panel').waitFor({ state: 'visible' });
  await page.locator('#fxRange').evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await page.click('#fxAccept');
  assert(!(await page.locator('.fx-panel').isVisible()), 'Aceptar no ocultó el deslizador de ' + key + '.');
}
async function waitFxIdle(page) {
  await page.waitForFunction(() => !document.querySelector('.fx-bar').classList.contains('busy'), null, { timeout: 30000 });
}
async function exportWav(page, name) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btnCut')]);
  const file = path.join(ROOT, name);
  await download.saveAs(file);
  await page.waitForFunction(() => !document.getElementById('btnCut').disabled, null, { timeout: 60000 });
  return readWav(file);
}
async function waveInk(page) {
  return page.locator('#waveCanvas').evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  });
}

async function main() {
  createWav(sample, 6);
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle', timeout: 30000 });

  // Logo en pestaña y cabecera
  const icons = await page.evaluate(() => [...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]')].map(l => l.getAttribute('href')));
  assert(icons.some(h => h.includes('logo.svg')) && icons.some(h => h.includes('apple-touch-icon.png')), 'Faltan los íconos de la pestaña: ' + icons);
  for (const h of icons) {
    const r = await page.request.get(new URL(h, 'http://127.0.0.1:4173/').href);
    assert(r.ok(), 'No carga el ícono ' + h);
  }

  await page.setInputFiles('#fileCut', sample);
  await page.waitForFunction(() => Number(document.getElementById('waveBox').dataset.keptDuration) > 5.9, null, { timeout: 30000 });
  await page.locator('h1').click(); // foco fuera de botones y campos

  // ---- Atajos
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  let s = await state(page);
  assert(near(s.cursorProject, 2, 0.02), 'Mayús+→ no avanzó un segundo por pulsación: ' + s.cursorProject);
  await page.keyboard.press('ArrowRight');
  s = await state(page);
  assert(near(s.cursorProject, 2 + 1 / 30, 0.005), '→ no avanzó un fotograma (1/30 s): ' + s.cursorProject);
  await page.keyboard.press('ArrowLeft');
  s = await state(page);
  assert(near(s.cursorProject, 2, 0.005), '← no retrocedió un fotograma: ' + s.cursorProject);

  await page.keyboard.press('x');
  s = await state(page);
  assert(s.clipCount === 2 && s.activeClip === 1, 'X no recortó en el cursor: ' + JSON.stringify(s));
  await page.keyboard.press('Backspace');
  s = await state(page);
  assert(s.clipCount === 1 && near(s.keptDuration, 2, 0.02), 'Borrar no eliminó el fragmento del cursor: ' + JSON.stringify(s));
  await page.keyboard.press('ControlOrMeta+z');
  s = await state(page);
  assert(s.clipCount === 2 && near(s.keptDuration, 6, 0.02), 'Ctrl/⌘+Z no deshizo el borrado: ' + JSON.stringify(s));
  await page.keyboard.press('ControlOrMeta+Shift+z');
  s = await state(page);
  assert(s.clipCount === 1, 'Ctrl/⌘+Mayús+Z no rehízo: ' + JSON.stringify(s));
  await page.keyboard.press('ControlOrMeta+z');

  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  assert(await page.locator('#icoPause').isVisible(), 'Espacio no inició la reproducción.');
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  assert(await page.locator('#icoPlay').isVisible(), 'Espacio no pausó.');

  // El atajo no debe actuar mientras se escribe en un campo
  await page.locator('#sS').focus();
  await page.keyboard.press('x');
  assert((await state(page)).clipCount === 2, 'X actuó mientras se escribía en un campo.');
  await page.locator('h1').click();

  // ---- Volumen: la onda crece y el archivo sube de nivel
  const ink1 = await waveInk(page);
  await setFx(page, 'volume', 0.5);
  const inkLow = await waveInk(page);
  assert(inkLow < ink1 * 0.7, `La onda no se achicó al bajar el volumen (${ink1} → ${inkLow}).`);
  await setFx(page, 'volume', 1.5);
  const ink2 = await waveInk(page);
  assert(ink2 > ink1 * 1.1, `La onda no creció con el volumen (${ink1} → ${ink2}).`);
  assert((await page.locator('.fx-btn[data-fx="volume"] .fx-chip').textContent()) === '150%', 'El botón no muestra 150%.');
  let wav = await exportWav(page, 'fx-volume.wav');
  let a = analyse(wav);
  assert(near(a.peak, AMP * 1.5, AMP * 0.05), 'Volumen 150% no se aplicó al exportar: pico ' + a.peak);
  assert(near(wav.seconds, 6, 0.03), 'El volumen cambió la duración: ' + wav.seconds);

  // Regresar a como estaba
  await page.click('.fx-btn[data-fx="volume"]');
  await page.click('#fxReset');
  await page.click('#fxAccept');
  assert(await page.locator('.fx-btn[data-fx="volume"] .fx-chip').isHidden(), 'Original no restableció el volumen.');

  // ---- Velocidad ×2: mitad de duración, mismo tono
  await setFx(page, 'speed', 2);
  await waitFxIdle(page);
  wav = await exportWav(page, 'fx-speed.wav');
  a = analyse(wav);
  assert(near(wav.seconds, 3, 0.06), 'Velocidad ×2 no redujo la duración a la mitad: ' + wav.seconds);
  assert(near(a.freq, FREQ, 12), 'La velocidad alteró el tono: ' + a.freq);

  // Reproducción con velocidad: el cursor avanza al doble
  await page.locator('h1').click();
  await page.keyboard.press('Home');
  const p0 = (await state(page)).cursorProject;
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Space');
  const p1 = (await state(page)).cursorProject;
  assert(p1 - p0 > 1.5, 'Con velocidad ×2 el cursor no avanzó más rápido: ' + (p1 - p0));

  // Deshacer recupera la velocidad original
  await page.keyboard.press('ControlOrMeta+z');
  assert(await page.locator('.fx-btn[data-fx="speed"] .fx-chip').isHidden(), 'Deshacer no devolvió la velocidad original.');

  // ---- Tono +12: una octava más aguda, misma duración
  await setFx(page, 'pitch', 12);
  await waitFxIdle(page);
  wav = await exportWav(page, 'fx-pitch.wav');
  a = analyse(wav);
  assert(near(a.freq, FREQ * 2, 20), 'Tono +12 no subió una octava: ' + a.freq);
  assert(near(wav.seconds, 6, 0.06), 'El tono alteró la duración: ' + wav.seconds);

  // ---- Tono −12 + velocidad ×0.5 a la vez
  await setFx(page, 'pitch', -12);
  await setFx(page, 'speed', 0.5);
  await waitFxIdle(page);
  wav = await exportWav(page, 'fx-both.wav');
  a = analyse(wav);
  assert(near(a.freq, FREQ / 2, 12), 'Tono −12 no bajó una octava: ' + a.freq);
  assert(near(wav.seconds, 12, 0.15), 'Velocidad ×0.5 no duplicó la duración: ' + wav.seconds);

  assert(errors.length === 0, 'Errores de página: ' + errors.join(' | '));
  console.log('VERIFIED fx+shortcuts');
  await browser.close();
}

main().catch(error => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
