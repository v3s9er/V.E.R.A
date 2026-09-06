import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from attachments import validate_attachment, read_attachments, MAX_FILE
from attachment_worker import extract


def pdf_fixture():
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = PdfWriter()
    page = writer.add_blank_page(600, 800)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 12 Tf 50 700 Td (Public square architecture fixture) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def zipped(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return output.getvalue()


class ExtractionTests(unittest.TestCase):
    def test_pdf_and_korean_text(self):
        self.assertIn('Public square', extract(pdf_fixture(), 'test.pdf')[0])
        self.assertEqual(extract('광장 설계'.encode('cp949'), 'notes.txt')[0], '광장 설계')

    def test_office_zip_hwpx_and_unknown_binary(self):
        for filename, member in [('a.docx', 'word/document.xml'), ('a.pptx', 'ppt/slides/slide1.xml'), ('a.hwpx', 'Contents/section0.xml'), ('a.odt', 'content.xml')]:
            text, _ = extract(zipped({member: '<doc><text>광장 분석</text></doc>'.encode()}), filename)
            self.assertIn('광장 분석', text)
        text, _ = extract(zipped({'../outside.txt': b'only in memory', 'script.py': b'print("do not execute")'}), 'archive.zip')
        self.assertIn('only in memory', text)
        text, warning = extract(b'MZ\x00\x00\x00\x00\xff\x00binary fixture', 'app.exe')
        self.assertIn('바이너리', text)
        self.assertIn('실행하지', warning)
        _, warning = extract(zipped({'bomb.txt': b'a'*1000000}), 'bomb.zip')
        self.assertIn('안전 한도', warning)

    def test_xlsx_cells(self):
        xml = b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>'
        text, _ = extract(zipped({'xl/workbook.xml': '<x/>', 'xl/sharedStrings.xml': '<sst><si><t>test</t></si></sst>', 'xl/worksheets/sheet1.xml': xml}), 'table.xlsx')
        self.assertIn('A1=test', text)
        self.assertIn('B1=42', text)

    def test_origin_size_and_identity(self):
        file = NS(id=22, url='https://cdn.discordapp.com/attachments/11/22/a.pdf?ex=fixture', size=4)
        validate_attachment(file, 11)
        for url in ['http://cdn.discordapp.com/attachments/11/22/a', 'https://127.0.0.1/a', 'https://cdn.discordapp.com/attachments/99/22/a', 'https://cdn.discordapp.com/attachments/11/23/a', 'https://cdn.discordapp.com.evil.test/attachments/11/22/a']:
            file.url = url
            with self.assertRaises(RuntimeError):
                validate_attachment(file, 11)
        file.url = 'https://cdn.discordapp.com/attachments/11/22/a.exe'
        file.size = MAX_FILE + 1
        with self.assertRaises(RuntimeError):
            validate_attachment(file, 11)


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_download_real_worker_and_bridge_forwarding(self):
        data = pdf_fixture()
        class Response:
            status = 200
            content = None
            async def __aenter__(self):
                self.content = self
                return self
            async def __aexit__(self, *args): pass
            async def iter_chunked(self, size):
                yield data
        class Session:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def get(self, url, **kwargs):
                assert kwargs['allow_redirects'] is False
                return Response()
        file = NS(id=22, url='https://cdn.discordapp.com/attachments/11/22/a.pdf', size=len(data), filename='광장.pdf')
        with patch('attachments.aiohttp.ClientSession', Session):
            result = await read_attachments([file], 11)
        self.assertEqual(result[0]['status'], 'extracted', result)
        self.assertIn('Public square', result[0]['text'])
        self.assertEqual(len(result[0]['sha256']), 64)
        self.assertNotIn('url', result[0])
        self.assertNotIn('path', result[0])

    async def test_cancel_before_download(self):
        file = NS(id=22, url='https://cdn.discordapp.com/attachments/11/22/a', size=0, filename='any.extension')
        with self.assertRaises(RuntimeError):
            await read_attachments([file], 11, AsyncMock(side_effect=RuntimeError('cancelled')))
