const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium, webkit } = require('playwright');

const ROOT = process.cwd();
const sampleWav = path.join(ROOT, 'sample-6s.wav');
const sampleWav2 = path.join(ROOT, 'sample-3s.wav');
const sampleMp3 = path.join(ROOT, 'sample-6s.mp3');

function createWav(filePath, seconds, frequency = 440) {
  const rate = 44100;
  const frames = Math.floor(rate * seconds);
  const dataSize = frames * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 12000);
    b.writeInt16LE(value, 44 + i * 2);
  }
  fs.writeFileSync(filePath, b);
}

function makeSamples() {
  createWav(sampleWav, 6, 440);
  createWav(sampleWav2, 3, 523.25);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', sampleWav, '-c:a', 'libmp3lame', '-q:a', '3', sampleMp3]);
}

function ffprobeDuration(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath,
  ], { encoding: 'utf8' }).trim();
  return Number(out);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function state(page) {
  return page.locator('#waveBox').evaluate((el) => ({
    viewA: Number(el.dataset.viewA || 0),
    viewB: Number(el.dataset.viewB || 0),
    clipCount: Number(el.dataset.clipCount || 0),
    activeClip: Number(el.dataset.activeClip || 0),
    keptDuration: Number(el.dataset.keptDuration || 0),
    cursorProject: Number(el.dataset.cursorProject || 0),
    pinchMoves: Number(el.dataset.pinchMoves || 0),
  }));
}

async function waitLoaded(page, filePath, expectedSeconds) {
  await page.setInputFiles('#fileCut', filePath);
  await page.waitForFunction(
    (expected) => {
      const el = document.querySelector('#waveBox');
      const editor = document.querySelector('#editor');
      const total = Number(el?.dataset.keptDuration || 0);
      return editor && !editor.hidden && Math.abs(total - expected) < 0.25;
    },
    expectedSeconds,
    { timeout: 30000 },
  );
}

async function clickWaveRatio(page, ratio) {
  const box = await page.locator('#waveBox').boundingBox();
  assert(box, 'No se pudo medir la onda.');
  await page.mouse.click(box.x + box.width * ratio, box.y + box.height * 0.5);
  await page.waitForTimeout(80);
}

async function wheelZoom(page, ratio, deltaY) {
  const box = await page.locator('#waveBox').boundingBox();
  assert(box, 'No se pudo medir la onda para zoom.');
  await page.mouse.move(box.x + box.width * ratio, box.y + box.height * 0.5);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(180);
}

async function exportAndVerify(page, outPath, expectedDuration, expectedExt) {
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 }).then(download => ({ download }));
  const errorPromise = page.waitForFunction(
    () => document.querySelector('#statCut')?.textContent.startsWith('No se pudo exportar:'),
    { timeout: 120000 },
  ).then(async () => ({ error: await page.locator('#statCut').textContent() }));
  await page.locator('#btnCut').click();
  const outcome = await Promise.race([downloadPromise, errorPromise]);
  if (outcome.error) throw new Error(outcome.error);
  const download = outcome.download;
  const suggested = download.suggestedFilename();
  assert(suggested.toLowerCase().endsWith('.' + expectedExt), 'Extensión exportada incoherente: ' + suggested);
  await download.saveAs(outPath);
  const failure = await download.failure();
  assert(!failure, 'La descarga falló: ' + failure);
  assert(fs.statSync(outPath).size > 1000, 'El archivo exportado está vacío o es demasiado pequeño.');
  const duration = ffprobeDuration(outPath);
  assert(Number.isFinite(duration), 'ffprobe no pudo leer el audio exportado.');
  assert(Math.abs(duration - expectedDuration) < 0.35, 'Duración exportada incorrecta: ' + duration + ' frente a ' + expectedDuration);
  await page.waitForFunction(() => document.querySelector('#statCut')?.textContent.includes('Listo:'), { timeout: 15000 });
}

async function joinAndVerify(page, outPath, expectedDuration) {
  await page.locator('[data-tab="join"]').click();
  await page.setInputFiles('#fileJoin', [sampleWav, sampleWav2]);
  await page.waitForFunction(() => {
    const button = document.querySelector('#btnJoin');
    return button && !button.disabled;
  });
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 }).then(download => ({ download }));
  const errorPromise = page.waitForFunction(
    () => document.querySelector('#statJoin')?.textContent.startsWith('No se pudo unir:'),
    { timeout: 120000 },
  ).then(async () => ({ error: await page.locator('#statJoin').textContent() }));
  await page.locator('#btnJoin').click();
  const outcome = await Promise.race([downloadPromise, errorPromise]);
  if (outcome.error) throw new Error(outcome.error);
  await outcome.download.saveAs(outPath);
  assert(!await outcome.download.failure(), 'La descarga del audio unido falló.');
  assert(fs.statSync(outPath).size > 1000, 'El audio unido está vacío.');
  const duration = ffprobeDuration(outPath);
  assert(Math.abs(duration - expectedDuration) < 0.35, 'Duración unida incorrecta: ' + duration);
  await page.waitForFunction(() => document.querySelector('#statJoin')?.textContent.includes('Listo:'), { timeout: 15000 });
}

async function basicSmoke(page, errors) {
  await waitLoaded(page, sampleWav, 6);
  let s = await state(page);
  assert(s.clipCount === 1, 'La carga inicial no creó un único fragmento.');

  await clickWaveRatio(page, 0.48);
  const cursorBefore = (await state(page)).cursorProject;
  assert(cursorBefore > 2 && cursorBefore < 4, 'El cursor no se movió por la onda.');

  await wheelZoom(page, 0.48, -520);
  const zoomed = await state(page);
  assert(zoomed.viewB - zoomed.viewA < zoomed.keptDuration - 0.1, 'La rueda no amplió la onda.');

  const spanBeforeCut = zoomed.viewB - zoomed.viewA;
  await page.locator('#editCut').click();
  s = await state(page);
  assert(s.clipCount === 2, 'Las tijeras no dividieron el fragmento.');
  assert(Math.abs((s.viewB - s.viewA) - spanBeforeCut) < 0.05, 'El corte destruyó el nivel de zoom.');

  const beforeArrow = s.cursorProject;
  await page.keyboard.press('ArrowRight');
  const afterArrow = (await state(page)).cursorProject;
  assert(afterArrow > beforeArrow, 'ArrowRight no desplazó el cursor.');

  await page.locator('#sS').focus();
  const beforeInputShortcut = await state(page);
  await page.keyboard.press('Alt+ArrowRight');
  const afterInputShortcut = await state(page);
  assert(Math.abs(afterInputShortcut.cursorProject - beforeInputShortcut.cursorProject) < 0.001, 'Alt+flecha se activó dentro de un input.');
  assert(afterInputShortcut.clipCount === beforeInputShortcut.clipCount, 'Un atajo alteró la edición dentro de un input.');
  await page.locator('#waveBox').click({ position: { x: 10, y: 10 } });

  await page.keyboard.press('Alt+ArrowLeft');
  const boundary = (await state(page)).cursorProject;
  assert(boundary <= beforeArrow + 0.15, 'Alt+ArrowLeft no navegó al límite anterior.');

  await page.locator('#editUndo').click();
  assert((await state(page)).clipCount === 1, 'Undo no restauró el estado anterior.');
  await page.locator('#editRedo').click();
  assert((await state(page)).clipCount === 2, 'Redo no restauró el corte.');

  assert(errors.length === 0, 'Errores de página durante smoke: ' + errors.join(' | '));
}

async function fullChromium(page, context, errors) {
  await basicSmoke(page, errors);

  // Exportación tras un corte y edición posterior a exportar.
  let s = await state(page);
  const oneCutDuration = s.keptDuration;
  await exportAndVerify(page, path.join(ROOT, 'export-one-cut.wav'), oneCutDuration, 'wav');

  // Alejar, crear un segundo corte y eliminar el fragmento intermedio.
  await wheelZoom(page, 0.5, 1800);
  await clickWaveRatio(page, 0.76);
  await page.locator('#editCut').click();
  s = await state(page);
  assert(s.clipCount === 3, 'No se pudo continuar editando después de exportar.');

  // Tras cortar, el cursor queda al inicio del tercer fragmento. Alt/Option+← debe llevarlo
  // exactamente al límite anterior y activar el fragmento intermedio, sin depender del viewport.
  await page.keyboard.press('Alt+ArrowLeft');
  let selectedMiddle = await state(page);
  assert(selectedMiddle.activeClip === 1, 'Alt/Option+← no activó el fragmento intermedio.');
  await wheelZoom(page, 0.62, -600);
  const beforeDelete = await state(page);
  assert(beforeDelete.activeClip === 1, 'El zoom cambió inesperadamente el fragmento activo.');
  const deleteSpan = beforeDelete.viewB - beforeDelete.viewA;
  await page.locator('#editDelete').click();
  const afterDelete = await state(page);
  assert(afterDelete.clipCount === 2, 'Eliminar no quitó exactamente un fragmento.');
  assert(Math.abs((afterDelete.viewB - afterDelete.viewA) - Math.min(deleteSpan, afterDelete.keptDuration)) < 0.08, 'Eliminar reinició o alteró bruscamente el zoom.');

  await page.locator('#editUndo').click();
  const undoState = await state(page);
  assert(undoState.clipCount === 3, 'Undo no restauró el fragmento eliminado.');
  assert(Math.abs(undoState.viewA - beforeDelete.viewA) < 0.06 && Math.abs(undoState.viewB - beforeDelete.viewB) < 0.06, 'Undo no restauró el viewport.');
  await page.locator('#editRedo').click();
  const redoState = await state(page);
  assert(redoState.clipCount === 2, 'Redo no reaplicó la eliminación.');

  // Navegación entre límites y reproducción tras editar.
  await page.keyboard.press('Alt+ArrowRight');
  const atBoundary = (await state(page)).cursorProject;
  assert(atBoundary >= 0 && atBoundary <= redoState.keptDuration + 0.01, 'Alt+ArrowRight produjo una posición inválida.');

  const beforePlay = (await state(page)).cursorProject;
  await page.locator('#playBtn').click();
  await page.waitForTimeout(550);
  const duringPlay = (await state(page)).cursorProject;
  await page.locator('#playBtn').click();
  assert(duringPlay > beforePlay + 0.05 || duringPlay < beforePlay - 0.05, 'La reproducción no avanzó después de editar.');

  // Exportar discontinuidades reales (varios cortes + eliminación).
  s = await state(page);
  await exportAndVerify(page, path.join(ROOT, 'export-deleted.wav'), s.keptDuration, 'wav');

  // Handles: deben modificar el fragmento sin perder el contexto ampliado.
  const right = await page.locator('#hR').boundingBox();
  assert(right, 'El handle derecho no está disponible.');
  const preHandle = await state(page);
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
  await page.mouse.down();
  await page.mouse.move(right.x - 45, right.y + right.height / 2, { steps: 5 });
  await page.mouse.up();
  const postHandle = await state(page);
  assert(postHandle.keptDuration < preHandle.keptDuration - 0.02, 'El handle derecho no ajustó el fragmento.');
  assert(postHandle.viewB - postHandle.viewA <= preHandle.viewB - preHandle.viewA + 0.08, 'El handle provocó un salto de zoom.');

  // Pellizco táctil y zoom rápido consecutivo.
  await wheelZoom(page, 0.5, 1500);
  const beforePinch = await state(page);
  const box = await page.locator('#waveBox').boundingBox();
  assert(box, 'No se pudo medir la onda para pellizco.');
  const client = await context.newCDPSession(page);
  const y = box.y + box.height * 0.5;
  const x1 = box.x + box.width * 0.42;
  const x2 = box.x + box.width * 0.58;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y }, { x: x2, y }] });
  for (const d of [20, 45, 75]) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 - d, y }, { x: x2 + d, y }] });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(220);
  const afterPinch = await state(page);
  assert(afterPinch.pinchMoves > beforePinch.pinchMoves, 'El pellizco no registró movimiento.');
  assert(afterPinch.viewB - afterPinch.viewA < beforePinch.viewB - beforePinch.viewA, 'El pellizco no amplió la vista.');

  for (let i = 0; i < 10; i += 1) await wheelZoom(page, 0.5, i % 2 ? 80 : -80);
  const rapid = await state(page);
  assert(Number.isFinite(rapid.viewA) && Number.isFinite(rapid.viewB) && rapid.viewB > rapid.viewA, 'El zoom rápido dejó un viewport inválido.');

  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForTimeout(150);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.waitForTimeout(150);

  // Cargar un segundo archivo debe reiniciar edición/historial sin residuos.
  await waitLoaded(page, sampleWav2, 3);
  s = await state(page);
  assert(s.clipCount === 1 && Math.abs(s.keptDuration - 3) < 0.2, 'Cargar un segundo archivo dejó estado del anterior.');
  assert(await page.locator('#editUndo').isDisabled(), 'Undo conservó historial del archivo anterior.');
  assert(await page.locator('#editRedo').isDisabled(), 'Redo conservó historial del archivo anterior.');

  // MP3: varios cortes, eliminación, exportación y reproducción del resultado.
  await waitLoaded(page, sampleMp3, 6);
  await clickWaveRatio(page, 0.33);
  await page.locator('#editCut').click();
  await clickWaveRatio(page, 0.67);
  await page.locator('#editCut').click();
  assert((await state(page)).clipCount === 3, 'Los cortes múltiples fallaron en MP3.');
  await clickWaveRatio(page, 0.50);
  assert((await state(page)).activeClip === 1, 'No se seleccionó el fragmento central MP3.');
  await page.locator('#editDelete').click();
  s = await state(page);
  assert(s.clipCount === 2, 'La eliminación MP3 falló.');
  await exportAndVerify(page, path.join(ROOT, 'export-edited.mp3'), s.keptDuration, 'mp3');

  // Después de exportar MP3 aún se puede mover el cursor y editar.
  const beforeFinalArrow = (await state(page)).cursorProject;
  await page.keyboard.press('ArrowRight');
  assert((await state(page)).cursorProject !== beforeFinalArrow, 'El editor quedó bloqueado después de exportar MP3.');

  // La función existente de unir también debe seguir operativa tras endurecer la capa FFmpeg.
  await joinAndVerify(page, path.join(ROOT, 'joined.wav'), 9);

  assert(errors.length === 0, 'Errores de página: ' + errors.join(' | '));
}

async function main() {
  makeSamples();
  const browserName = process.env.BROWSER || 'chromium';
  const smoke = process.env.SMOKE === '1';
  const browserType = browserName === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, hasTouch: browserName === 'chromium', acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push('pageerror: ' + String(error)));
  page.on('console', message => {
    const type = message.type();
    const value = message.text();
    console.log('BROWSER ' + type.toUpperCase() + ':', value);
    if (type === 'error') errors.push('console: ' + value);
  });
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle', timeout: 30000 });

  if (smoke) await basicSmoke(page, errors);
  else await fullChromium(page, context, errors);

  console.log('VERIFIED', JSON.stringify({ browser: browserName, smoke, finalState: await state(page) }));
  await browser.close();
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
