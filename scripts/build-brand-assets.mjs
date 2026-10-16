import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logo = JSON.parse(await readFile(resolve(root, 'packages/brand/logo.json'), 'utf8'));
const { colors } = JSON.parse(await readFile(resolve(root, 'packages/brand/tokens.json'), 'utf8'));
const assets = resolve(root, 'apps/mobile/assets');
const rectangle = (geometry, fill) =>
  `<rect x="${geometry.x}" y="${geometry.y}" width="${geometry.width}" height="${geometry.height}" fill="${fill}"/>`;
function robotSvg({ viewBox = logo.robotViewBox, monochrome = false } = {}) {
  const ink = monochrome ? '#000000' : colors.accent;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(' ')}" shape-rendering="crispEdges" role="img" aria-label="nesvo"><path fill="${ink}" d="${logo.paths.robot}"/>${rectangle(logo.eye, monochrome ? ink : colors.text)}${rectangle(logo.satellite, ink)}</svg>`;
}
await writeFile(resolve(root, 'packages/brand/assets/nesvo-robot.svg'), robotSvg() + '\n');
await mkdir(assets, { recursive: true });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
  });
  for (const asset of [
    { name: 'icon.png', size: 1024, background: colors.background, viewBox: [-4, -6, 17, 18] },
    {
      name: 'android-icon-foreground.png',
      size: 1024,
      background: 'transparent',
      viewBox: [-4, -6, 17, 18],
    },
    { name: 'android-icon-background.png', size: 1024, background: colors.background, empty: true },
    {
      name: 'android-icon-monochrome.png',
      size: 1024,
      background: 'transparent',
      monochrome: true,
      viewBox: [-4, -6, 17, 18],
    },
    { name: 'favicon.png', size: 256, background: colors.background, viewBox: logo.robotViewBox },
    { name: 'splash-icon.png', size: 1024, background: 'transparent', viewBox: [-4, -6, 17, 18] },
  ]) {
    await page.setViewportSize({ width: asset.size, height: asset.size });
    await page.setContent(
      `<html><head><style>html,body{margin:0;width:100%;height:100%;background:${asset.background}}svg{display:block;width:100%;height:100%}</style></head><body>${asset.empty ? '' : robotSvg(asset)}</body></html>`,
    );
    await page.screenshot({
      path: resolve(assets, asset.name),
      omitBackground: asset.background === 'transparent',
    });
  }
} finally {
  await browser.close();
}
console.log('Rendered app icons from the approved vector geometry and shared Ultraviolet tokens.');
