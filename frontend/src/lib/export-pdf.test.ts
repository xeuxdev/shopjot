import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTransactionsPdf } from './export-pdf';
import { transactionReport, type TransactionReport } from './report';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const font = url.includes('Bold') ? 'NotoSans-Bold.ttf' : 'NotoSans-Regular.ttf';
      return new Response(
        new Uint8Array(await readFile(new URL(`../assets/fonts/${font}`, import.meta.url))),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function emptyReport(): TransactionReport {
  return transactionReport(
    { store: { id: 'store', name: 'Nnéka’s Shop' }, sales: [], customers: [], payments: [] },
    'store',
    new Date('2026-11-18T12:40:43.000Z'),
  );
}

it('generates a real PDF for an empty ledger', async () => {
  const pdf = new TextDecoder('latin1').decode(await createTransactionsPdf(emptyReport()));
  expect(pdf.startsWith('%PDF-')).toBe(true);
  expect(pdf).toContain('%%EOF');
  expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(1);
});

it('paginates a large transaction report with long names', async () => {
  const report = emptyReport();
  report.storeName = 'A very long store name '.repeat(7).trim();
  report.rows = Array.from({ length: 100 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    customer: 'Nnéka Chịka '.repeat(10).trim(),
    date: '18/11/2026, 01:40:43 pm',
    total: '1.01',
    received: '0.01',
    outstanding: '1.00',
    status: 'Part payment',
  }));
  const pdf = new TextDecoder('latin1').decode(await createTransactionsPdf(report));
  expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  expect(pdf).toContain('%%EOF');
});

it('reports a failed font load instead of downloading a broken document', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  );
  await expect(createTransactionsPdf(emptyReport())).rejects.toThrow(
    'PDF font could not be loaded',
  );
});

it('rejects an HTML fallback returned with a successful status for a missing font', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<!doctype html><html></html>')),
  );
  await expect(createTransactionsPdf(emptyReport())).rejects.toThrow(
    'PDF font could not be loaded',
  );
});
