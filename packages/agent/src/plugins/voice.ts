import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mrRobotHome } from '../config.js';
import type { MrRobotPlugin } from './loader.js';
import type { PluginContext } from './context.js';

interface VoiceConfig {
  enabled: boolean;
  wakePhrase: string;
  language: string;
  pcPriorityMs: number;
  audibleReply: boolean;
  sensitivity: number;
  replyPreset: 'neon-runner' | 'system' | 'custom';
  voiceName: string;
  replyText: string;
  replyRate: number;
  replyVolume: number;
}

interface RecognizerInfo { id: string; language: string; description: string }
interface SynthesizerInfo { name: string; language: string; gender: string; age: string; description: string }
type VoiceEngine = 'windows-speech' | 'sherpa-onnx' | 'none';
type RecognitionModel = 'hybrid-korean' | 'sensevoice' | 'windows-sapi' | 'none';

const DEFAULTS: VoiceConfig = {
  enabled: false,
  wakePhrase: '로봇',
  language: 'ko-KR',
  pcPriorityMs: 900,
  audibleReply: true,
  sensitivity: 0.68,
  replyPreset: 'neon-runner',
  voiceName: '',
  replyText: '응, 듣고 있어.',
  replyRate: -1,
  replyVolume: 88,
};

const COMMAND_WINDOW_MS = 12_000;

const SENSE_VOICE_FOLDER = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const KOREAN_VOICE_FOLDER = 'sherpa-onnx-zipformer-korean-2024-06-24';
const LOCAL_LISTENER_SOURCE = String.raw`import argparse
import json
import re
import sys
import time
import unicodedata

import numpy as np
import sherpa_onnx
import sounddevice as sd


def normalize(value):
    value = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^0-9a-z가-힣]", "", value)


def edit_distance(left, right):
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, 1):
        current = [left_index]
        for right_index, right_char in enumerate(right, 1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]


def phonetic_similarity(left, right):
    left_jamo = unicodedata.normalize("NFD", normalize(left))
    right_jamo = unicodedata.normalize("NFD", normalize(right))
    size = max(len(left_jamo), len(right_jamo))
    return 0.0 if size == 0 else 1.0 - edit_distance(left_jamo, right_jamo) / size


def aliases_for(phrase):
    value = normalize(phrase)
    aliases = {value}
    # SenseVoice commonly writes the short Korean word "로봇" in one of these
    # phonetically equivalent forms. Keep this list narrow to avoid accidental wakes.
    if value == "로봇":
        aliases.update({"로보트", "로버트", "로봇아", "로봇이", "로봇트"})
    return {item for item in aliases if item}


def wake_match(text, phrase):
    heard = normalize(text)
    needle = normalize(phrase)
    if not heard or not needle:
        return 0.0, ""
    if needle in heard:
        return 1.0, needle
    aliases = aliases_for(phrase) - {needle}
    for alias in aliases:
        if alias in heard:
            return 0.94, alias
    words = re.findall(r"[0-9a-z가-힣]+", unicodedata.normalize("NFKC", text).casefold())
    candidates = words + ([heard] if heard not in words else [])
    scored = [(phonetic_similarity(candidate, needle), normalize(candidate)) for candidate in candidates]
    return max(scored, default=(0.0, ""), key=lambda item: item[0])


def emit_event(**payload):
    # ensure_ascii keeps the pipe protocol ASCII-only. This avoids Windows CP949
    # stdout turning recognized Korean into replacement characters in Node.
    print("__MR_ROBOT_EVENT__" + json.dumps(payload, ensure_ascii=True, separators=(",", ":")), flush=True)


parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--tokens", required=True)
parser.add_argument("--vad", required=True)
parser.add_argument("--phrase", required=True)
parser.add_argument("--language", default="ko-KR")
parser.add_argument("--sensitivity", type=float, default=0.68)
parser.add_argument("--ko-encoder", default="")
parser.add_argument("--ko-decoder", default="")
parser.add_argument("--ko-joiner", default="")
parser.add_argument("--ko-tokens", default="")
args = parser.parse_args()

sample_rate = 16000
samples_per_read = int(0.1 * sample_rate)
needle = normalize(args.phrase)
sensitivity = min(0.9, max(0.5, args.sensitivity))
language = args.language.split("-")[0].lower()
if language not in {"auto", "zh", "en", "ja", "ko", "yue"}:
    language = "auto"
sense_recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=args.model,
    tokens=args.tokens,
    num_threads=2,
    language=language,
    use_itn=True,
)
use_korean = language == "ko" and all((args.ko_encoder, args.ko_decoder, args.ko_joiner, args.ko_tokens))
if use_korean:
    korean_recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=args.ko_encoder,
        decoder=args.ko_decoder,
        joiner=args.ko_joiner,
        tokens=args.ko_tokens,
        num_threads=4,
        decoding_method="modified_beam_search",
        max_active_paths=4,
    )
    recognition_model = "hybrid-korean"
else:
    korean_recognizer = None
    recognition_model = "sensevoice"
vad_config = sherpa_onnx.VadModelConfig()
vad_config.silero_vad.model = args.vad
vad_config.silero_vad.threshold = 0.35
vad_config.silero_vad.min_silence_duration = 0.52
vad_config.silero_vad.min_speech_duration = 0.16
vad_config.sample_rate = sample_rate
vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=30)

with sd.InputStream(channels=1, dtype="float32", samplerate=sample_rate, blocksize=samples_per_read) as microphone:
    print("__MR_ROBOT_READY__" + recognition_model, flush=True)
    audio_peak = 0.0
    last_audio_report = time.monotonic()
    while True:
        samples, _ = microphone.read(samples_per_read)
        samples = np.asarray(samples).reshape(-1)
        audio_peak = max(audio_peak, float(np.max(np.abs(samples))) if len(samples) else 0.0)
        now = time.monotonic()
        if now - last_audio_report >= 3.0:
            emit_event(kind="audio", inputLevel=round(min(1.0, audio_peak * 4.0), 4))
            audio_peak = 0.0
            last_audio_report = now
        vad.accept_waveform(samples)
        while not vad.empty():
            # vad.pop() clears the native segment buffer. Copy the samples
            # first or every recognized utterance becomes an empty array.
            segment_samples = np.copy(vad.front.samples)
            vad.pop()
            if len(segment_samples) < int(0.2 * sample_rate):
                continue
            raw_level = float(np.percentile(np.abs(segment_samples), 99.5))
            # Laptop microphone arrays can be quiet. Normalize only genuinely
            # detected speech and cap gain to avoid turning room noise into a wake.
            segment_samples -= np.mean(segment_samples)
            level = np.percentile(np.abs(segment_samples), 99.5)
            if 0.001 < level < 0.25:
                segment_samples = np.clip(segment_samples * min(8.0, 0.25 / level), -1.0, 1.0)
            alternatives = []
            for active_recognizer in (sense_recognizer, korean_recognizer):
                if active_recognizer is None:
                    continue
                stream = active_recognizer.create_stream()
                stream.accept_waveform(sample_rate, segment_samples)
                active_recognizer.decode_stream(stream)
                candidate = stream.result.text.strip()
                if candidate and candidate not in alternatives:
                    alternatives.append(candidate)
            if alternatives:
                wake_candidates = [(*wake_match(candidate, args.phrase), candidate) for candidate in alternatives]
                score, matched_phrase, wake_text = max(wake_candidates, key=lambda item: item[0])
                text = wake_text if score >= sensitivity else alternatives[0]
                emit_event(
                    kind="heard",
                    text=text,
                    alternatives=alternatives,
                    matched=score >= sensitivity,
                    matchedPhrase=matched_phrase if score >= sensitivity else "",
                    matchScore=round(score, 4),
                    speechMs=round(len(segment_samples) * 1000 / sample_rate),
                    inputLevel=round(min(1.0, raw_level * 4.0), 4),
                )
`;

const psEscape = (value: string): string => value.replaceAll("'", "''");

function localRuntime() {
  const root = join(mrRobotHome(), 'voice');
  const modelRoot = join(root, SENSE_VOICE_FOLDER);
  const koreanRoot = join(root, KOREAN_VOICE_FOLDER);
  const runtime = {
    root,
    listener: join(root, 'mr-robot-listener.py'),
    model: join(modelRoot, 'model.int8.onnx'),
    tokens: join(modelRoot, 'tokens.txt'),
    vad: join(root, 'silero_vad.onnx'),
    koreanEncoder: join(koreanRoot, 'encoder-epoch-99-avg-1.int8.onnx'),
    koreanDecoder: join(koreanRoot, 'decoder-epoch-99-avg-1.int8.onnx'),
    koreanJoiner: join(koreanRoot, 'joiner-epoch-99-avg-1.int8.onnx'),
    koreanTokens: join(koreanRoot, 'tokens.txt'),
  };
  if (!existsSync(runtime.model) || !existsSync(runtime.tokens) || !existsSync(runtime.vad)) return null;
  return {
    ...runtime,
    accurateKorean: existsSync(runtime.koreanEncoder) && existsSync(runtime.koreanDecoder)
      && existsSync(runtime.koreanJoiner) && existsSync(runtime.koreanTokens),
  };
}

/** Fix a few high-confidence, context-specific Korean ASR slips without asking an LLM. */
export function improveKoreanCommandTranscript(value: string): string {
  let text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  text = text
    .replace(/유\s*(?:투브|튜부|튜브)/g, '유튜브')
    .replace(/깃\s*허브/g, '깃허브')
    .replace(/코\s*덱스/g, '코덱스')
    .replace(/클로\s*드/g, '클로드');
  if (/(?:재생|멈춰|정지|영상|동영상|보고\s*있는)/.test(text)) {
    text = text.replace(/유\s*창(?:이|을)?(?=\s*(?:재생|켜|열|멈|정지))/g, '유튜브 창');
  }
  text = text.replace(/(폴더(?:에서|에)?\s*)복습할(?=\s*하나\s*찾)/g, '$1독스 파일');
  return text;
}

const COMMAND_VOCABULARY = ['유튜브', '독스 파일', '파일', '폴더', '창', '재생', '찾아', '열어', '켜줘', '꺼줘', '정리', '다운로드', '도커', '깃허브', '코덱스', '클로드'];

/** Pick the most command-like transcript without spending an AI token. */
export function chooseKoreanCommandTranscript(values: string[], wakePhrase = '로봇'): string {
  const candidates = [...new Set(values.map(improveKoreanCommandTranscript).filter(Boolean))];
  const compactWake = wakePhrase.replace(/\s+/g, '');
  const score = (text: string): number => {
    const compact = text.replace(/\s+/g, '');
    let points = compact.includes(compactWake) ? 8 : 0;
    for (const term of COMMAND_VOCABULARY) if (compact.includes(term.replace(/\s+/g, ''))) points += term.length >= 4 ? 3 : 1;
    if (/(?:해줘|해 줘|줘|열어|켜|꺼|찾아|재생|멈춰|정지)/.test(text)) points += 4;
    if (text.includes(' ') && compact.length >= 8) points += 2;
    if (compact.length < 3 || compact.length > 180) points -= 6;
    return points;
  };
  return candidates.sort((left, right) => score(right) - score(left))[0] ?? '';
}

function installedRecognizers(): Promise<RecognizerInfo[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new()',
    'Add-Type -AssemblyName System.Speech',
    '[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object {',
    "  [Console]::Out.WriteLine('__MR_RECOGNIZER__'+$_.Id+'|'+$_.Culture.Name+'|'+$_.Description)",
    '}',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 12_000, encoding: 'utf8' }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(String(stdout).split(/\r?\n/).filter((line) => line.startsWith('__MR_RECOGNIZER__')).map((line) => {
        const [id = '', language = '', description = ''] = line.slice('__MR_RECOGNIZER__'.length).split('|');
        return { id, language, description };
      }));
    });
  });
}

function installedSynthesizers(): Promise<SynthesizerInfo[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new()',
    'Add-Type -AssemblyName System.Speech',
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {',
    "  $v=$_.VoiceInfo; [Console]::Out.WriteLine('__MR_VOICE__'+$v.Name+'|'+$v.Culture.Name+'|'+$v.Gender+'|'+$v.Age+'|'+$v.Description)",
    '}',
    '$s.Dispose()',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 12_000, encoding: 'utf8' }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(String(stdout).split(/\r?\n/).filter((line) => line.startsWith('__MR_VOICE__')).map((line) => {
        const [name = '', language = '', gender = '', age = '', description = ''] = line.slice('__MR_VOICE__'.length).split('|');
        return { name, language, gender, age, description };
      }));
    });
  });
}

export function extractWakeCommand(text: string, ...phrases: string[]): string {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  for (const phrase of phrases) {
    const compact = String(phrase ?? '').replace(/\s+/g, '');
    if (!compact) continue;
    const flexible = [...compact].map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    const prefix = new RegExp(`^\\s*${flexible}[\\s,.:;!?~·-]*`, 'iu');
    if (!prefix.test(raw)) continue;
    return raw.replace(prefix, '').trim();
  }
  return '';
}

function speakReply(config: VoiceConfig, onError?: (message: string) => void): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, message: 'Windows에서만 음성 응답을 지원합니다.' });
  const voiceName = psEscape(config.voiceName);
  const replyText = psEscape(config.replyText || '응, 듣고 있어.');
  const rate = Math.max(-10, Math.min(10, Math.round(config.replyRate)));
  const volume = Math.max(0, Math.min(100, Math.round(config.replyVolume)));
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new()',
    'Add-Type -AssemblyName System',
    'Add-Type -AssemblyName System.Speech',
    '[System.Media.SystemSounds]::Asterisk.Play()',
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$requested='${voiceName}'`,
    "$voice=if($requested){ $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -eq $requested } | Select-Object -First 1 }else{ $s.GetInstalledVoices([Globalization.CultureInfo]::GetCultureInfo('ko-KR')) | Where-Object { $_.Enabled } | Select-Object -First 1 }",
    'if($null -ne $voice){ $s.SelectVoice($voice.VoiceInfo.Name) }',
    `$s.Volume=${volume}`,
    `$s.Rate=${rate}`,
    `$s.Speak('${replyText}')`,
    '$s.Dispose()',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8',
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1' },
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, message: `확인음과 “${config.replyText || '응, 듣고 있어.'}” 응답을 재생했습니다.` });
        return;
      }
      const detail = String(stderr || error.message).trim();
      const message = `호출 확인 음성 출력 실패: ${detail}`;
      onError?.(message);
      resolve({ ok: false, message });
    });
  });
}

export function createVoicePlugin(): MrRobotPlugin {
  let listener: ReturnType<typeof spawn> | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let ctxRef: PluginContext | null = null;
  let activeConfig: VoiceConfig = { ...DEFAULTS };
  let ready = false;
  let engine: VoiceEngine = 'none';
  let recognitionModel: RecognitionModel = 'none';
  let lastError = '';
  let lastWakeAt: number | null = null;
  let lastText = '';
  let lastHeardAt: number | null = null;
  let lastHeardText = '';
  let lastRawHeardText = '';
  let lastMatchScore = 0;
  let lastSpeechMs = 0;
  let inputLevel = 0;
  let lastAudioAt: number | null = null;
  let commandArmedUntil: number | null = null;
  let commandWakeId = '';
  let commandTimer: NodeJS.Timeout | null = null;
  let lastCommandAt: number | null = null;
  let lastCommandText = '';
  let generation = 0;
  let orphanCleanupDone = false;

  const emitStatus = () => ctxRef?.emit('voice.status', {
    enabled: activeConfig.enabled,
    listening: Boolean(listener && ready),
    starting: Boolean(listener && !ready),
    engine,
    recognitionModel,
    engineAvailable: Boolean(localRuntime()) || engine !== 'none',
    lastError,
    lastWakeAt,
    lastText,
    lastHeardAt,
    lastHeardText,
    lastRawHeardText,
    lastMatchScore,
    lastSpeechMs,
    inputLevel,
    lastAudioAt,
    commandListening: Boolean(commandArmedUntil && commandArmedUntil > Date.now()),
    commandArmedUntil,
    lastCommandAt,
    lastCommandText,
  });

  const disarmCommand = () => {
    if (commandTimer && ctxRef) ctxRef.clearTimeout(commandTimer);
    commandTimer = null;
    commandArmedUntil = null;
    commandWakeId = '';
  };

  const emitCommand = (text: string, source: 'inline' | 'follow-up', wakeId: string) => {
    const command = text.trim();
    if (!command) return;
    disarmCommand();
    lastCommandAt = Date.now();
    lastCommandText = command;
    ctxRef?.emit('voice.command', { kind: 'pc', device: 'desktop', wakeId, text: command, source, at: lastCommandAt });
    emitStatus();
  };

  const armCommand = (wakeId: string) => {
    disarmCommand();
    if (!ctxRef) return;
    commandWakeId = wakeId;
    commandArmedUntil = Date.now() + COMMAND_WINDOW_MS;
    ctxRef.emit('voice.command.ready', { kind: 'pc', device: 'desktop', wakeId, until: commandArmedUntil, at: Date.now() });
    commandTimer = ctxRef.setTimeout(() => {
      if (commandWakeId !== wakeId) return;
      disarmCommand();
      ctxRef?.emit('voice.command.timeout', { kind: 'pc', device: 'desktop', wakeId, at: Date.now() });
      emitStatus();
    }, COMMAND_WINDOW_MS);
    emitStatus();
  };

  const stop = () => {
    generation += 1;
    if (restartTimer && ctxRef) ctxRef.clearTimeout(restartTimer);
    restartTimer = null;
    disarmCommand();
    const child = listener;
    listener = null;
    ready = false;
    engine = 'none';
    recognitionModel = 'none';
    child?.kill();
    emitStatus();
  };

  const attach = (child: ReturnType<typeof spawn>, config: VoiceConfig, selectedEngine: Exclude<VoiceEngine, 'none'>) => {
    listener = child;
    engine = selectedEngine;
    ready = false;
    emitStatus();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let buffer = '';
    let errorBuffer = '';
    const handleWake = (text: string, matchedPhrase = config.wakePhrase) => {
      const now = Date.now();
      if (lastWakeAt && now - lastWakeAt < 2500) return;
      lastWakeAt = now;
      lastText = text;
      const wakeId = `wake-${now}`;
      const command = extractWakeCommand(text, matchedPhrase, config.wakePhrase);
      const data = {
        wakeId,
        device: 'desktop',
        kind: 'pc',
        text,
        wakePhrase: config.wakePhrase,
        matchedPhrase,
        commandText: command,
        awaitingCommand: !command,
        at: now,
      };
      ctxRef?.emit('voice.wake', data);
      if (command) emitCommand(command, 'inline', wakeId);
      else if (config.audibleReply) {
        void speakReply(config, (message) => {
          lastError = message;
          emitStatus();
        }).finally(() => armCommand(wakeId));
      } else {
        armCommand(wakeId);
      }
      emitStatus();
    };
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('__MR_ROBOT_READY__')) {
          ready = true;
          const reportedModel = line.slice('__MR_ROBOT_READY__'.length).trim();
          recognitionModel = selectedEngine === 'windows-speech'
            ? 'windows-sapi'
            : reportedModel === 'hybrid-korean' ? 'hybrid-korean' : 'sensevoice';
          lastError = '';
          emitStatus();
          continue;
        }
        if (line.startsWith('__MR_ROBOT_EVENT__')) {
          try {
            const event = JSON.parse(line.slice('__MR_ROBOT_EVENT__'.length)) as {
              kind?: 'audio' | 'heard';
              text?: string;
              rawText?: string;
              alternatives?: string[];
              matched?: boolean;
              matchedPhrase?: string;
              matchScore?: number;
              speechMs?: number;
              inputLevel?: number;
            };
            const now = Date.now();
            if (typeof event.inputLevel === 'number') {
              inputLevel = Math.max(0, Math.min(1, event.inputLevel));
              lastAudioAt = now;
            }
            if (event.kind === 'heard' && event.text) {
              lastHeardAt = now;
              lastRawHeardText = event.text.trim();
              lastHeardText = event.matched
                ? improveKoreanCommandTranscript(lastRawHeardText)
                : chooseKoreanCommandTranscript(event.alternatives?.length ? event.alternatives : [lastRawHeardText], config.wakePhrase);
              lastMatchScore = Math.max(0, Math.min(1, Number(event.matchScore ?? 0)));
              lastSpeechMs = Math.max(0, Number(event.speechMs ?? 0));
              if (event.matched) handleWake(lastHeardText, event.matchedPhrase || config.wakePhrase);
              else if (commandArmedUntil && now <= commandArmedUntil && commandWakeId) emitCommand(lastHeardText, 'follow-up', commandWakeId);
            }
            emitStatus();
          } catch (error) {
            lastError = `음성 이벤트 해석 실패: ${error instanceof Error ? error.message : String(error)}`;
            emitStatus();
          }
          continue;
        }
        if (line.startsWith('__MR_ROBOT_HEARD__')) {
          lastHeardAt = Date.now();
          lastHeardText = line.slice('__MR_ROBOT_HEARD__'.length).trim();
          if (commandArmedUntil && Date.now() <= commandArmedUntil && commandWakeId && lastHeardText) emitCommand(lastHeardText, 'follow-up', commandWakeId);
          emitStatus();
          continue;
        }
        if (!line.startsWith('__MR_ROBOT_WAKE__')) continue;
        const text = line.slice('__MR_ROBOT_WAKE__'.length).trim();
        handleWake(text);
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      errorBuffer = (errorBuffer + chunk).slice(-4000);
    });
    child.once('error', (error) => {
      lastError = `음성 수신기 시작 실패: ${error.message}`;
      ctxRef?.logger.warn(lastError);
      emitStatus();
    });
    child.once('close', (code) => {
      if (listener !== child) return;
      listener = null;
      ready = false;
      engine = 'none';
      recognitionModel = 'none';
      if (code !== 0) lastError = errorBuffer.trim() || `음성 수신기가 종료되었습니다 (코드 ${code ?? 'unknown'}).`;
      emitStatus();
      if (activeConfig.enabled && ctxRef) {
        restartTimer = ctxRef.setTimeout(() => {
          restartTimer = null;
          if (activeConfig.enabled) start(activeConfig);
        }, 5000);
      }
    });
  };

  const startWindows = (config: VoiceConfig) => {
    const phrase = psEscape(config.wakePhrase);
    const language = psEscape(config.language);
    const script = [
      "$ErrorActionPreference='Stop'",
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new()',
      'Add-Type -AssemblyName System.Speech',
      `$culture=[Globalization.CultureInfo]::GetCultureInfo('${language}')`,
      '$recognizerInfo=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1',
      "if($null -eq $recognizerInfo){ throw 'Windows 한국어 음성 인식기가 설치되지 않았습니다.' }",
      '$r=New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizerInfo)',
      '$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
      '$r.SetInputToDefaultAudioDevice()',
      `$needle=('${phrase}' -replace '\\s','')`,
      "[Console]::Out.WriteLine('__MR_ROBOT_READY__')",
      '[Console]::Out.Flush()',
      'while($true){',
      '  $x=$r.Recognize()',
      '  if($null -eq $x){ continue }',
      "  $heard=($x.Text -replace '\\s','')",
      '  if($heard.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0){',
      "    [Console]::Out.WriteLine('__MR_ROBOT_WAKE__'+$x.Text)",
      '    [Console]::Out.Flush()',
      '  }else{',
      "    [Console]::Out.WriteLine('__MR_ROBOT_HEARD__'+$x.Text)",
      '    [Console]::Out.Flush()',
      '  }',
      '}',
    ].join('; ');
    attach(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }), config, 'windows-speech');
    recognitionModel = 'windows-sapi';
  };

  const startLocal = (config: VoiceConfig, runtime: NonNullable<ReturnType<typeof localRuntime>>) => {
    if (!orphanCleanupDone) {
      orphanCleanupDone = true;
      const attempt = generation;
      const target = psEscape(runtime.listener);
      const cleanupScript = [
        `$target='${target}'`,
        "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*'+$target+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cleanupScript], { windowsHide: true, timeout: 12_000 }, () => {
        if (attempt === generation && activeConfig.enabled && !listener) startLocal(config, runtime);
      });
      return;
    }
    mkdirSync(runtime.root, { recursive: true });
    writeFileSync(runtime.listener, LOCAL_LISTENER_SOURCE, 'utf8');
    const modelArgs = runtime.accurateKorean && config.language.toLowerCase().startsWith('ko') ? [
      '--ko-encoder', runtime.koreanEncoder,
      '--ko-decoder', runtime.koreanDecoder,
      '--ko-joiner', runtime.koreanJoiner,
      '--ko-tokens', runtime.koreanTokens,
    ] : [];
    attach(spawn('py', [
      '-u', runtime.listener,
      '--model', runtime.model,
      '--tokens', runtime.tokens,
      '--vad', runtime.vad,
      '--phrase', config.wakePhrase,
      '--language', config.language,
      '--sensitivity', String(config.sensitivity),
      ...modelArgs,
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }), config, 'sherpa-onnx');
  };

  const start = (config: VoiceConfig) => {
    stop();
    activeConfig = config;
    lastError = '';
    if (!config.enabled || process.platform !== 'win32') { emitStatus(); return; }
    const attempt = generation;
    const runtime = localRuntime();
    if (runtime) { startLocal(config, runtime); return; }
    void installedRecognizers().then((recognizers) => {
      if (attempt !== generation || !activeConfig.enabled) return;
      const compatible = recognizers.some((item) => item.language.toLowerCase() === config.language.toLowerCase());
      if (compatible) { startWindows(config); return; }
      lastError = '한국어 음성 엔진이 없습니다. 설정에서 로컬 한국어 음성 엔진을 설치하세요.';
      emitStatus();
    });
  };

  return {
    manifest: {
      id: 'voice-wake', name: 'Voice Wake', version: '0.7.0', kind: 'input', enabledByDefault: true,
      description: '한국어 전용 고정확도 인식으로 호출어 뒤의 명령을 실행하고 로컬 TTS 음성으로 응답합니다.',
      capabilities: ['voice.dictation', 'voice.wake-phrase', 'voice.always-listening', 'voice.command', 'voice.custom-reply'],
      permissions: ['microphone'], dependencies: [{ id: 'speech-ko', name: '로컬 한국어 음성 엔진', required: true }],
    },
    activate(ctx) {
      ctxRef = ctx;
      const get = () => ({ ...DEFAULTS, ...(ctx.storage.get<VoiceConfig>('config') ?? {}) });
      activeConfig = get();
      ctx.registerCommand('voice.status', async () => {
        const [recognizers, voices] = await Promise.all([installedRecognizers(), installedSynthesizers()]);
        const matching = recognizers.filter((item) => item.language.toLowerCase() === activeConfig.language.toLowerCase());
        const local = localRuntime();
        return {
          ...activeConfig,
          listening: Boolean(listener && ready),
          starting: Boolean(listener && !ready),
          engine,
          recognitionModel,
          accurateKoreanModel: Boolean(local?.accurateKorean),
          engineAvailable: Boolean(local) || matching.length > 0,
          recognizers,
          voices,
          lastError,
          lastWakeAt,
          lastText,
          lastHeardAt,
          lastHeardText,
          lastRawHeardText,
          lastMatchScore,
          lastSpeechMs,
          inputLevel,
          lastAudioAt,
          commandListening: Boolean(commandArmedUntil && commandArmedUntil > Date.now()),
          commandArmedUntil,
          lastCommandAt,
          lastCommandText,
          canInstall: process.platform === 'win32',
        };
      }, { destructive: false });
      ctx.registerCommand('voice.config.get', get, { destructive: false });
      ctx.registerCommand('voice.config.set', (raw) => {
        const body = (raw ?? {}) as Partial<VoiceConfig>;
        const current = get();
        const next: VoiceConfig = {
          enabled: body.enabled === true,
          wakePhrase: String(body.wakePhrase ?? current.wakePhrase).trim().slice(0, 40) || '로봇',
          language: String(body.language ?? current.language).trim().slice(0, 20) || 'ko-KR',
          pcPriorityMs: Math.max(300, Math.min(3000, Number(body.pcPriorityMs ?? current.pcPriorityMs))),
          audibleReply: body.audibleReply !== false,
          sensitivity: Math.max(0.5, Math.min(0.9, Number(body.sensitivity ?? current.sensitivity))),
          replyPreset: body.replyPreset === 'system' || body.replyPreset === 'custom' ? body.replyPreset : 'neon-runner',
          voiceName: String(body.voiceName ?? current.voiceName).trim().slice(0, 160),
          replyText: String(body.replyText ?? current.replyText).trim().slice(0, 120) || '응, 듣고 있어.',
          replyRate: Math.max(-10, Math.min(10, Math.round(Number(body.replyRate ?? current.replyRate)))),
          replyVolume: Math.max(0, Math.min(100, Math.round(Number(body.replyVolume ?? current.replyVolume)))),
        };
        ctx.storage.set('config', next);
        start(next);
        return next;
      }, { destructive: true, adminOnly: true });
      ctx.registerCommand('voice.reply.test', () => speakReply(activeConfig, (message) => {
        lastError = message;
        emitStatus();
      }), { destructive: false, adminOnly: true });
      start(activeConfig);
    },
    deactivate() { activeConfig = { ...activeConfig, enabled: false }; stop(); ctxRef = null; },
  };
}
