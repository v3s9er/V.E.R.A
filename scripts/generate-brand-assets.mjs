import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'assets', 'brand', 'icon.svg'));

const ensureParent = (file) => mkdirSync(dirname(file), { recursive: true });
const writePng = async (file, size, input = source) => {
  ensureParent(file);
  await sharp(input, { density: 512 }).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
};
const writeWebp = async (file, size, input = source) => {
  ensureParent(file);
  await sharp(input, { density: 512 }).resize(size, size).webp({ lossless: true, effort: 6 }).toFile(file);
};

const foreground = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="spark" x1="360" y1="310" x2="680" y2="720" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFFFFF"/><stop offset="0.55" stop-color="#DCE8FF"/><stop offset="1" stop-color="#6DEAF3"/>
      </linearGradient>
      <filter id="glow" x="170" y="170" width="684" height="684"><feGaussianBlur stdDeviation="16" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <path filter="url(#glow)" d="M512 260C531 394 630 493 764 512C630 531 531 630 512 764C493 630 394 531 260 512C394 493 493 394 512 260Z" fill="url(#spark)"/>
    <circle cx="746" cy="414" r="15" fill="#6CE8F2"/><circle cx="286" cy="604" r="10" fill="#9A7CFF"/>
  </svg>`);

const roundIcon = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
    <defs><clipPath id="round"><circle cx="512" cy="512" r="512"/></clipPath></defs>
    <g clip-path="url(#round)"><image href="data:image/svg+xml;base64,${source.toString('base64')}" width="1024" height="1024"/></g>
  </svg>`);

const mobileAssets = join(root, 'apps', 'mobile', 'assets');
await writePng(join(root, 'packages', 'desktop', 'build', 'icon.png'), 512);
await writePng(join(mobileAssets, 'icon.png'), 1024);
await writePng(join(mobileAssets, 'adaptive-icon.png'), 1024, foreground);
await writePng(join(mobileAssets, 'splash-icon.png'), 512, foreground);

const densities = new Map([
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192],
]);
for (const [density, size] of densities) {
  const directory = join(root, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`);
  await writeWebp(join(directory, 'ic_launcher.webp'), size);
  await writeWebp(join(directory, 'ic_launcher_round.webp'), size, roundIcon);
}

const splashDensities = new Map([
  ['mdpi', 100], ['hdpi', 150], ['xhdpi', 200], ['xxhdpi', 300], ['xxxhdpi', 400],
]);
for (const [density, size] of splashDensities) {
  await writePng(join(root, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res', `drawable-${density}`, 'splashscreen_logo.png'), size, foreground);
}

const favicon = join(root, 'packages', 'web', 'public', 'favicon.svg');
ensureParent(favicon);
copyFileSync(join(root, 'assets', 'brand', 'icon.svg'), favicon);
console.log('Mr.Robot brand assets generated.');
