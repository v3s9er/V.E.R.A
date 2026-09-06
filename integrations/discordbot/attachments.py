"""Discord-origin attachments only. Never download a user-supplied arbitrary URL."""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from attachment_cache import excerpts

MAX_FILE = 25 * 1024 * 1024
MAX_TOTAL = 50 * 1024 * 1024
MAX_COUNT = 10
MAX_TEXT = 48000


def validate_attachment(attachment, channel_id):
    url = urlsplit(attachment.url)
    parts = url.path.split('/')
    if (url.scheme != 'https' or url.hostname not in {'cdn.discordapp.com', 'media.discordapp.net'}
            or url.username or url.password or url.port not in (None, 443)
            or len(parts) < 5 or parts[1] != 'attachments'
            or parts[2] != str(channel_id) or parts[3] != str(attachment.id)):
        raise RuntimeError('이 Discord 메시지에 직접 첨부한 파일만 읽을 수 있습니다.')
    if not isinstance(attachment.size, int) or not 0 <= attachment.size <= MAX_FILE:
        raise RuntimeError('첨부 하나는 25MB 이하로 보내주세요. 파일 형식 제한은 없습니다.')


async def read_attachments(attachments, channel_id, check_cancel=None, *, scope=None):
    if len(attachments) > MAX_COUNT or sum(a.size for a in attachments) > MAX_TOTAL:
        raise RuntimeError('한 요청에는 최대 10개·합계 50MB까지 첨부할 수 있습니다.')
    for attachment in attachments:
        validate_attachment(attachment, channel_id)
    results, remaining = [], MAX_TEXT
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45), trust_env=False) as session:
        for attachment in attachments:
            if check_cancel:
                await check_cancel()
            with tempfile.TemporaryDirectory(prefix='mrrobot-discord-input-') as directory:
                path = Path(directory) / 'payload.bin'
                size, digest = 0, hashlib.sha256()
                try:
                    async with session.get(attachment.url, allow_redirects=False) as response:
                        if response.status != 200:
                            raise RuntimeError('Discord 첨부 다운로드가 만료되었거나 거부되었습니다. 파일을 다시 첨부해주세요.')
                        with path.open('xb') as stream:
                            async for chunk in response.content.iter_chunked(65536):
                                size += len(chunk)
                                if size > MAX_FILE or size > attachment.size:
                                    raise RuntimeError('첨부 다운로드 크기가 선언된 크기를 초과했습니다.')
                                stream.write(chunk)
                                digest.update(chunk)
                                if check_cancel:
                                    await check_cancel()
                    if size != attachment.size:
                        raise RuntimeError('첨부 파일이 완전히 다운로드되지 않았습니다. 다시 첨부해주세요.')
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    raise RuntimeError('Discord 첨부를 다운로드하지 못했습니다. 다시 첨부해주세요.') from None
                cache_key = (scope, str(channel_id), digest.hexdigest(), str(attachment.filename)[:200], 'parser-v1')
                extracted = excerpts.get(cache_key) if scope else None
                if extracted is None:
                    extracted = await extract_file(path, attachment.filename, directory, check_cancel)
                    if scope and extracted.get('status') != 'unreadable':
                        excerpts.put(cache_key, extracted)
                if check_cancel:
                    await check_cancel()
                text = str(extracted.get('text', ''))[:remaining]
                truncated = len(str(extracted.get('text', ''))) > remaining or extracted.get('truncated', False)
                remaining -= len(text)
                results.append({'name': str(attachment.filename)[:200], 'size': size, 'sha256': digest.hexdigest(),
                    'text': text, 'status': extracted.get('status', 'unreadable'),
                    'warning': str(extracted.get('warning', ''))[:500], 'truncated': bool(truncated)})
    return results


async def extract_file(path, filename, directory, check_cancel):
    # Only trusted worker code executes. Filename is data, never a path.
    env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP'}}
    env['PYTHONIOENCODING'] = 'utf-8'
    worker = await asyncio.create_subprocess_exec(sys.executable, '-I', str(Path(__file__).with_name('attachment_worker.py')),
        str(path), str(filename)[:200], cwd=directory, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    communication = asyncio.create_task(worker.communicate())
    try:
        deadline = asyncio.get_running_loop().time() + 60
        while not communication.done():
            if check_cancel:
                await check_cancel()
            if asyncio.get_running_loop().time() >= deadline:
                raise asyncio.TimeoutError()
            await asyncio.wait({communication}, timeout=0.25)
        output, _ = await communication
        if worker.returncode or len(output) > 400000:
            raise ValueError('worker failed')
        extracted = json.loads(output)
    except (ValueError, asyncio.TimeoutError):
        extracted = {'text': '', 'status': 'unreadable', 'warning': '안전한 분석 한도 안에서 내용을 읽지 못했습니다. 원문을 읽었다고 답하지 마세요.'}
    finally:
        if worker.returncode is None:
            worker.kill()
            await worker.wait()
        if not communication.done():
            communication.cancel()
        await asyncio.gather(communication, return_exceptions=True)
    return extracted
