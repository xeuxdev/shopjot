import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import regularFontUrl from '../assets/fonts/NotoSans-Regular.ttf?url';
import boldFontUrl from '../assets/fonts/NotoSans-Bold.ttf?url';
import { formatReportDate, reportNaira, type TransactionReport } from './report';

async function fontData(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The PDF font could not be loaded. Please retry the export.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Static hosts may return index.html with HTTP 200 for a missing asset.
  if (bytes.length < 4 || new DataView(bytes.buffer).getUint32(0) !== 0x00010000)
    throw new Error('The PDF font could not be loaded. Please retry the export.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export async function createTransactionsPdf(report: TransactionReport): Promise<ArrayBuffer> {
  const [regular, bold] = await Promise.all([fontData(regularFontUrl), fontData(boldFontUrl)]);
  const doc = new jsPDF({
    orientation: 'landscape',
    format: 'a4',
    compress: true,
    putOnlyUsedFonts: true,
  });
  doc.addFileToVFS('NotoSans-Regular.ttf', regular);
  doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal');
  doc.addFileToVFS('NotoSans-Bold.ttf', bold);
  doc.addFont('NotoSans-Bold.ttf', 'NotoSans', 'bold');
  doc.setProperties({
    title: `${report.storeName} — Transactions`,
    author: 'Shopjot',
    subject: 'Store transaction report in Nigerian naira',
  });
  doc.setCreationDate(new Date(report.exportedAt));
  const margin = 14;
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const usableWidth = width - margin * 2;

  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(10);
  doc.setTextColor('#174f3b');
  doc.text('SHOPJOT', margin, 16);
  doc.setFontSize(16);
  const storeLines = doc.splitTextToSize(report.storeName.replace(/\s+/g, ' '), usableWidth);
  doc.text(storeLines, margin, 26);
  let y = 26 + (storeLines.length - 1) * 6 + 7;
  doc.setFont('NotoSans', 'normal');
  doc.setFontSize(8);
  doc.setTextColor('#53645a');
  doc.text(`Store ID: ${report.storeId}`, margin, y);
  y += 5;
  doc.text(`Exported: ${formatReportDate(report.exportedAt)} · Africa/Lagos`, margin, y);
  y += 10;
  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(14);
  doc.setTextColor('#253b31');
  doc.text('Transactions', margin, y);
  y += 6;
  doc.setFont('NotoSans', 'normal');
  doc.setFontSize(8);
  doc.text(
    'All saved sales. Received and outstanding include repayments through the export time.',
    margin,
    y,
  );
  y += 9;
  const summaries = [
    ['Total sales', report.totals.salesKobo],
    ['Amount received', report.totals.receivedKobo],
    ['Outstanding', report.totals.outstandingKobo],
  ] as const;
  summaries.forEach(([label, amount], index) => {
    const x = margin + (usableWidth / 3) * index;
    doc.setFont('NotoSans', 'normal');
    doc.setFontSize(8);
    doc.text(label, x, y);
    doc.setFont('NotoSans', 'bold');
    doc.setFontSize(12);
    doc.text(`₦${reportNaira(amount, true)}`, x, y + 7);
  });
  y += 12;
  if (report.rows.some((row) => row.status === 'Voided')) {
    doc.setFont('NotoSans', 'normal');
    doc.setFontSize(8);
    doc.text('Voided sales are listed for reference and excluded from summary totals.', margin, y);
    y += 6;
  }
  autoTable(doc, {
    startY: y,
    margin: { top: 24, right: margin, bottom: 18, left: margin },
    theme: 'striped',
    head: [
      [
        'Date (Africa/Lagos)',
        'Customer',
        'Sale ID',
        'Total (₦)',
        'Received (₦)',
        'Outstanding (₦)',
        'Status',
      ],
    ],
    body: report.rows.length
      ? report.rows.map((row) => [
          row.date,
          row.customer,
          row.id,
          row.total,
          row.received,
          row.outstanding,
          row.status,
        ])
      : [
          [
            {
              content: 'No transactions have been recorded yet.',
              colSpan: 7,
              styles: { halign: 'center', cellPadding: 10 },
            },
          ],
        ],
    styles: {
      font: 'NotoSans',
      fontStyle: 'normal',
      fontSize: 8,
      cellPadding: 3,
      overflow: 'linebreak',
      textColor: '#253b31',
      lineColor: '#e6eae6',
    },
    headStyles: { fillColor: '#174f3b', textColor: '#ffffff', fontStyle: 'bold' },
    alternateRowStyles: { fillColor: '#f6f8f6' },
    columnStyles: {
      0: { cellWidth: 43 },
      1: { cellWidth: 45 },
      2: { cellWidth: 55, fontSize: 7 },
      3: { cellWidth: 32, halign: 'right' },
      4: { cellWidth: 31, halign: 'right' },
      5: { cellWidth: 35, halign: 'right' },
      6: { cellWidth: usableWidth - 241 },
    },
    rowPageBreak: 'avoid',
    showHead: 'everyPage',
    willDrawPage: ({ pageNumber }) => {
      if (pageNumber === 1) return;
      doc.setFont('NotoSans', 'bold');
      doc.setFontSize(10);
      doc.setTextColor('#174f3b');
      doc.text('Shopjot · Transactions', margin, 15);
      doc.setFont('NotoSans', 'normal');
      doc.setFontSize(8);
      doc.text(`Store ID: ${report.storeId}`, width - margin, 15, { align: 'right' });
    },
  });
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont('NotoSans', 'normal');
    doc.setFontSize(8);
    doc.setTextColor('#53645a');
    doc.text('Amounts in Nigerian naira · Times in Africa/Lagos', margin, height - 9);
    doc.text(`Page ${page} of ${pages}`, width - margin, height - 9, { align: 'right' });
  }
  return doc.output('arraybuffer');
}
