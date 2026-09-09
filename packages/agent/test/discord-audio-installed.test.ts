/** Explicit offline integration test. Optional private input is never printed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { configureDiscordSandboxEngine, runDiscordAudio, closeDiscordSandboxes } from '../src/server/discord-sandbox.js';
configureDiscordSandboxEngine(process.env.MR_ROBOT_TEST_WSL ?? '');
try {
  const start = Date.now();
  const silence = await runDiscordAudio('audio-regression', `import wave,subprocess,json
with wave.open('/work/silence.wav','wb') as f:
 f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(bytes(32000))
r=subprocess.run(['python','-I','/opt/audio_worker.py','/work/silence.wav','0','120'],capture_output=True,timeout=175)
print(r.stdout.decode());assert r.returncode==0`, []);
  assert.equal(JSON.parse(silence).status, 'no_speech');
  console.log(`Offline audio engine ready; silence correctly rejected (${Date.now() - start} ms).`);
  if (process.env.MR_ROBOT_TEST_AUDIO) {
    const data = readFileSync(process.env.MR_ROBOT_TEST_AUDIO), id = createHash('sha256').update(data).digest('hex');
    const begun = Date.now();
    const result = JSON.parse(await runDiscordAudio('audio-regression', `import subprocess
r=subprocess.run(['python','-I','/opt/audio_worker.py','/work/attachments/${id}.wav','0','120'],capture_output=True,timeout=175)
print(r.stdout.decode());assert r.returncode==0`, [{ id, name: 'private-regression.wav', data }]));
    assert.equal(result.status, 'transcribed');
    assert.ok(result.text.length > 3);
    assert.equal(result.has_more, false);
    assert.match(await runDiscordAudio('audio-other-ticket', `import os;print(os.path.exists('/work/attachments/${id}.wav'))`, []), /False/);
    console.log(JSON.stringify({ actualAudio: 'passed', seconds: result.read_seconds, textCharacters: result.text.length, elapsedMs: Date.now() - begun, transcriptPrinted: false, crossTicketDenied: true }));
  }
} finally { await closeDiscordSandboxes(); }
