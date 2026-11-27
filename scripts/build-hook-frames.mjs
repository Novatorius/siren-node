#!/usr/bin/env node
/**
 * Renders Siren's hook animation into character art for the `siren` command,
 * and writes src/cli/hook-frames.ts. Run it by hand when the logo changes.
 * The CLI only reads the file it writes, so the package gains no runtime
 * dependency.
 *
 *   node scripts/build-hook-frames.mjs \
 *     --svg ../siren-website/public/logo-animated-once.svg \
 *     --playwright /path/to/a/checkout/with/playwright [--mode braille|half] [--cols 24] [--slow 1.6]
 *
 * The source is public/logo-animated-once.svg in the website repository
 * (Novatorius/siren-website-headless). The script loads it in headless
 * Chromium through Playwright, which siren-node does not install, so
 * --playwright names a folder whose node_modules holds it. For each frame
 * it pauses every CSS animation at the frame's time, takes a screenshot
 * with a clear background, and reads the alpha of each pixel. It renders at
 * four times the size and averages each 4 by 4 block, then turns each block
 * on or off at half coverage.
 *
 * --slow plays the SVG's animation that many times slower: it samples the
 * same motion at more, closer times, and the frames stay --fps apart. The
 * CLI uses 1.6, so the 1.2 second slide and grip takes about 1.9 seconds.
 * The hover after the grip is not in the SVG. hook.ts draws it by lifting
 * the last frame.
 *
 * In braille mode each character holds 2 by 4 dots. In half mode each
 * character holds 1 by 2 pixels, drawn with ▀ ▄ █. A terminal cell is about
 * twice as tall as it is wide, so both keep the logo's shape.
 */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    svg: { type: 'string' },
    playwright: { type: 'string' },
    mode: { type: 'string', default: 'braille' },
    cols: { type: 'string', default: '24' },
    fps: { type: 'string', default: '20' },
    slow: { type: 'string', default: '1' },
    out: { type: 'string' },
    preview: { type: 'boolean', default: false },
  },
});
if (!values.svg || !values.playwright) {
  console.error('Usage: node scripts/build-hook-frames.mjs --svg <logo-animated-once.svg> --playwright <folder with node_modules/playwright>');
  process.exit(2);
}
const mode = values.mode;
if (mode !== 'braille' && mode !== 'half') throw new Error('--mode is braille or half');
const cols = Number(values.cols);
const fps = Number(values.fps);
const slow = Number(values.slow);
if (!(slow >= 1)) throw new Error('--slow is 1 or more');
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(values.out ?? join(here, '..', 'src', 'cli', 'hook-frames.ts'));

const svg = readFileSync(values.svg, 'utf8');
const [, vbW, vbH] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg) ?? [];
if (!vbW) throw new Error('The SVG has no viewBox.');
const durations = [...svg.matchAll(/animation:\s*\w+\s+([\d.]+)s/g)].map((m) => Number(m[1]));
const seconds = Math.max(...durations);

// Dots across and down. Braille holds 2 by 4 dots in a cell, half blocks 1 by 2.
const cellW = mode === 'braille' ? 2 : 1;
const cellH = mode === 'braille' ? 4 : 2;
const dotsW = cols * cellW;
const rows = Math.ceil((dotsW * Number(vbH)) / Number(vbW) / cellH);
const dotsH = rows * cellH;
const SS = 4;

const { chromium } = createRequire(join(resolve(values.playwright), 'package.json'))('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: dotsW * SS, height: dotsH * SS }, deviceScaleFactor: 1 });
const sized = svg.replace(/<svg width="[\d.]+" height="[\d.]+"/, `<svg width="${dotsW * SS}" height="${dotsH * SS}" preserveAspectRatio="xMidYMid meet"`);
await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);

const count = Math.round(seconds * fps * slow) + 1;
const frames = [];
for (let i = 0; i < count; i++) {
  const ms = Math.min((i * 1000) / fps / slow, seconds * 1000);
  await page.evaluate((t) => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = t;
    }
  }, ms);
  const png = await page.screenshot({ omitBackground: true, type: 'png' });
  const alpha = await page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const a = [];
    for (let p = 3; p < data.length; p += 4) a.push(data[p]);
    return { a, w: bitmap.width };
  }, png.toString('base64'));
  const on = (x, y) => {
    let sum = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) sum += alpha.a[(y * SS + dy) * alpha.w + x * SS + dx];
    return sum / (SS * SS * 255) >= 0.5;
  };
  frames.push(toText(on));
}
await browser.close();

function toText(on) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      if (mode === 'half') {
        const top = on(c, r * 2);
        const bottom = on(c, r * 2 + 1);
        line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
      } else {
        // Braille dot bits: column 0 rows 0-3 are 1 2 4 64, column 1 rows 0-3 are 8 16 32 128.
        const bits = [
          [0x01, 0x02, 0x04, 0x40],
          [0x08, 0x10, 0x20, 0x80],
        ];
        let code = 0;
        for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 4; dy++) if (on(c * 2 + dx, r * 4 + dy)) code |= bits[dx][dy];
        line += code === 0 ? ' ' : String.fromCharCode(0x2800 + code);
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}

if (values.preview) {
  for (const [i, frame] of frames.entries()) console.log(`frame ${i}\n${frame.join('\n')}`);
}

const body = [
  '// Generated by scripts/build-hook-frames.mjs from the website\'s public/logo-animated-once.svg.',
  '// Do not edit by hand. Run the script again when the logo changes.',
  '',
  '/** How long apart the frames are, in milliseconds. */',
  `export const HOOK_FRAME_MS = ${Math.round(1000 / fps)};`,
  '',
  '/** How many characters wide each frame is at most. */',
  `export const HOOK_WIDTH = ${cols};`,
  '',
  `/** The hook halves sliding in and gripping, ${count} frames of ${rows} lines, trailing spaces trimmed. The last is the still logo. */`,
  'export const HOOK_FRAMES: readonly (readonly string[])[] = [',
  ...frames.map((frame) => `  [\n${frame.map((line) => `    ${JSON.stringify(line)},`).join('\n')}\n  ],`),
  '];',
  '',
].join('\n');
writeFileSync(out, body);
console.error(`Wrote ${count} frames of ${cols} by ${rows} (${mode}) to ${out}, ${Buffer.byteLength(body)} bytes.`);
