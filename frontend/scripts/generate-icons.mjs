import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
  for (const { size, name, maskable } of [
    { size: 180, name: 'apple-touch-icon.png' },
    { size: 192, name: 'icon-192.png' },
    { size: 512, name: 'icon-512.png' },
    { size: 512, name: 'icon-maskable-512.png', maskable: true },
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>body{margin:0;background:#174f3b;display:grid;place-items:center;height:100vh}svg{width:${maskable ? 70 : 100}vw;height:${maskable ? 70 : 100}vh}</style>${svg}`,
    );
    await page.screenshot({
      path: new URL(`../public/${name}`, import.meta.url).pathname,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
