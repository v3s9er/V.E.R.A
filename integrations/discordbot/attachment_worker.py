"""Bounded, data-only extraction. No document macros, links or embedded code run."""
import io
import json
import os
import re
import sys
import subprocess
import tempfile
import struct
import zlib
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

LIMIT = 48000
EXPANDED = 32 * 1024 * 1024
_job = None


def limit_process():
    global _job
    if os.name != 'nt':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
        resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
        return
    import ctypes as c
    from ctypes import wintypes as w
    class Basic(c.Structure):
        _fields_ = [('processTime', c.c_int64), ('jobTime', c.c_int64), ('flags', w.DWORD), ('minWS', c.c_size_t), ('maxWS', c.c_size_t), ('processes', w.DWORD), ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
    class IO(c.Structure):
        _fields_ = [(n, c.c_uint64) for n in ('r', 'w', 'o', 'rb', 'wb', 'ob')]
    class Extended(c.Structure):
        _fields_ = [('basic', Basic), ('io', IO), ('processMemory', c.c_size_t), ('jobMemory', c.c_size_t), ('peakProcess', c.c_size_t), ('peakJob', c.c_size_t)]
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.GetCurrentProcess.restype = w.HANDLE
    _job = kernel.CreateJobObjectW(None, None)
    limits = Extended()
    limits.basic.flags = 0x100 | 0x2000 | 0x2  # per-process memory, kill-on-close, CPU time
    limits.basic.processTime = 50 * 10_000_000
    limits.processMemory = 768 * 1024**2
    if not _job or not kernel.SetInformationJobObject(_job, 9, c.byref(limits), c.sizeof(limits)) or not kernel.AssignProcessToJobObject(_job, kernel.GetCurrentProcess()):
        raise RuntimeError('Cannot establish parser resource limits')


def xml_text(data):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('XML entities are not supported')
    root = ET.fromstring(data)
    return '\n'.join(t for t in root.itertext() if t.strip())


def decode_text(data):
    for encoding in ('utf-8-sig', 'utf-16' if data[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8', 'cp949'):
        try:
            text = data.decode(encoding)
            if sum(ord(c) < 32 and c not in '\n\r\t' for c in text) <= max(1, len(text) // 100):
                return text
        except UnicodeError:
            pass
    return None


def image_text(image):
    if os.name != 'nt':
        return '', '이 환경에서는 Windows OCR을 사용할 수 없습니다.'
    image.thumbnail((2400, 2400))
    # Generated PNG in this worker's private scratch directory, never a host path.
    with tempfile.TemporaryDirectory(prefix='ocr-', dir=os.getcwd()) as folder:
        target = Path(folder) / 'image.png'
        image.convert('RGB').save(target)
        command = str(Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
        try:
            result = subprocess.run([command, '-NoProfile', '-NonInteractive', '-File', str(Path(__file__).with_name('attachment_ocr.ps1')), '-ImagePath', str(target.resolve())],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=28, creationflags=0x08000000)
            if result.returncode:
                return '', 'Windows OCR을 사용할 수 없거나 OCR 언어팩이 없습니다.'
            return result.stdout.decode('utf-8-sig', errors='replace')[:LIMIT], 'OCR 추출입니다. 그림의 시각적 의미·레이아웃 분석은 아니며 오인식이 있을 수 있습니다.'
        except (OSError, subprocess.TimeoutExpired):
            return '', '이미지 OCR에 실패했습니다. 내용을 추측하지 마세요.'


def extract(data, name, depth=0):
    suffix = Path(name).suffix.lower()
    if data.startswith(b'%PDF-'):
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted and not reader.decrypt(''):
            return '', '암호화된 PDF입니다. 암호를 제거한 사본을 첨부해주세요.'
        parts, length, ocr_pages = [], 0, 0
        for number, page in enumerate(reader.pages):
            if number >= 100 or length >= LIMIT:
                return '\n'.join(parts), '일부만 읽었습니다: 최대 100페이지/48000자 한도.'
            contents = page.get_contents()
            if contents and len(contents.get_data()) > 4 * 1024**2:
                parts.append(f'[페이지 {number+1}: 복잡도 한도로 제외]')
                continue
            text = page.extract_text() or ''
            if not text.strip() and ocr_pages < 3:
                ocr_pages += 1
                for embedded in list(page.images)[:1]:
                    text, _ = image_text(embedded.image)
            parts.append(f'[페이지 {number+1}]\n{text}')
            length += len(text)
        return '\n'.join(parts), ('일부 페이지를 OCR로 읽었습니다. OCR은 최대 3페이지이며 오인식/누락이 있을 수 있습니다.' if ocr_pages else '') if length else '텍스트가 없는 스캔 PDF입니다. OCR에서도 내용을 읽지 못했습니다. 내용을 읽었다고 답하지 마세요.'
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 1000 or sum(i.file_size for i in entries) > EXPANDED or any(i.file_size > 8*1024**2 or i.file_size > max(i.compress_size, 1)*300 for i in entries):
                return '', '압축 해제 안전 한도를 초과했습니다. 압축 폭탄 방지를 위해 열지 않았습니다.'
            names = {i.filename for i in entries}
            if 'word/document.xml' in names:
                return xml_text(archive.read('word/document.xml')), '표·문단 텍스트 추출. 그림/레이아웃은 포함되지 않습니다.'
            if 'xl/workbook.xml' in names:
                shared = []
                if 'xl/sharedStrings.xml' in names:
                    root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
                    shared = [''.join(e.itertext()) for e in root]
                parts = []
                for filename in sorted(n for n in names if re.match(r'xl/worksheets/sheet\d+\.xml$', n)):
                    root = ET.fromstring(archive.read(filename))
                    rows = []
                    for row in root.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row'):
                        cells = []
                        for cell in row:
                            value = cell.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                            text = value.text if value is not None else ''.join(cell.itertext())
                            if cell.get('t') == 's' and text and text.isdigit():
                                text = shared[int(text)] if int(text) < len(shared) else '[invalid cell]'
                            cells.append(f'{cell.get("r", "")}={text or ""}')
                        rows.append('\t'.join(cells))
                        if sum(map(len, rows)) > LIMIT:
                            break
                    parts.append(filename+'\n'+'\n'.join(rows))
                return '\n'.join(parts), '수식은 실행하지 않습니다. 저장된 셀 값/캐시를 읽었습니다.'
            selected = sorted(n for n in names if re.match(r'ppt/slides/slide\d+\.xml$', n) or n == 'content.xml' or re.match(r'Contents/section\d+\.xml$', n))
            if selected:
                return '\n'.join(n+'\n'+xml_text(archive.read(n)) for n in selected)[:LIMIT+1], '텍스트 추출. 매크로·외부 링크는 실행하지 않습니다.'
            parts = ['[압축파일 목록]\n'+'\n'.join(i.filename for i in entries)]
            size = len(parts[0])
            for entry in entries:
                if depth >= 1 or entry.is_dir() or size >= LIMIT:
                    continue
                if entry.flag_bits & 1:
                    parts.append(entry.filename+': 암호화되어 읽지 못함')
                    continue
                text, warning = extract(archive.read(entry), entry.filename, depth+1)
                section = f'\n[압축 내부: {entry.filename}]\n{text[:LIMIT-size]}\n{warning}'
                parts.append(section)
                size += len(section)
            return '\n'.join(parts), '압축파일은 메모리에서만 읽으며 실행·디스크 경로 해제를 하지 않습니다. 중첩은 1단계, 총 텍스트 한도 적용.'
    if suffix == '.xls':
        import xlrd
        book = xlrd.open_workbook(file_contents=data, on_demand=True)
        parts = []
        for sheet in book.sheets():
            parts.append(sheet.name)
            for row in range(min(sheet.nrows, 2000)):
                parts.append('\t'.join(str(v) for v in sheet.row_values(row)[:100]))
                if sum(map(len, parts)) > LIMIT:
                    return '\n'.join(parts), '표 크기 한도로 일부만 읽었습니다.'
        return '\n'.join(parts), '저장된 셀 값만 읽었습니다. 수식/매크로 실행 없음.'
    if suffix == '.rtf':
        from striprtf.striprtf import rtf_to_text
        return rtf_to_text(data.decode('utf-8', errors='replace')), ''
    if suffix == '.hwp' and data.startswith(b'\xd0\xcf\x11\xe0'):
        import olefile
        with olefile.OleFileIO(io.BytesIO(data)) as document:
            header = document.openstream('FileHeader').read(256)
            flags = struct.unpack_from('<I', header, 36)[0]
            if flags & 2:
                return '', '암호화된 HWP는 읽을 수 없습니다.'
            texts = []
            for entry in document.listdir():
                if len(entry) != 2 or entry[0] != 'BodyText' or not re.fullmatch(r'Section\d+', entry[1]):
                    continue
                payload = document.openstream(entry).read(EXPANDED+1)
                if flags & 1:
                    inflater = zlib.decompressobj(-15)
                    payload = inflater.decompress(payload, EXPANDED+1)
                    if not inflater.eof:
                        return '', 'HWP 압축 해제 안전 한도를 초과했습니다.'
                if len(payload) > EXPANDED:
                    return '', 'HWP 문서 크기 한도를 초과했습니다.'
                offset = 0
                while offset+4 <= len(payload):
                    record = struct.unpack_from('<I', payload, offset)[0]
                    offset += 4
                    tag, size = record & 0x3ff, record >> 20
                    if size == 0xfff:
                        size = struct.unpack_from('<I', payload, offset)[0]
                        offset += 4
                    if size > len(payload)-offset:
                        raise ValueError('HWP record')
                    if tag == 67:
                        texts.append(re.sub(r'[\x00-\x08\x0b-\x1f]', '', payload[offset:offset+size].decode('utf-16-le', errors='replace')))
                    offset += size
                    if sum(map(len, texts)) >= LIMIT:
                        return '\n'.join(texts), 'HWP 텍스트 한도로 일부만 읽었습니다.'
            return '\n'.join(texts), 'HWP 본문 텍스트 추출. 그림·복잡한 표 배치는 포함되지 않습니다.'
    text = decode_text(data)
    if text is not None:
        return text, ''
    if suffix in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico'}:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 20_000_000
        with Image.open(io.BytesIO(data)) as im:
            metadata = f'이미지 형식: {im.format}, 크기: {im.width}×{im.height}'
            text, warning = image_text(im)
            return metadata+'\n'+text, warning
    # Universal intake does not mean executing or pretending to decode binaries.
    strings = re.findall(rb'[\x20-\x7e]{6,}', data[:1024*1024])[:100]
    return '바이너리 헤더(hex): '+data[:64].hex()+'\n읽을 수 있는 문자열(일부):\n'+'\n'.join(s[:200].decode('ascii') for s in strings), '파일은 수신했지만 이 바이너리 형식의 의미 해석은 지원하지 않습니다. 원문을 읽은 것처럼 답하지 마세요. 실행하지 않았습니다.'


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        limit_process()
        path = Path(sys.argv[1])
        if path.stat().st_size > 25*1024**2:
            raise ValueError('size')
        text, warning = extract(path.read_bytes(), sys.argv[2])
        result = {'text': text[:LIMIT], 'status': 'partial' if warning else 'extracted', 'warning': warning,
                  'truncated': len(text) > LIMIT}
    except ImportError:
        result = {'text': '', 'status': 'unreadable', 'warning': 'PC의 첨부 분석 의존성을 설치해야 합니다. integrations/discordbot/requirements.txt를 확인하세요.'}
    except Exception:
        result = {'text': '', 'status': 'unreadable', 'warning': '손상·암호화 또는 안전 한도로 내용을 읽지 못했습니다. 파일을 실행하지 않았습니다.'}
    print(json.dumps(result, ensure_ascii=False))
