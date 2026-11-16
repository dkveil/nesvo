import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(repository, 'brand');
const desktopBuild = join(repository, 'apps/desktop/build');
const rendererPublic = join(repository, 'apps/desktop/src/renderer/public');
const mobileAssets = join(repository, 'apps/mobile-client/assets');

const BRAND_BLACK = '#000000';
const BRAND_WHITE = '#ffffff';
const TILE_EDGE = 'rgb(255 255 255 / 16%)';
const MARK_UNITS = 64;
const WORDMARK_BOX = { x: 18, y: 18, width: 372, height: 64 };
const ICO_SIZES_PX = [16, 24, 32, 48, 64, 128, 256];
const LINUX_SIZES_PX = [16, 32, 48, 64, 128, 256, 512, 1024];
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
];
const WINDOW_ICON_PX = 256;
const FAVICON_PX = 64;
const MOBILE_ICON_PX = 1024;
const WORDMARK_HEIGHT_PX = 66;

const readPaths = async file => {
  const source = await readFile(join(brand, file), 'utf8');
  return [...source.matchAll(/<path\b[^>]*\/>/g)].map(match => match[0]);
};

const markPath = (await readPaths('nesvo-mark.svg'))[0].replace(
  /\s*transform="[^"]*"/,
  '',
);
const wordmarkPaths = (await readPaths('nesvo-wordmark.svg')).join('');

const square = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;

const mark = (size, extent, color) => {
  const scale = extent / MARK_UNITS;
  const offset = (size - extent) / 2;
  return `<g fill="${color}" transform="translate(${offset} ${offset}) scale(${scale})">${markPath}</g>`;
};

const desktopIcon = size => {
  const inset = size <= 48 ? 0 : Math.round(size * 0.09);
  const tile = size - inset * 2;
  const radius = tile * 0.225;
  const edge = Math.max(1, size / 256);
  return square(
    size,
    `<rect x="${inset + edge / 2}" y="${inset + edge / 2}" width="${tile - edge}" height="${tile - edge}" rx="${radius}" fill="${BRAND_BLACK}" stroke="${TILE_EDGE}" stroke-width="${edge}"/>${mark(size, tile * 0.5, BRAND_WHITE)}`,
  );
};

const mobileIcon = size =>
  square(
    size,
    `<rect width="${size}" height="${size}" fill="${BRAND_BLACK}"/>${mark(size, size * 0.42, BRAND_WHITE)}`,
  );

const adaptiveForeground = size =>
  square(size, mark(size, size * 0.3, BRAND_WHITE));

const wordmarkWidth = Math.round(
  (WORDMARK_BOX.width / WORDMARK_BOX.height) * WORDMARK_HEIGHT_PX,
);
const wordmark = color =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${wordmarkWidth}" height="${WORDMARK_HEIGHT_PX}" viewBox="${WORDMARK_BOX.x} ${WORDMARK_BOX.y} ${WORDMARK_BOX.width} ${WORDMARK_BOX.height}"><g fill="${color}" fill-rule="evenodd">${wordmarkPaths}</g></svg>`;

const desktopSizes = [
  ...new Set([
    ...ICO_SIZES_PX,
    ...LINUX_SIZES_PX,
    ...ICNS_ENTRIES.map(([, size]) => size),
  ]),
];
const jobs = [
  ...desktopSizes.map(size => ({
    name: `desktop-${size}`,
    markup: desktopIcon(size),
    width: size,
    height: size,
  })),
  {
    name: 'mobile-icon',
    markup: mobileIcon(MOBILE_ICON_PX),
    width: MOBILE_ICON_PX,
    height: MOBILE_ICON_PX,
  },
  {
    name: 'mobile-adaptive',
    markup: adaptiveForeground(MOBILE_ICON_PX),
    width: MOBILE_ICON_PX,
    height: MOBILE_ICON_PX,
  },
  {
    name: 'mobile-wordmark',
    markup: wordmark(BRAND_WHITE),
    width: wordmarkWidth,
    height: WORDMARK_HEIGHT_PX,
  },
];

const rasterizerMain = `const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const directory = process.argv[process.argv.length - 1];
const jobs = JSON.parse(readFileSync(join(directory, 'jobs.json'), 'utf8'));
app.disableHardwareAcceleration();
const render = async () => {
  const window = new BrowserWindow({
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await window.loadURL('data:text/html,<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"></body></html>');
  for (const job of jobs) {
    window.setContentSize(job.width, job.height);
    await window.webContents.executeJavaScript('document.body.innerHTML = ' + JSON.stringify(job.markup));
    await new Promise(done => setTimeout(done, 200));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: job.width, height: job.height });
    const size = image.getSize();
    if (size.width !== job.width || size.height !== job.height) throw new Error(job.name + ' rendered at ' + size.width + 'x' + size.height);
    writeFileSync(join(directory, job.name + '.png'), image.toPNG());
  }
};
app.whenReady().then(render).then(() => app.quit(), error => {
  console.error(error);
  app.exit(1);
});
`;

const workspace = await mkdtemp(join(tmpdir(), 'nesvo-brand-'));
await writeFile(join(workspace, 'jobs.json'), JSON.stringify(jobs));
await writeFile(join(workspace, 'main.cjs'), rasterizerMain);
const requireDesktop = createRequire(
  join(repository, 'apps/desktop/package.json'),
);
const run = spawnSync(
  requireDesktop('electron'),
  ['--force-device-scale-factor=1', join(workspace, 'main.cjs'), workspace],
  {
    stdio: 'inherit',
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'ELECTRON_RUN_AS_NODE',
      ),
    ),
  },
);
if (run.status !== 0) throw new Error(`Rasterizer exited with ${run.status}`);

const raster = name => readFile(join(workspace, `${name}.png`));

const encodeIco = images => {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
};

const encodeIcns = images => {
  const chunks = images.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
};

await mkdir(join(desktopBuild, 'icons'), { recursive: true });
await mkdir(rendererPublic, { recursive: true });
await mkdir(mobileAssets, { recursive: true });

const icoImages = await Promise.all(
  ICO_SIZES_PX.map(async size => ({
    size,
    png: await raster(`desktop-${size}`),
  })),
);
await writeFile(join(desktopBuild, 'icon.ico'), encodeIco(icoImages));

const icnsImages = await Promise.all(
  ICNS_ENTRIES.map(async ([type, size]) => ({
    type,
    png: await raster(`desktop-${size}`),
  })),
);
await writeFile(join(desktopBuild, 'icon.icns'), encodeIcns(icnsImages));

for (const size of LINUX_SIZES_PX)
  await writeFile(
    join(desktopBuild, 'icons', `${size}x${size}.png`),
    await raster(`desktop-${size}`),
  );

await writeFile(
  join(rendererPublic, 'app-icon.png'),
  await raster(`desktop-${WINDOW_ICON_PX}`),
);
await writeFile(
  join(rendererPublic, 'favicon.svg'),
  `${desktopIcon(FAVICON_PX)}\n`,
);
await writeFile(join(mobileAssets, 'icon.png'), await raster('mobile-icon'));
await writeFile(
  join(mobileAssets, 'adaptive-icon.png'),
  await raster('mobile-adaptive'),
);
await writeFile(
  join(mobileAssets, 'wordmark.png'),
  await raster('mobile-wordmark'),
);

await rm(workspace, { recursive: true, force: true });
