/** Explicit integration test: synthetic data only; prepares the local image once. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { configureDiscordSandboxEngine, runDiscordDocument, closeDiscordSandboxes } from '../src/server/discord-sandbox.js';
configureDiscordSandboxEngine(process.env.MR_ROBOT_TEST_WSL ?? '');
const ticket = 'synthetic-document-integration';
try {
  const start = Date.now();
  assert.match(await runDiscordDocument(ticket, "import shutil; print(shutil.which('pdftotext')); print(shutil.which('tesseract'))", []), /pdftotext/);
  console.log(`Document image ready (${Date.now() - start} ms)`);
  const generated = await runDiscordDocument(ticket, `import io,base64
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject
w=PdfWriter(); p=w.add_blank_page(600,800)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
p[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):w._add_object(font)})})
s=DecodedStreamObject(); s.set_data(b'BT /F1 20 Tf 50 700 Td (SYNTHETIC ARCHITECTURE ORIGINAL) Tj ET'); p[NameObject('/Contents')]=w._add_object(s)
b=io.BytesIO(); w.write(b); print(base64.b64encode(b.getvalue()).decode())`, []);
  const pdf = Buffer.from(generated.trim(), 'base64'), id = createHash('sha256').update(pdf).digest('hex');
  const read = `import subprocess
r=subprocess.run(['python','-I','/opt/attachment_worker.py','/work/attachments/${id}.pdf','fixture.pdf','1','1'],capture_output=True,timeout=85)
print(r.stdout.decode()); assert r.returncode==0`;
  assert.match(await runDiscordDocument(ticket, read, [{ id, name: 'fixture.pdf', data: pdf }]), /SYNTHETIC ARCHITECTURE ORIGINAL/);
  assert.match(await runDiscordDocument('synthetic-other-ticket', `import os; print(os.path.exists('/work/attachments/${id}.pdf'))`, []), /False/);
  const scan = await runDiscordDocument(ticket, `import io,base64
from PIL import Image,ImageDraw,ImageFont
im=Image.new('RGB',(1200,400),'white'); d=ImageDraw.Draw(im); d.text((40,80),'SCANNED PUBLIC SQUARE',font=ImageFont.load_default(size=50),fill='black')
b=io.BytesIO(); im.save(b,format='PDF'); print(base64.b64encode(b.getvalue()).decode())`, []);
  const scanData = Buffer.from(scan.trim(), 'base64'), scanId = createHash('sha256').update(scanData).digest('hex');
  assert.match(await runDiscordDocument(ticket, read.replaceAll(id, scanId), [{ id: scanId, name: 'scan.pdf', data: scanData }]), /SCANNED PUBLIC SQUARE/);
  const begun = Date.now();
  assert.match(await runDiscordDocument(ticket, read, [{ id, name: 'fixture.pdf', data: pdf }]), /SYNTHETIC ARCHITECTURE ORIGINAL/);
  console.log(`Warm re-read: ${Date.now() - begun} ms; real PDF original, full-page scan OCR, cross-ticket isolation passed.`);
  // Optional local regression input is never checked in or printed.
  if (process.env.MR_ROBOT_TEST_PDF) {
    const original = readFileSync(process.env.MR_ROBOT_TEST_PDF);
    const originalId = createHash('sha256').update(original).digest('hex');
    const result = JSON.parse(await runDiscordDocument(ticket, read.replaceAll(id, originalId).replace("'1','1'", "'1','10'"), [{ id: originalId, name: 'regression.pdf', data: original }]));
    assert.ok(result.text?.length > 100 && result.status !== 'unreadable', 'actual PDF must have readable evidence');
    console.log(JSON.stringify({ actualPdf: 'passed', bytes: original.length, extractedCharacters: result.text.length, status: result.status }));
  }
} finally { await closeDiscordSandboxes(); }
