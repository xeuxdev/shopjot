import { readFile } from 'node:fs/promises';
for (const file of ['index.ts', 'sync.ts']) {
  const [frontend, backend] = await Promise.all([
    readFile(new URL(`../frontend/src/domain/${file}`, import.meta.url), 'utf8'),
    readFile(new URL(`../backend/src/domain/${file}`, import.meta.url), 'utf8'),
  ]);
  if (frontend !== backend)
    throw new Error(
      `The money/sync contract ${file} differs between frontend and backend. Update both copies together.`,
    );
}
console.log('Frontend and backend money/sync contracts match.');
