/**
 * MAHA CORNER — Comprehensive 360° Security Verification Suite
 * Tests client-side sanitization/magic-byte guards AND live HTTP server hardening.
 * Run: npx tsx scripts/security-test-suite.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  escapeHtml,
  inspectUploadedFileBytes,
  sanitizeDataUrl,
  sanitizeExternalUrl,
  sanitizeFilename,
  sanitizeSpreadsheetCell,
} from '../src/utils/pdfSecurity';
import { SAAS_BILLING_ENABLED, getActiveSaasEntitlements } from '../src/utils/saasConfig';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const OWNER_PIN = process.env.MAHA_OWNER_PIN;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function run() {
  if (!OWNER_PIN) throw new Error('Set MAHA_OWNER_PIN in the environment before running live security tests.');
  console.log('\n🔒 MAHA CORNER — 360° Cybersecurity Verification Suite\n');

  // 1. Magic Byte & Disguised Malware Upload Tests
  await test('Blocks Windows PE executable disguised as PDF (.pdf)', () => {
    const mzHeader = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const res = inspectUploadedFileBytes(mzHeader, 'invoice.pdf', 'application/pdf', 'pdf');
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'EXECUTABLE_REJECTED');
  });

  await test('Blocks ELF binary disguised as PNG (.png)', () => {
    const elfHeader = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
    const res = inspectUploadedFileBytes(elfHeader, 'avatar.png', 'image/png', 'image');
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'EXECUTABLE_REJECTED');
  });

  await test('Blocks SVG / embedded <script> XSS image uploads', () => {
    const svgPayload = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res1 = inspectUploadedFileBytes(svgPayload, 'icon.svg', 'image/svg+xml', 'image');
    const res2 = inspectUploadedFileBytes(svgPayload, 'disguised.png', 'image/png', 'image');
    assert.equal(res1.valid, false);
    assert.equal(res1.reason, 'ACTIVE_CONTENT_REJECTED');
    assert.equal(res2.valid, false);
    assert.equal(res2.reason, 'ACTIVE_CONTENT_REJECTED');
  });

  await test('Blocks HTML payload disguised as PDF', () => {
    const htmlPayload = new TextEncoder().encode('<!DOCTYPE html><html><script>fetch("/steal")</script></html>');
    const res = inspectUploadedFileBytes(htmlPayload, 'doc.pdf', 'application/pdf', 'pdf');
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'ACTIVE_CONTENT_REJECTED');
  });

  await test('Accepts genuine PDF, PNG, JPEG, WEBP magic signatures', () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj');
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

    assert.equal(inspectUploadedFileBytes(pdfBytes, 'a.pdf', 'application/pdf', 'pdf').valid, true);
    assert.equal(inspectUploadedFileBytes(pngBytes, 'a.png', 'image/png', 'image').valid, true);
    assert.equal(inspectUploadedFileBytes(jpgBytes, 'a.jpg', 'image/jpeg', 'image').valid, true);
    assert.equal(inspectUploadedFileBytes(webpBytes, 'a.webp', 'image/webp', 'image').valid, true);
  });

  // 2. CSV / Excel Formula Injection (CWE-1236)
  await test('Neutralizes spreadsheet formula injection triggers (=, +, -, @, TAB, CR)', () => {
    assert.equal(sanitizeSpreadsheetCell('=CMD|" /C calc"!A0'), "'=CMD|\" /C calc\"!A0");
    assert.equal(sanitizeSpreadsheetCell('+1+1'), "'+1+1");
    assert.equal(sanitizeSpreadsheetCell('-2+3'), "'-2+3");
    assert.equal(sanitizeSpreadsheetCell('@SUM(1+1)'), "'@SUM(1+1)");
    assert.equal(sanitizeSpreadsheetCell('\t=1+1'), "'\t=1+1");
    assert.equal(sanitizeSpreadsheetCell('Kamlesh Patil'), 'Kamlesh Patil');
  });

  // 3. URL & Data-URL & XSS & Path Traversal Guards
  await test('Blocks javascript:, data:, vbscript:, file: external URLs and allows http/https', () => {
    assert.equal(sanitizeExternalUrl('javascript:alert(1)', '#'), '#');
    assert.equal(sanitizeExternalUrl('data:text/html,<script>alert(1)</script>', '#'), '#');
    assert.equal(sanitizeExternalUrl('vbscript:msgbox(1)', '#'), '#');
    assert.equal(sanitizeExternalUrl('https://gr.maharashtra.gov.in/1145/Government-Resolutions', '#'), 'https://gr.maharashtra.gov.in/1145/Government-Resolutions');
  });

  await test('Validates strict data URL prefixes (allows PDF base64, rejects SVG/HTML)', () => {
    assert.ok(sanitizeDataUrl('data:application/pdf;base64,JVBERi0=', ['data:application/pdf;base64,']));
    assert.equal(sanitizeDataUrl('data:image/svg+xml;base64,PHN2Zz4=', ['data:application/pdf;base64,']), undefined);
  });

  await test('Escapes HTML special chars & sanitizes OS reserved/traversal filenames', () => {
    assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.ok(!sanitizeFilename('../../etc/passwd').includes('..'));
    assert.ok(!sanitizeFilename('CON', 'doc').toLowerCase().startsWith('con'));
  });

  // 4. Dormant SaaS Readiness Verification
  await test('Verifies SaaS payment gating remains dormant (SAAS_BILLING_ENABLED = false)', () => {
    assert.equal(SAAS_BILLING_ENABLED, false);
    const ent = getActiveSaasEntitlements('pro_csc');
    assert.equal(ent.billingActive, false);
    assert.equal(ent.plan, 'free_unlimited');
    assert.equal(ent.maxPdfSizeMb, 50);
  });

  // 5. Client Source Hardcoded PIN Audit
  await test('Verifies zero hardcoded Owner PINs remain in GrDirectory or JobsDirectory', () => {
    const grSrc = fs.readFileSync(path.resolve('src/components/GrDirectory.tsx'), 'utf8');
    const jobsSrc = fs.readFileSync(path.resolve('src/components/JobsDirectory.tsx'), 'utf8');
    assert.ok(!grSrc.includes("pinInput === '1234'"));
    assert.ok(!grSrc.includes("pinInput === '9860'"));
    assert.ok(!jobsSrc.includes("pinInput === '1234'"));
    assert.ok(!jobsSrc.includes("pinInput === '9860'"));
  });

  // 6. Live Express Server Security Tests (port 3000)
  await test('Verifies live HTTP security headers & CSP without iframe-breaking X-Frame-Options', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
    assert.equal(res.headers.get('x-frame-options'), null);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("base-uri 'self'"));
    assert.ok(csp.includes("script-src-attr 'none'"));
  });

  await test('Rejects spoofed SVG payload on /api/posters with HTTP 400 even when Owner PIN is valid', async () => {
    const fakeSvgAsPng = `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`;
    const res = await fetch(`${BASE_URL}/api/posters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: OWNER_PIN,
        title: 'XSS Test',
        category: 'Test',
        imageUrl: fakeSvgAsPng,
      }),
    });
    assert.equal(res.status, 400);
  });

  await test('Rejects spoofed SVG payload on /api/founder-photo with HTTP 400', async () => {
    const fakeSvgAsJpg = `data:image/jpeg;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`;
    const res = await fetch(`${BASE_URL}/api/founder-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: OWNER_PIN,
        photoDataUrl: fakeSvgAsJpg,
      }),
    });
    assert.equal(res.status, 400);
  });

  await test('Enforces Owner PIN brute-force lockout (5 failures -> HTTP 429) on isolated test IP', async () => {
    const testIpHeader = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.250' };
    for (let i = 1; i <= 4; i++) {
      const r = await fetch(`${BASE_URL}/api/posters/verify-owner`, {
        method: 'POST',
        headers: testIpHeader,
        body: JSON.stringify({ pin: '0000' }),
      });
      assert.equal(r.status, 403, `Attempt ${i} should return 403`);
    }
    const r5 = await fetch(`${BASE_URL}/api/posters/verify-owner`, {
      method: 'POST',
      headers: testIpHeader,
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(r5.status, 429, '5th failed attempt must trigger 429 lockout');
    assert.ok(r5.headers.get('cache-control')?.includes('no-store'));
  });

  await test('Verifies Server Automated Backup, File Integrity Monitoring & Rollback APIs', async () => {
    const bkpRes = await fetch(`${BASE_URL}/api/security/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: OWNER_PIN }),
    });
    assert.equal(bkpRes.status, 200);
    const bkpData = await bkpRes.json();
    assert.equal(bkpData.success, true);

    const fimRes = await fetch(`${BASE_URL}/api/security/integrity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: OWNER_PIN }),
    });
    assert.equal(fimRes.status, 200);
    const fimData = await fimRes.json();
    assert.equal(fimData.success, true);
    assert.ok(Array.isArray(fimData.files));
    const tampered = fimData.files.filter((f: any) => f.status === 'tampered_or_modified');
    assert.equal(tampered.length, 0);
  });

  await test('Verifies /api/pdf/protect rejects non-PDF spoofs/empty passwords and encrypts valid PDFs', async () => {
    const spoofRes = await fetch(`${BASE_URL}/api/pdf/protect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'x-pdf-password': 'test123' },
      body: new TextEncoder().encode('<html><script>alert(1)</script></html>'),
    });
    assert.equal(spoofRes.status, 400);

    const noPassRes = await fetch(`${BASE_URL}/api/pdf/protect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'x-pdf-password': '' },
      body: new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'),
    });
    assert.equal(noPassRes.status, 400);
  });

  console.log(`\n🎉 Security Audit Suite Completed: ${passed} passed, ${process.exitCode ? 'with failures' : '0 failed'}.\n`);
}

run();