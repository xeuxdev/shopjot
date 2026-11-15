import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
  for (const size of [192, 512]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>body{margin:0;background:#174f3b}svg{width:100vw;height:100vh}</style>${svg}`,
    );
    await page.screenshot({
      path: new URL(`../public/icon-${size}.png`, import.meta.url).pathname,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
