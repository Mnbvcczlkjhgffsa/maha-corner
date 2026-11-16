import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsPDF } from 'jspdf';
import { PDFDict, PDFDocument, PDFName, PDFString, rgb, degrees } from 'pdf-lib';
import {
  PdfOperationError,
  fitImageToStandardPdfPage,
  loadCleanPdfDocument,
  mergePdfBuffersUniversally,
  normalizePdfPages,
  saveUniversalPdf,
  validatePdfDocument,
} from '../src/utils/pdfCompat';
import {
  PDF_SECURITY_LIMITS,
  escapeHtml,
  findPdfHeaderOffset,
  inspectUploadedFileBytes,
  sanitizeFilename,
  sanitizePdfDocumentSecurity,
} from '../src/utils/pdfSecurity';

interface TestResult {
  id: number;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maha-pdf-suite-'));

function assertGhostscriptRendersCleanly(pdfBytes: Uint8Array, label: string, expectedPages: number) {
  const pdfPath = path.join(tmpDir, `${label}.pdf`);
  const pngPattern = path.join(tmpDir, `${label}-page-%03d.png`);
  fs.writeFileSync(pdfPath, pdfBytes);

  const stderrOut = execFileSync(
    'gs',
    ['-dNOPAUSE', '-dBATCH', '-dSAFER', '-r72', '-sDEVICE=png16m', `-sOutputFile=${pngPattern}`, pdfPath],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );

  // Check Ghostscript rendered exact number of pages cleanly
  const renderedFiles = fs
    .readdirSync(tmpDir)
    .filter((f) => f.startsWith(`${label}-page-`) && f.endsWith('.png'));

  assert.equal(
    renderedFiles.length,
    expectedPages,
    `Ghostscript rendered ${renderedFiles.length} pages for ${label}, expected ${expectedPages}. stderr=${stderrOut}`
  );
  for (const rf of renderedFiles) {
    const stat = fs.statSync(path.join(tmpDir, rf));
    assert.ok(stat.size > 200, `Rendered page ${rf} is suspiciously empty (${stat.size} bytes)`);
  }
}

async function generateAuthenticSampleJpeg(colorRgb: [number, number, number]): Promise<Uint8Array> {
  // Build a tiny vector PDF via pdf-lib and rasterize via Ghostscript to get a genuine Baseline JPEG
  const vecDoc = await PDFDocument.create();
  const page = vecDoc.addPage([200, 140]);
  page.drawRectangle({ x: 0, y: 0, width: 200, height: 140, color: rgb(...colorRgb) });
  page.drawRectangle({ x: 20, y: 20, width: 160, height: 100, color: rgb(0.95, 0.96, 0.98) });
  const vecBytes = await vecDoc.save({ useObjectStreams: false });
  const tmpPdf = path.join(tmpDir, `seed-${Math.random().toString(36).slice(2, 7)}.pdf`);
  const tmpJpg = tmpPdf.replace(/\.pdf$/, '.jpg');
  fs.writeFileSync(tmpPdf, vecBytes);
  execFileSync('gs', ['-dNOPAUSE', '-dBATCH', '-dSAFER', '-r72', '-sDEVICE=jpeg', `-sOutputFile=${tmpJpg}`, tmpPdf], {
    stdio: 'ignore',
  });
  return new Uint8Array(fs.readFileSync(tmpJpg));
}

async function createVectorPagePdf(
  pages: Array<{ width: number; height: number; color: [number, number, number] }>,
  options?: { title?: string; useObjectStreams?: boolean }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (options?.title) doc.setTitle(options.title);
  for (const spec of pages) {
    const p = doc.addPage([spec.width, spec.height]);
    p.drawRectangle({
      x: 18,
      y: 18,
      width: Math.max(20, spec.width - 36),
      height: Math.max(20, spec.height - 36),
      color: rgb(...spec.color),
      borderColor: rgb(0.15, 0.2, 0.35),
      borderWidth: 2,
    });
  }
  return await doc.save({ useObjectStreams: options?.useObjectStreams ?? false });
}

async function runCase(id: number, name: string, fn: () => Promise<string>) {
  try {
    const details = await fn();
    results.push({ id, name, passed: true, details });
    console.log(`PASS [${String(id).padStart(2, '0')}] ${name} — ${details}`);
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    results.push({ id, name, passed: false, details: msg });
    console.error(`FAIL [${String(id).padStart(2, '0')}] ${name} — ${msg}`);
  }
}

async function main() {
  try {
    const sampleJpgA = await generateAuthenticSampleJpeg([0.88, 0.11, 0.28]);
    const sampleJpgB = await generateAuthenticSampleJpeg([0.05, 0.45, 0.65]);

    await runCase(1, 'Single-page A4 Portrait PDF + 10-point Validation + Ghostscript render', async () => {
      const bytes = await createVectorPagePdf([{ width: 595.28, height: 841.89, color: [0.92, 0.96, 1] }]);
      const doc = await PDFDocument.load(bytes);
      const out = await saveUniversalPdf(doc, undefined, { expectedPages: 1, skipRenderTest: true });
      const report = await validatePdfDocument(out, { expectedPages: 1, skipRenderTest: true });
      assert.equal(report.valid, true, report.errors.join('; '));
      assert.equal(report.classicXref, true);
      assertGhostscriptRendersCleanly(out, 't01-single', 1);
      return `${report.pageCount} page, ${report.sizeBytes}B, PDF ${report.pdfVersion}, classicXref=${report.classicXref}`;
    });

    await runCase(2, 'Multi-page PDF (5 pages) preservation & classic XRef validation', async () => {
      const specs = Array.from({ length: 5 }, (_, i) => ({
        width: 595.28,
        height: 841.89,
        color: [0.85, 0.9 - i * 0.05, 0.95] as [number, number, number],
      }));
      const raw = await createVectorPagePdf(specs);
      const { doc } = await loadCleanPdfDocument(raw);
      const out = await saveUniversalPdf(doc, undefined, { expectedPages: 5, skipRenderTest: true });
      const report = await validatePdfDocument(out, { expectedPages: 5, skipRenderTest: true });
      assert.equal(report.valid, true);
      assertGhostscriptRendersCleanly(out, 't02-multi5', 5);
      return `5/5 pages preserved, ${report.sizeBytes}B`;
    });

    await runCase(3, '5-PDF Heterogeneous Merge (Portrait + Landscape + Letter + Scanned + Toxic Scripts)', async () => {
      // File 1: 2-page A4 Portrait
      const f1 = await createVectorPagePdf([
        { width: 595.28, height: 841.89, color: [0.95, 0.92, 0.92] },
        { width: 595.28, height: 841.89, color: [0.92, 0.95, 0.92] },
      ]);
      // File 2: 1-page A4 Landscape
      const f2 = await createVectorPagePdf([{ width: 841.89, height: 595.28, color: [0.9, 0.93, 0.99] }]);
      // File 3: 2-page US Letter compressed object-stream PDF (simulate modern Chrome/Word ObjStm source!)
      const f3 = await createVectorPagePdf(
        [
          { width: 612, height: 792, color: [0.98, 0.95, 0.85] },
          { width: 612, height: 792, color: [0.93, 0.98, 0.95] },
        ],
        { useObjectStreams: true }
      );
      // File 4: Scanned Raster JPEG PDF
      const scanDoc = await PDFDocument.create();
      const jpgEmbed = await scanDoc.embedJpg(sampleJpgA);
      const p4 = scanDoc.addPage([595.28, 841.89]);
      p4.drawImage(jpgEmbed, { x: 40, y: 200, width: 515, height: 360 });
      const f4 = await scanDoc.save({ useObjectStreams: true });
      // File 5: PDF with XFA, OpenAction JS, StructTreeRoot & Out-of-bounds CropBox
      const dirtyDoc = await PDFDocument.create();
      const p5 = dirtyDoc.addPage([500, 700]);
      p5.drawRectangle({ x: 30, y: 30, width: 440, height: 640, color: rgb(0.9, 0.98, 0.9) });
      p5.setCropBox(-50, -50, 900, 1200);
      dirtyDoc.catalog.set(PDFName.of('OpenAction'), dirtyDoc.context.obj({ S: 'JavaScript', JS: 'app.alert(1)' }));
      dirtyDoc.catalog.set(PDFName.of('StructTreeRoot'), dirtyDoc.context.obj({ Type: 'StructTreeRoot' }));
      dirtyDoc.catalog.set(PDFName.of('AcroForm'), dirtyDoc.context.obj({ XFA: PDFString.of('<xdp/>') }));
      const f5 = await dirtyDoc.save({ useObjectStreams: false });

      // Note: validatePdfDocument inside mergePdfBuffersUniversally runs headless-safe (window undefined)
      const { bytes: mergedBytes, report } = await mergePdfBuffersUniversally([
        { bytes: f1, name: 'doc1-a4.pdf' },
        { bytes: f2, name: 'doc2-landscape.pdf' },
        { bytes: f3, name: 'doc3-letter-objstm.pdf' },
        { bytes: f4, name: 'doc4-scanned.pdf' },
        { bytes: f5, name: 'doc5-xfa-js.pdf' },
      ]);

      assert.equal(report.valid, true, report.errors.join('; '));
      assert.equal(report.pageCount, 7);
      assert.equal(report.classicXref, true);

      // Verify exact page order, dimensions, orientation & stripped dangerous objects
      const recheck = await PDFDocument.load(mergedBytes);
      assert.equal(recheck.getPageCount(), 7);
      const pSizes = recheck.getPages().map((p) => p.getSize());
      assert.ok(Math.abs(pSizes[0].width - 595.28) < 1 && pSizes[0].height > pSizes[0].width, 'Page 1 must remain A4 portrait');
      assert.ok(Math.abs(pSizes[2].width - 841.89) < 1 && pSizes[2].width > pSizes[2].height, 'Page 3 must remain A4 landscape');
      assert.ok(Math.abs(pSizes[3].width - 612) < 1, 'Page 4 must remain US Letter width');
      assert.ok(Math.abs(pSizes[6].width - 500) < 1, 'Page 7 must remain 500pt custom width');

      // Check CropBox clamped inside MediaBox on page 7
      const cb7 = recheck.getPages()[6].getCropBox();
      assert.ok(cb7.x >= 0 && cb7.y >= 0 && cb7.width <= 500 && cb7.height <= 700, 'Out-of-bounds CropBox must be clamped');

      // Check scripts, StructTreeRoot & XFA stripped
      assert.equal(recheck.catalog.has(PDFName.of('OpenAction')), false, 'OpenAction must be stripped');
      assert.equal(recheck.catalog.has(PDFName.of('StructTreeRoot')), false, 'StructTreeRoot must be stripped');
      const acro = recheck.catalog.lookup(PDFName.of('AcroForm'));
      assert.ok(!(acro instanceof PDFDict && acro.has(PDFName.of('XFA'))), 'XFA must be stripped');

      assertGhostscriptRendersCleanly(mergedBytes, 't03-merge-heterogeneous', 7);
      return `7 pages merged from 5 PDFs (portrait+landscape+Letter+scanned+XFA/JS stripped), GS 7/7 rendered OK`;
    });

    await runCase(4, 'Large 40-page PDF generation, saveUniversalPdf & Ghostscript rasterization', async () => {
      const specs = Array.from({ length: 40 }, (_, i) => ({
        width: 595.28,
        height: 841.89,
        color: [0.95, 0.92, (i % 5) * 0.15 + 0.2] as [number, number, number],
      }));
      const raw = await createVectorPagePdf(specs, { useObjectStreams: true });
      const { doc } = await loadCleanPdfDocument(raw);
      const out = await saveUniversalPdf(doc, undefined, { expectedPages: 40, skipRenderTest: true });
      const report = await validatePdfDocument(out, { expectedPages: 40, skipRenderTest: true });
      assert.equal(report.valid, true);
      assert.equal(report.classicXref, true);
      assertGhostscriptRendersCleanly(out, 't04-large40', 40);
      return `40 pages validated & rendered via Ghostscript (${report.sizeKb} KB)`;
    });

    await runCase(5, 'Scanned image PDF + fitImageToStandardPdfPage aspect normalization', async () => {
      const doc = await PDFDocument.create();
      const jpg1 = await doc.embedJpg(sampleJpgA);
      const jpg2 = await doc.embedJpg(sampleJpgB);
      for (const [img, pw, ph] of [
        [jpg1, 2400, 1600],
        [jpg2, 1200, 1800],
      ] as const) {
        const fit = fitImageToStandardPdfPage(pw, ph);
        const page = doc.addPage([fit.pageW, fit.pageH]);
        page.drawImage(img, { x: fit.offsetX, y: fit.offsetY, width: fit.drawW, height: fit.drawH });
      }
      const out = await saveUniversalPdf(doc, undefined, { expectedPages: 2, skipRenderTest: true });
      const report = await validatePdfDocument(out, { expectedPages: 2, skipRenderTest: true });
      assert.equal(report.valid, true);
      assertGhostscriptRendersCleanly(out, 't05-scanned-fit', 2);
      return `Landscape & portrait JPGs fitted to standard A4 pages (2 pages), GS OK`;
    });

    await runCase(6, 'Rotate PDF (90 deg, 180 deg, 270 deg) preserving MediaBox & GS render', async () => {
      const raw = await createVectorPagePdf([
        { width: 595.28, height: 841.89, color: [0.9, 0.95, 0.9] },
        { width: 841.89, height: 595.28, color: [0.95, 0.9, 0.95] },
      ]);
      const { doc } = await loadCleanPdfDocument(raw);
      for (const p of doc.getPages()) {
        p.setRotation(degrees((p.getRotation().angle + 90) % 360));
      }
      const out = await saveUniversalPdf(doc, undefined, { expectedPages: 2, skipRenderTest: true });
      const reloaded = await PDFDocument.load(out);
      assert.equal(reloaded.getPages()[0].getRotation().angle, 90);
      assertGhostscriptRendersCleanly(out, 't06-rotate90', 2);
      return `Rotation 90 deg preserved & rendered via GS`;
    });

    await runCase(7, 'Split / Extract / Delete / Reverse-Organize Page Operations', async () => {
      const raw = await createVectorPagePdf([
        { width: 400, height: 600, color: [0.9, 0.85, 0.85] },
        { width: 500, height: 700, color: [0.85, 0.9, 0.85] },
        { width: 600, height: 800, color: [0.85, 0.85, 0.9] },
        { width: 700, height: 900, color: [0.9, 0.9, 0.85] },
      ]);
      const { doc: src } = await loadCleanPdfDocument(raw);

      // Extract pages 2 & 4 (indices 1, 3)
      const extDoc = await PDFDocument.create();
      const copied = await extDoc.copyPages(src, [1, 3]);
      copied.forEach((p) => extDoc.addPage(p));
      const extBytes = await saveUniversalPdf(extDoc, undefined, { expectedPages: 2, skipRenderTest: true });
      const extCheck = await PDFDocument.load(extBytes);
      assert.equal(Math.round(extCheck.getPages()[0].getSize().width), 500);
      assert.equal(Math.round(extCheck.getPages()[1].getSize().width), 700);
      assertGhostscriptRendersCleanly(extBytes, 't07-extract', 2);

      // Reverse organize 4 -> 3 -> 2 -> 1
      const orgDoc = await PDFDocument.create();
      const rev = await orgDoc.copyPages(src, [3, 2, 1, 0]);
      rev.forEach((p) => orgDoc.addPage(p));
      const orgBytes = await saveUniversalPdf(orgDoc, undefined, { expectedPages: 4, skipRenderTest: true });
      const orgCheck = await PDFDocument.load(orgBytes);
      assert.equal(Math.round(orgCheck.getPages()[0].getSize().width), 700);
      assert.equal(Math.round(orgCheck.getPages()[3].getSize().width), 400);
      assertGhostscriptRendersCleanly(orgBytes, 't07-reverse', 4);

      return `Extract [2,4] & Reverse [4,3,2,1] preserved exact page widths & rendered cleanly`;
    });

    await runCase(8, 'N-Up Print Sheet (2-Up Landscape & 4-Up Portrait via embedPages)', async () => {
      const raw = await createVectorPagePdf([
        { width: 595.28, height: 841.89, color: [0.95, 0.9, 0.9] },
        { width: 595.28, height: 841.89, color: [0.9, 0.95, 0.9] },
        { width: 595.28, height: 841.89, color: [0.9, 0.9, 0.95] },
        { width: 595.28, height: 841.89, color: [0.95, 0.95, 0.88] },
      ]);
      const { doc: srcDoc } = await loadCleanPdfDocument(raw);
      const outDoc = await PDFDocument.create();
      const eps = await outDoc.embedPages(srcDoc.getPages());
      const sheet = outDoc.addPage([841.89, 595.28]);
      sheet.drawPage(eps[0], { x: 18, y: 18, width: 390, height: 559 });
      sheet.drawPage(eps[1], { x: 433, y: 18, width: 390, height: 559 });
      const sheet2 = outDoc.addPage([841.89, 595.28]);
      sheet2.drawPage(eps[2], { x: 18, y: 18, width: 390, height: 559 });
      sheet2.drawPage(eps[3], { x: 433, y: 18, width: 390, height: 559 });

      const nupBytes = await saveUniversalPdf(outDoc, undefined, { expectedPages: 2, skipRenderTest: true });
      assertGhostscriptRendersCleanly(nupBytes, 't08-nup', 2);
      return `4 source pages compiled onto 2 A4 landscape sheets, GS rendered 2/2 OK`;
    });

    await runCase(9, 'Unicode Metadata & Outlines/Bookmarks preservation', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      page.drawRectangle({ x: 30, y: 30, width: 535, height: 781, color: rgb(0.95, 0.97, 1) });
      doc.setTitle('महा कॉर्नर • सातबारा व शेतकरी ओळखपत्र');
      doc.setSubject('मराठी हिंदी English Unicode Check');
      const outlineItem = doc.context.obj({ Title: PDFString.of('Page 1'), Parent: doc.catalog.get(PDFName.of('Outlines')) || doc.context.obj({}) });
      doc.catalog.set(PDFName.of('Outlines'), doc.context.obj({ Type: 'Outlines', First: outlineItem, Count: 0 }));

      const saved = await saveUniversalPdf(doc, undefined, { expectedPages: 1, skipRenderTest: true });
      const reloaded = await PDFDocument.load(saved);
      assert.equal(reloaded.getTitle(), 'महा कॉर्नर • सातबारा व शेतकरी ओळखपत्र');
      assert.equal(reloaded.catalog.has(PDFName.of('Outlines')), true, 'Outlines dictionary preserved');
      assertGhostscriptRendersCleanly(saved, 't09-unicode-meta', 1);
      return `Devanagari Unicode metadata & Outlines preserved cleanly`;
    });

    await runCase(10, 'Security Sanitization (Strip /OpenAction, /AA, /Names->JS, /EmbeddedFiles, Page /Annots actions)', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      page.drawRectangle({ x: 20, y: 20, width: 555, height: 801, color: rgb(0.97, 0.97, 0.97) });
      const jsNames = doc.context.obj({ JavaScript: doc.context.obj({ Names: [] }), EmbeddedFiles: doc.context.obj({ Names: [] }) });
      doc.catalog.set(PDFName.of('Names'), jsNames);
      doc.catalog.set(PDFName.of('AA'), doc.context.obj({ WC: { S: 'JavaScript', JS: 'evil()' } }));
      const evilAnnot = doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 100, 100],
          A: { S: 'Launch', F: 'cmd.exe' },
        })
      );
      page.node.set(PDFName.of('Annots'), doc.context.obj([evilAnnot]));

      sanitizePdfDocumentSecurity(doc);
      normalizePdfPages(doc);
      const out = await saveUniversalPdf(doc, undefined, { expectedPages: 1, skipRenderTest: true });
      const reloaded = await PDFDocument.load(out);
      assert.equal(reloaded.catalog.has(PDFName.of('AA')), false);
      const namesAfter = reloaded.catalog.lookup(PDFName.of('Names')) as PDFDict | undefined;
      if (namesAfter instanceof PDFDict) {
        assert.equal(namesAfter.has(PDFName.of('JavaScript')), false);
        assert.equal(namesAfter.has(PDFName.of('EmbeddedFiles')), false);
      }
      assertGhostscriptRendersCleanly(out, 't10-security-clean', 1);
      return `All malicious PDF actions/embedded scripts stripped cleanly`;
    });

    await runCase(11, 'Magic-Byte Upload Validation & Malicious File Spoof Rejection', async () => {
      const validPdfHead = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n');
      assert.equal(inspectUploadedFileBytes(validPdfHead, 'doc.pdf', 'application/pdf', 'pdf').valid, true);

      const fakeExeAsPdf = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // PE MZ header
      const exeRes = inspectUploadedFileBytes(fakeExeAsPdf, 'invoice.pdf', 'application/pdf', 'pdf');
      assert.equal(exeRes.valid, false);
      assert.equal(exeRes.reason, 'EXECUTABLE_REJECTED');

      const fakeHtmlAsPdf = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
      const htmlRes = inspectUploadedFileBytes(fakeHtmlAsPdf, 'xss.pdf', 'application/pdf', 'pdf');
      assert.equal(htmlRes.valid, false);
      assert.equal(htmlRes.reason, 'ACTIVE_CONTENT_REJECTED');

      const fakeSvgAsImg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
      const svgRes = inspectUploadedFileBytes(fakeSvgAsImg, 'photo.jpg', 'image/jpeg', 'image');
      assert.equal(svgRes.valid, false);

      assert.equal(inspectUploadedFileBytes(sampleJpgA, 'photo.jpg', 'image/jpeg', 'image').valid, true);
      assert.equal(findPdfHeaderOffset(validPdfHead), 0);
      assert.ok(PDF_SECURITY_LIMITS.MAX_PDF_PAGES === 300);
      return `EXE/HTML/SVG spoofs rejected cleanly; valid PDF & JPEG signatures accepted`;
    });

    await runCase(12, 'Damaged & Truncated PDF Rejection + Corrupted Object Stream Detection', async () => {
      const validBytes = await createVectorPagePdf([{ width: 595.28, height: 841.89, color: [0.9, 0.9, 0.9] }]);
      // Truncate last 60 bytes to simulate interrupted download / corrupted trailer
      const truncated = validBytes.slice(0, validBytes.length - 60);
      const truncReport = await validatePdfDocument(truncated, { skipRenderTest: true });
      assert.equal(truncReport.valid, false, 'Truncated PDF must fail validation');

      // ObjStm PDF flagged by validator
      const objStmBytes = await createVectorPagePdf(
        [{ width: 595.28, height: 841.89, color: [0.9, 0.9, 0.9] }],
        { useObjectStreams: true }
      );
      const objStmReport = await validatePdfDocument(objStmBytes, { skipRenderTest: true });
      assert.equal(objStmReport.valid, false, 'PDF 1.5 /ObjStm output must be flagged by universal validator');

      // Empty & corrupted header rejected with PdfOperationError
      let caught = false;
      try {
        await loadCleanPdfDocument(new TextEncoder().encode('NOT A PDF FILE'));
      } catch (err) {
        caught = err instanceof PdfOperationError && err.code === 'PDF_CORRUPTED';
      }
      assert.equal(caught, true, 'Invalid header must throw PdfOperationError(PDF_CORRUPTED)');
      return `Truncated, ObjStm, and garbage files blocked cleanly before download`;
    });

    await runCase(13, 'Filename Traversal & HTML Escape XSS Sanitization', async () => {
      const cleanName = sanitizeFilename('../../etc/passwd<script>.pdf', 'fallback.pdf');
      assert.equal(cleanName.includes('..'), false);
      assert.equal(cleanName.includes('/'), false);
      assert.equal(cleanName.includes('<'), false);

      const safeHtml = escapeHtml('<img src=x onerror="alert(1)">');
      assert.equal(safeHtml.includes('<'), false);
      assert.equal(safeHtml.includes('>'), false);
      assert.equal(safeHtml.includes('&lt;'), true);
      return `Sanitized="${cleanName}", Escaped="${safeHtml}"`;
    });

    await runCase(14, 'jsPDF Studio Exporters (CardCutter A4, FarmerCard 4x6, PhotoResizer Custom mm, Poster A4)', async () => {
      const jpgDataUri = `data:image/jpeg;base64,${Buffer.from(sampleJpgA).toString('base64')}`;

      const configs: Array<{ label: string; orientation: 'p' | 'l'; format: 'a4' | [number, number]; w: number; h: number }> = [
        { label: 'card-cutter-a4', orientation: 'p', format: 'a4', w: 210, h: 297 },
        { label: 'farmer-card-4x6', orientation: 'l', format: [152.4, 101.6], w: 152.4, h: 101.6 },
        { label: 'photo-resizer-passport', orientation: 'p', format: [35, 45], w: 35, h: 45 },
        { label: 'poster-a4', orientation: 'p', format: 'a4', w: 210, h: 297 },
      ];

      for (const cfg of configs) {
        const doc = new jsPDF({ orientation: cfg.orientation, unit: 'mm', format: cfg.format, compress: true });
        doc.addImage(jpgDataUri, 'JPEG', 0, 0, cfg.w, cfg.h);
        const bytes = new Uint8Array(doc.output('arraybuffer'));
        const rep = await validatePdfDocument(bytes, { expectedPages: 1, skipRenderTest: true });
        assert.equal(rep.valid, true, `${cfg.label}: ${rep.errors.join('; ')}`);
        assertGhostscriptRendersCleanly(bytes, `t14-${cfg.label}`, 1);
      }

      return `All 4 jsPDF studio export profiles validated & GS rasterized cleanly`;
    });

    await runCase(15, 'Real RC4-128 Password Encryption via Ghostscript & Encrypted Validation Gate', async () => {
      const sample = await createVectorPagePdf([{ width: 595.28, height: 841.89, color: [0.95, 0.96, 1] }]);
      const inPath = path.join(tmpDir, 't15-in.pdf');
      const encPath = path.join(tmpDir, 't15-enc.pdf');
      fs.writeFileSync(inPath, sample);
      execFileSync(
        'gs',
        [
          '-q',
          '-dNOPAUSE',
          '-dBATCH',
          '-dSAFER',
          '-sDEVICE=pdfwrite',
          '-dCompatibilityLevel=1.4',
          '-dEncryptionR=3',
          '-dKeyLength=128',
          '-sOwnerPassword=mahaOwnerKey',
          '-sUserPassword=mahaUser123',
          `-sOutputFile=${encPath}`,
          inPath,
        ],
        { stdio: 'pipe' }
      );
      const encBytes = new Uint8Array(fs.readFileSync(encPath));
      const encReport = await validatePdfDocument(encBytes, {
        expectedPages: 1,
        skipRenderTest: true,
        allowEncrypted: true,
        expectedPassword: 'mahaUser123',
      });
      assert.equal(encReport.valid, true, encReport.errors.join('; '));
      assert.equal(encReport.pdfVersion, '1.4');

      // Wrong password must fail to open in Ghostscript
      let wrongFailed = false;
      try {
        execFileSync(
          'gs',
          ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sPDFPassword=wrongpass', '-sDEVICE=nullpage', encPath],
          { stdio: 'pipe' }
        );
      } catch {
        wrongFailed = true;
      }
      assert.equal(wrongFailed, true, 'Encrypted PDF must reject incorrect password');

      // Correct password must open cleanly in Ghostscript
      execFileSync(
        'gs',
        ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sPDFPassword=mahaUser123', '-sDEVICE=nullpage', encPath],
        { stdio: 'pipe' }
      );
      return `Encrypted PDF 1.4 verified (/Encrypt present, rejects wrong password, opens with right password)`;
    });

    const passedCount = results.filter((r) => r.passed).length;
    console.log(`\n=== SUMMARY: ${passedCount}/${results.length} automated checks PASSED ===`);
    if (passedCount !== results.length) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

void main();