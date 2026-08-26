import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mr-robot-voice-'));
const voiceSource = readFileSync(new URL('../src/plugins/voice.ts', import.meta.url), 'utf8');
assert.match(
  voiceSource,
  /segment_samples = np\.copy\(vad\.front\.samples\)[\s\S]{0,120}vad\.pop\(\)/,
  'VAD samples must be copied before pop() clears the native segment buffer',
);
assert.match(voiceSource, /language=language/, 'SenseVoice must receive the selected language so short Korean wake words are not auto-detected as Chinese');
assert.match(voiceSource, /ensure_ascii=True/, 'Korean recognition events must cross Windows pipes as ASCII-safe JSON');
assert.match(voiceSource, /aliases\.update\(\{"로보트", "로버트"/, 'default Korean wake phrase must tolerate common ASR variants');
assert.match(voiceSource, /PYTHONIOENCODING: 'utf-8'/, 'local listener must force UTF-8 output');
assert.match(voiceSource, /kind="audio"/, 'listener must publish a microphone-level heartbeat');
assert.match(voiceSource, /voice\.command/, 'wake listener must publish executable voice commands');
assert.match(voiceSource, /COMMAND_WINDOW_MS/, 'wake-only recognition must arm a bounded follow-up command window');
process.env.MR_ROBOT_HOME = home;
const { extractWakeCommand, improveKoreanCommandTranscript, chooseKoreanCommandTranscript } = await import('../dist/plugins/voice.js');
assert.equal(extractWakeCommand('로봇 오늘 날씨 알려줘', '로봇'), '오늘 날씨 알려줘');
assert.equal(extractWakeCommand('미스터 로봇, 프로젝트 테스트해줘', '미스터로봇'), '프로젝트 테스트해줘');
assert.equal(extractWakeCommand('로봇.', '로봇'), '');
assert.equal(improveKoreanCommandTranscript('로봇 지금 내가 보고 있는 유 창이 재생해줘'), '로봇 지금 내가 보고 있는 유튜브 창 재생해줘');
assert.equal(improveKoreanCommandTranscript('로봇 지금 내 폴더에서 복습할 하나 찾아줘'), '로봇 지금 내 폴더에서 독스 파일 하나 찾아줘');
assert.equal(chooseKoreanCommandTranscript(['로봇 지금 내가 보고 있는 유 창이 재생해줘', '로봇지금내가보고있는유튜브창재생해져']), '로봇 지금 내가 보고 있는 유튜브 창 재생해줘');
const { AgentServer } = await import('../dist/server/server.js');
const server = new AgentServer();

try {
  await server.start({ port: 0, host: '127.0.0.1' });
  const initial = await server.plugins.call('voice.status', {});
  assert.equal(typeof initial.engineAvailable, 'boolean');
  assert.equal(initial.enabled, false);
  assert.equal(initial.sensitivity, 0.68);
  assert.equal(initial.replyPreset, 'neon-runner');
  assert.equal(initial.replyText, '응, 듣고 있어.');
  assert.equal(typeof initial.accurateKoreanModel, 'boolean');
  assert.equal(Array.isArray(initial.voices), true);

  await server.plugins.call('voice.config.set', {
    enabled: true,
    wakePhrase: '로봇',
    language: 'ko-KR',
    pcPriorityMs: 900,
    audibleReply: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const active = await server.plugins.call('voice.status', {});
  if (active.engineAvailable) assert.equal(active.listening || active.starting, true);
  else assert.equal(Boolean(active.lastError), true);
  assert.equal(active.sensitivity, 0.68);

  await server.plugins.call('voice.config.set', { ...active, enabled: false });
  const stopped = await server.plugins.call('voice.status', {});
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.listening, false);
  console.log('VOICE ALWAYS-LISTENING TEST PASSED');
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
}
