import asyncio
import base64
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import Bridge
from presentation import result_text, wants_files
from thread_sessions import MessageContext


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.receipt = NS(id=10, edit=AsyncMock())
        self.channel = NS(id=4, send=AsyncMock(), fetch_message=AsyncMock(return_value=self.receipt))
        self.guild = NS(id=1, filesize_limit=1000)
        self.message = NS(guild=self.guild, channel=self.channel, author=NS(id=3))
        self.context = MessageContext(self.message)
        self.context.result_message = self.receipt
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.loop = asyncio.get_running_loop()
        self.bridge.active = {}
        self.bridge.threads = NS(mutating=set(), state={'sessions': {}}, cancel_queued=AsyncMock())
        self.bridge.authorize = AsyncMock()
        self.bridge.request = AsyncMock(return_value={'text': '답변은 바로 여기에 있습니다.'})

    async def test_result_replaces_receipt_without_generic_completion(self):
        await self.bridge.execute(self.context, 'ask', text='질문')
        self.assertEqual(self.receipt.edit.call_args.kwargs['content'], '답변은 바로 여기에 있습니다.')
        self.channel.send.assert_not_awaited()
        self.assertFalse(self.bridge.active)

    async def test_long_reply_has_full_txt_and_bounded_messages(self):
        original = '한글 답변 😀\n\n' * 1400
        self.bridge.request.return_value = {'text': original}
        received = []
        async def send(content=None, **kwargs):
            if kwargs.get('file'):
                received.append(kwargs['file'].fp.read().decode('utf-8'))
            if content:
                self.assertLessEqual(len(content.encode('utf-16-le')) // 2, 2000)
        self.channel.send.side_effect = send
        await self.bridge.execute(self.context, 'ask', text='explain')
        self.assertEqual(received, [original])
        self.assertTrue(self.context.progress_finished)
        self.assertLessEqual(self.channel.send.await_count, 4)

    async def test_attachment_source_is_forwarded_without_host_parsing(self):
        self.context.attachments = [NS(filename='own.pdf', id=22, size=42, url='https://cdn.discordapp.com/attachments/4/22/own.pdf')]
        with patch('bridge.read_attachments', AsyncMock()) as reader:
            await self.bridge.execute(self.context, 'ask', text='요약')
        reader.assert_not_awaited()
        sources = self.bridge.request.call_args.kwargs['attachmentSources']
        self.assertEqual(sources[0]['id'], '22')
        self.assertEqual(sources[0]['size'], 42)
        self.assertNotIn('attachments', self.bridge.request.call_args.kwargs)
        self.assertEqual(self.bridge.request.call_args.args[0], self.context)
        self.assertEqual(self.receipt.edit.call_args.kwargs['content'], '답변은 바로 여기에 있습니다.')

    async def test_expired_slash_still_uses_bot_message(self):
        interaction = NS(guild=self.guild, guild_id=1, channel=self.channel, channel_id=4, user=NS(id=3), response=NS(defer=AsyncMock()), followup=NS(send=AsyncMock()), edit_original_response=AsyncMock(return_value=self.receipt), is_expired=lambda: True)
        await self.bridge.execute(interaction, 'ask', text='긴 작업')
        self.channel.fetch_message.assert_awaited_once_with(10)
        self.assertEqual(self.receipt.edit.call_args.kwargs['content'], '답변은 바로 여기에 있습니다.')
        interaction.followup.send.assert_not_awaited()

    async def test_stop_and_failure_are_human_readable(self):
        self.bridge.request.return_value = {'ok': True}
        await self.bridge.execute(self.context, 'stop')
        self.assertEqual(self.receipt.edit.call_args.kwargs['content'], '작업 중지를 요청했습니다.')
        self.assertEqual(result_text({'ok': False, 'error': '작업이 중지되었습니다.'}, 'ask'), '⚠️ 작업이 중지되었습니다.')
        self.assertEqual(result_text('{"ok":true}', 'stop'), '작업 중지를 요청했습니다.')
        self.assertEqual(result_text('{"business_data":42}', 'ask'), '{"business_data":42}')

    async def test_file_is_real_attachment_and_rechecks_permission(self):
        self.context.result_message = None
        data = b'fixture pdf data'
        self.bridge.request.return_value = {'data': base64.b64encode(data).decode(), 'offset': 0, 'size': len(data), 'version': '1', 'name': 'test.pdf', 'done': True}
        captured = []
        async def send(*args, **kwargs):
            captured.append(kwargs['file'].fp.read())
        self.channel.send.side_effect = send
        await self.bridge.send_files(self.context, self.context, [{'path': 'C:\\fixture\\test.pdf'}])
        self.assertEqual(captured, [data])
        self.assertEqual(self.bridge.request.await_count, 2)
        self.assertEqual(self.bridge.request.call_args.kwargs['offset'], len(data))

    async def test_denied_or_corrupt_file_never_uploads(self):
        self.context.result_message = None
        self.bridge.request.side_effect = PermissionError('전체 허용 필요')
        await self.bridge.send_files(self.context, self.context, [{'path': 'C:\\fixture\\test.pdf'}])
        self.assertNotIn('file', self.channel.send.call_args.kwargs)
        self.assertIn('첨부 실패', self.channel.send.call_args.args[0])

    async def test_file_reference_alone_is_not_export_consent(self):
        self.assertFalse(wants_files('프로젝트를 분석해줘'))
        self.assertTrue(wants_files('다운로드 폴더 PDF를 여기에 올려줘'))


if __name__ == '__main__':
    unittest.main()
