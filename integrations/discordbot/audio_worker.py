"""Offline ASR for one restored ticket attachment. No microphone or network.

Uses the public SenseVoice model through sherpa-onnx (see integration README).
This worker only returns speech text; it does not infer identity or emotions.
"""
import json
import re
import subprocess
import sys
from pathlib import Path


def transcribe(path, start=0, duration=120):
    import numpy as np
    import sherpa_onnx

    if not 0 <= start <= 36000 or not 1 <= duration <= 120:
        raise ValueError("Invalid audio window")
    path = Path(path)
    if path.stat().st_size > 25 * 1024 ** 2:
        raise ValueError("Audio file too large")
    decoded = subprocess.run([
        "ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
        "-threads", "1", "-ss", str(start), "-i", str(path), "-t", str(duration + 1),
        "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1",
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=35, check=True)
    if len(decoded.stdout) > (duration + 2) * 16000 * 4:
        raise ValueError("Decoded audio exceeded window")
    samples = np.frombuffer(decoded.stdout, dtype="<f4").copy()
    if not np.isfinite(samples).all():
        raise ValueError("Invalid samples")
    frames = int(round(duration * 16000))
    more = len(samples) > frames
    samples = samples[:frames]
    seconds = len(samples) / 16000
    peak = float(np.max(np.abs(samples))) if len(samples) else 0
    rms = float(np.sqrt(np.mean(samples ** 2))) if len(samples) else 0
    result = {"kind": "audio", "status": "transcribed", "text": "", "start_seconds": start,
              "read_seconds": seconds, "has_more": more, "next_start_seconds": start + seconds if more else None,
              "warning": "자동 음성 인식 결과입니다. 고유명사·작은 목소리는 오인식될 수 있습니다."}
    if peak < 0.0001 or seconds < 0.1:
        return {**result, "status": "no_speech", "warning": "녹음 신호가 없거나 너무 작아 음성을 확인하지 못했습니다."}
    if peak < 0.15:
        samples *= min(8.0, 0.8 / peak)
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model="/opt/asr/model.int8.onnx", tokens="/opt/asr/tokens.txt",
        language="auto", num_threads=2, use_itn=True,
    )
    parts = []
    for offset in range(0, len(samples), 20 * 16000):
        clip = samples[offset:offset + 20 * 16000]
        if np.sqrt(np.mean(clip ** 2)) < 0.0001:
            continue
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, clip)
        recognizer.decode_stream(stream)
        text = re.sub(r"<\|[^|]{0,80}\|>", "", stream.result.text).strip()
        if text:
            parts.append(text)
    result["text"] = "\n".join(parts)[:48000]
    if not result["text"]:
        result.update(status="no_speech", warning="소리 데이터는 있으나 말소리를 인식하지 못했습니다. 내용을 추측하지 마세요.")
    elif rms < 0.01:
        result["warning"] += " 원본 음량이 작아 정규화 후 처리했습니다."
    return result


if __name__ == "__main__":
    try:
        result = transcribe(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]))
    except Exception:
        result = {"kind": "audio", "status": "unreadable", "text": "",
                  "warning": "음성 디코딩 또는 인식에 실패했습니다. 원본은 보관되어 있습니다. 더 짧은 구간으로 다시 읽으세요."}
    print(json.dumps(result, ensure_ascii=False))
