#!/usr/bin/env python3
"""Containerized Qwen3-TTS + RVC Voice Baking & OpenAI TTS Proxy."""

import atexit
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import random
import re
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave

HOST = os.environ.get("PROXY_HOST", "0.0.0.0")
PORT = int(os.environ.get("PROXY_PORT", "8083"))
UPSTREAM = os.environ.get("TTS_UPSTREAM", "http://127.0.0.1:8082")
TTS_BACKEND = os.environ.get("TTS_BACKEND", "qwentts").strip().lower()
HIGGS_URL = os.environ.get("HIGGS_URL", "http://host.docker.internal:8084").rstrip("/")
HIGGS_MODEL = os.environ.get("HIGGS_MODEL", "bosonai/higgs-audio-v3-tts-4b")
HIGGS_TEMPERATURE = float(os.environ.get("HIGGS_TEMPERATURE", "0.7"))
HIGGS_TOP_P = float(os.environ.get("HIGGS_TOP_P", "0.95"))
HIGGS_TOP_K = int(os.environ.get("HIGGS_TOP_K", "50"))
S2PRO_URL = os.environ.get("S2PRO_URL", "http://host.docker.internal:8085").rstrip("/")
S2PRO_MODEL = os.environ.get("S2PRO_MODEL", "fishaudio/s2-pro")
QWEN3TTS_URL = os.environ.get("QWEN3TTS_URL", "http://host.docker.internal:8086").rstrip("/")
QWEN3TTS_MODEL = os.environ.get("QWEN3TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
QWEN3TTS_TEMPERATURE = float(os.environ.get("QWEN3TTS_TEMPERATURE", "0.75"))
QWEN3TTS_TOP_P = float(os.environ.get("QWEN3TTS_TOP_P", "0.92"))
QWEN3TTS_TOP_K = int(os.environ.get("QWEN3TTS_TOP_K", "50"))


def _is_omni_backend() -> bool:
    return TTS_BACKEND in ("higgs", "s2pro", "qwen3tts")


def _omni_url() -> str:
    if TTS_BACKEND == "s2pro":
        return S2PRO_URL
    if TTS_BACKEND == "qwen3tts":
        return QWEN3TTS_URL
    return HIGGS_URL


def _omni_model() -> str:
    if TTS_BACKEND == "s2pro":
        return S2PRO_MODEL
    if TTS_BACKEND == "qwen3tts":
        return QWEN3TTS_MODEL
    return HIGGS_MODEL
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/app/models"))
VOICES_DIR = Path(os.environ.get("VOICES_DIR", "/app/voices"))
RVC_DIR = Path(os.environ.get("RVC_MODELS_DIR", "/app/rvc_models"))
TTS_SERVER_BIN = os.environ.get("TTS_SERVER_BIN", "/app/bin/tts-server")
QWEN_TTS_BIN = os.environ.get("QWEN_TTS_BIN", "/app/bin/qwen-tts")
BASE_MODEL = MODELS_DIR / os.environ.get("BASE_MODEL", "qwen-talker-1.7b-base-Q8_0.gguf")
CUSTOM_MODEL = MODELS_DIR / os.environ.get("CUSTOM_MODEL", "qwen-talker-1.7b-customvoice-Q8_0.gguf")
DESIGN_MODEL = MODELS_DIR / os.environ.get("DESIGN_MODEL", "qwen-talker-1.7b-voicedesign-Q8_0.gguf")
CODEC_MODEL = MODELS_DIR / os.environ.get("CODEC_MODEL", "qwen-tokenizer-12hz-Q8_0.gguf")
BASE_SAMPLES_DIR = VOICES_DIR / "_base_samples"
BASE_SPEAKERS = {"ryan", "serena", "vivian", "aiden", "uncle_fu", "ono_anna", "sohee", "eric", "dylan"}
BASE_PREVIEW_TEXT = "Hey there, this is a quick sample of my natural voice so you can hear my pitch, pace, and tone before baking."
TTS_DEVICE = os.environ.get("TTS_DEVICE", "Vulkan0")
IDLE_TIMEOUT = int(os.environ.get("IDLE_TIMEOUT", "300"))
LOUDNORM = os.environ.get("LOUDNORM", "1") == "1"

DEFAULT_SAMPLE_TEXT = (
    "Alright, listen close, see? You walk into my joint, you play by my rules. "
    "The little guy in the corner? Nobody noticed him, till he took the whole table."
)

_lock = threading.Lock()
_bake_lock = threading.Lock()
_in_flight = 0
_last_used = 0.0
_child: subprocess.Popen | None = None
_rvc_converter = None


def _safe_name(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", name.strip()).strip("_").lower()
    if not cleaned:
        raise ValueError("Voice name must contain letters or digits")
    return cleaned


def _upstream_ready() -> bool:
    u = urllib.parse.urlparse(UPSTREAM)
    try:
        with socket.create_connection((u.hostname or "127.0.0.1", u.port or 8082), timeout=1):
            return True
    except OSError:
        return False


def _register_voice_on_server(name: str, wav_path: Path, txt_path: Path) -> None:
    if not wav_path.exists():
        return
    ref_text = txt_path.read_text(encoding="utf-8").strip() if txt_path.exists() else ""
    payload = {
        "name": name,
        "ref_text": ref_text,
        "wav_b64": base64.b64encode(wav_path.read_bytes()).decode("ascii"),
    }
    req = urllib.request.Request(
        f"{UPSTREAM}/v1/audio/voices",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def _register_all_voices() -> None:
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    for wav in sorted(VOICES_DIR.glob("*.wav")):
        try:
            _register_voice_on_server(wav.stem, wav, wav.with_suffix(".txt"))
        except Exception as exc:
            print(f"[warn] failed registering voice {wav.stem}: {exc}", flush=True)


def _ensure_tts_server() -> None:
    global _child
    if _is_omni_backend():
        return
    if _upstream_ready():
        return
    with _lock:
        if _upstream_ready():
            return
        cmd = [
            TTS_SERVER_BIN,
            "--model", str(BASE_MODEL),
            "--codec", str(CODEC_MODEL),
            "--device", TTS_DEVICE,
            "--host", "127.0.0.1",
            "--port", str(urllib.parse.urlparse(UPSTREAM).port or 8082),
            "--lang", "English",
            "--alias", "qwen3-tts",
            "--clamp-fp16",
        ]
        _child = subprocess.Popen(cmd)
        for _ in range(120):
            if _upstream_ready():
                _register_all_voices()
                return
            time.sleep(0.5)
        raise RuntimeError("Timed out waiting for tts-server")


def _stop_tts_server() -> None:
    global _child
    if _child is not None and _child.poll() is None:
        _child.terminate()
        try:
            _child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _child.kill()
    _child = None


def _idle_reaper() -> None:
    global _last_used
    while True:
        time.sleep(30)
        if IDLE_TIMEOUT <= 0:
            continue
        with _lock:
            if _in_flight == 0 and _last_used > 0 and (time.monotonic() - _last_used) > IDLE_TIMEOUT:
                _stop_tts_server()
                _last_used = 0.0


def _sanitize_tts_text(text: str) -> str:
    t = (text or "").strip()
    t = t.replace("\u2014", ", ").replace("\u2013", ", ").replace("--", ", ")
    t = t.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'")
    t = re.sub(r"\.{3,}", ".", t)
    t = re.sub(r"[*_`#]+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _split_tts_chunks(text: str, max_chars: int = 300) -> list[str]:
    clean = _sanitize_tts_text(text)
    if len(clean) <= max_chars:
        return [clean] if clean else []
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", clean) if s.strip()]
    chunks: list[str] = []
    cur = ""
    for sent in sentences:
        if cur and len(cur) + 1 + len(sent) > max_chars:
            chunks.append(cur)
            cur = sent
        elif not cur and len(sent) > max_chars:
            # Split extra-long single sentences on commas/semicolons
            parts = [p.strip() for p in re.split(r"(?<=[,;:])\s+", sent) if p.strip()]
            for p in parts:
                if cur and len(cur) + 1 + len(p) > max_chars:
                    chunks.append(cur)
                    cur = p
                else:
                    cur = f"{cur} {p}".strip() if cur else p
        else:
            cur = f"{cur} {sent}".strip() if cur else sent
    if cur:
        chunks.append(cur)
    return chunks


def _gap_ms_for_chunk(text: str) -> int:
    t = (text or "").rstrip()
    if t.endswith(("?", "!")):
        return 160
    if t.endswith("."):
        return 150
    return 100


def _is_chunk_glitchy(wav_bytes: bytes, text: str) -> tuple[bool, str]:
    """Quick acoustic sanity check to catch static/screech/truncated chunks."""
    try:
        import numpy as np

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            sr = wf.getframerate()
            raw = wf.readframes(wf.getnframes())
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        dur = len(x) / float(sr) if sr > 0 else 0.0
        if dur <= 0.15:
            return True, f"too short ({dur:.2f}s)"
        clean_len = len(re.sub(r"\s+", " ", (text or "").strip()))
        if clean_len >= 20:
            cps = clean_len / dur
            if cps > 28.0 or cps < 4.0:
                return True, f"bad rate ({cps:.1f} cps)"
        rms_db = float(20.0 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9))
        if rms_db < -45.0:
            return True, f"silent ({rms_db:.1f} dB)"
        win = max(128, int(0.025 * sr))
        hop = max(64, int(0.010 * sr))
        hann = np.hanning(win)
        flats = []
        for i in range(0, len(x) - win, hop):
            fr = x[i : i + win]
            if float(np.sqrt(np.mean(fr ** 2))) < 0.01:
                continue
            mag = np.abs(np.fft.rfft(fr * hann)) + 1e-9
            flats.append(float(np.exp(np.mean(np.log(mag))) / np.mean(mag)))
        if flats and float(np.percentile(flats, 95)) > 0.85:
            return True, f"high noise flatness ({np.percentile(flats, 95):.2f})"
    except Exception:
        return False, ""
    return False, ""


def _concat_wavs(wav_list: list[bytes], chunk_texts: list[str] | None = None) -> bytes:
    if len(wav_list) == 1:
        return wav_list[0]
    import numpy as np

    buf = io.BytesIO()
    params = None
    with wave.open(buf, "wb") as out_wf:
        for idx, raw in enumerate(wav_list):
            with wave.open(io.BytesIO(raw), "rb") as in_wf:
                if params is None:
                    params = in_wf.getparams()
                    out_wf.setnchannels(params.nchannels)
                    out_wf.setsampwidth(params.sampwidth)
                    out_wf.setframerate(params.framerate)
                pcm = np.frombuffer(in_wf.readframes(in_wf.getnframes()), dtype=np.int16).astype(np.float32)
            fade = min(int(params.framerate * 0.010), len(pcm) // 4)
            if fade > 0:
                if idx > 0:
                    pcm[:fade] *= np.linspace(0.0, 1.0, fade, dtype=np.float32)
                if idx < len(wav_list) - 1:
                    pcm[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
            if idx > 0:
                prev_text = chunk_texts[idx - 1] if chunk_texts and idx - 1 < len(chunk_texts) else ""
                gap_ms = _gap_ms_for_chunk(prev_text)
                silence_frames = int(params.framerate * (gap_ms / 1000.0))
                out_wf.writeframes(b"\x00" * (silence_frames * params.nchannels * params.sampwidth))
            out_wf.writeframes(np.clip(pcm, -32768, 32767).astype(np.int16).tobytes())
    return buf.getvalue()


def _clamp_speed(val: object) -> float:
    try:
        s = float(val) if val is not None else 1.0
    except (TypeError, ValueError):
        s = 1.0
    return max(0.5, min(2.0, round(s, 2)))


def _voice_speed(name: str) -> float:
    meta_path = VOICES_DIR / f"{name}.json"
    if not meta_path.exists():
        return 1.0
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        return _clamp_speed(data.get("speed", 1.0))
    except Exception:
        return 1.0


def _atempo_filter(speed: float) -> str:
    if speed < 0.5:
        second = max(0.5, speed / 0.5)
        return f"atempo=0.50,atempo={second:.2f}"
    if speed > 2.0:
        second = min(2.0, speed / 2.0)
        return f"atempo=2.00,atempo={second:.2f}"
    return f"atempo={speed:.2f}"


def _apply_wav_speed(wav_bytes: bytes, speed: float) -> bytes:
    if abs(speed - 1.0) < 0.01:
        return wav_bytes
    cmd = [
        "ffmpeg", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
        "-af", _atempo_filter(speed),
        "-f", "wav", "pipe:1",
    ]
    return subprocess.run(cmd, input=wav_bytes, capture_output=True, check=True).stdout


def _trim_silence(wav_bytes: bytes) -> bytes:
    """Trim leading/trailing silence without altering speaker tempo or cadence."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            in_p = Path(tmp) / "in.wav"
            out_p = Path(tmp) / "out.wav"
            in_p.write_bytes(wav_bytes)
            subprocess.run(
                [
                    "ffmpeg", "-y", "-loglevel", "error", "-i", str(in_p),
                    "-af", "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,areverse",
                    str(out_p),
                ],
                check=True,
            )
            return out_p.read_bytes()
    except Exception:
        return wav_bytes


def _normalize_speech_tempo(wav_bytes: bytes, text: str, target_speed: float = 1.0) -> tuple[bytes, float]:
    """Trim silence and gently nudge extreme speaking rates toward ~3.0 wps * target_speed."""
    trimmed = _trim_silence(wav_bytes)
    words = max(1, len((text or "").split()))
    try:
        with wave.open(io.BytesIO(trimmed), "rb") as wf:
            sr = wf.getframerate()
            dur = wf.getnframes() / float(sr) if sr else 0.0
    except Exception:
        dur = 0.0
    if dur <= 0.1:
        return trimmed, _clamp_speed(target_speed)
    actual_wps = words / dur
    # Only nudge if outside normal conversational range (2.6 - 3.3 wps)
    if 2.6 <= actual_wps <= 3.3:
        norm = 1.0
    else:
        norm = max(0.90, min(1.12, 3.0 / actual_wps))
    eff_speed = norm * float(target_speed)
    return trimmed, max(0.65, min(1.35, round(eff_speed, 2)))


def _wav_to_mp3(wav_bytes: bytes, speed: float = 1.0) -> bytes:
    cmd = ["ffmpeg", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"]
    filters: list[str] = []
    if abs(speed - 1.0) >= 0.01:
        filters.append(_atempo_filter(speed))
    if LOUDNORM:
        filters.append("loudnorm=I=-16:TP=-1.5:LRA=11")
    if filters:
        cmd.extend(["-af", ",".join(filters)])
    cmd.extend(["-f", "mp3", "-b:a", "192k", "pipe:1"])
    return subprocess.run(cmd, input=wav_bytes, capture_output=True, check=True).stdout


def _get_rvc():
    global _rvc_converter
    if _rvc_converter is None:
        try:
            os.nice(10)
        except OSError:
            pass
        import torch
        from infer_rvc_python import BaseLoader
        torch.set_num_threads(24)
        print("[tts_proxy] Initializing RVC BaseLoader (only_cpu=True, threads=24)", flush=True)
        _rvc_converter = BaseLoader(only_cpu=True)
    return _rvc_converter


def _synthesize_voice_wav(body: dict, out_wav: Path, tag: str = "preview", apply_speed: bool = False) -> str:
    with _bake_lock:
        return _synthesize_voice_wav_locked(body, out_wav, tag, apply_speed=apply_speed)


def _synthesize_voice_wav_locked(body: dict, out_wav: Path, tag: str = "preview", apply_speed: bool = False) -> str:
    sample_text = (body.get("sample_text") or DEFAULT_SAMPLE_TEXT).strip()
    base_speaker = (body.get("base_speaker") or "ryan").strip()
    instruct = (body.get("instruct") or "").strip()
    use_voice_design = bool(body.get("use_voice_design")) or bool(instruct)
    rvc_model = (body.get("rvc_model") or "").strip()
    f0_up_key = int(body.get("f0_up_key") or 0)
    pitch_algo = (body.get("pitch_algo") or "rmvpe").strip().lower()
    if pitch_algo not in {"rmvpe", "crepe", "harvest", "pm"}:
        pitch_algo = "rmvpe"
    index_influence = float(body.get("index_influence") if body.get("index_influence") is not None else 0.66)
    index_influence = max(0.0, min(1.0, index_influence))
    consonant_protection = float(
        body.get("consonant_breath_protection") if body.get("consonant_breath_protection") is not None else 0.33
    )
    consonant_protection = max(0.0, min(0.5, consonant_protection))
    denoise = (body.get("denoise") or "off").strip().lower()
    if denoise not in {"off", "gentle", "strong"}:
        denoise = "off"
    wav_b64 = body.get("wav_b64")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        raw_wav = tmp_dir / "base.wav"

        if wav_b64:
            raw_wav.write_bytes(base64.b64decode(wav_b64))
        elif _is_omni_backend() and not use_voice_design:
            req = urllib.request.Request(
                f"{_omni_url()}/v1/audio/speech",
                data=json.dumps({
                    "model": _omni_model(),
                    "input": sample_text,
                    "response_format": "wav",
                }).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                raw_wav.write_bytes(resp.read())
        else:
            # Temporarily stop tts-server if running so Vulkan VRAM is free for qwen-tts CLI
            with _lock:
                _stop_tts_server()
            if use_voice_design:
                if not DESIGN_MODEL.exists():
                    raise FileNotFoundError(f"VoiceDesign model not found: {DESIGN_MODEL.name}")
                if not instruct:
                    raise ValueError("VoiceDesign requires an instruct description")
                cmd = [
                    QWEN_TTS_BIN,
                    "--model", str(DESIGN_MODEL),
                    "--codec", str(CODEC_MODEL),
                    "--device", TTS_DEVICE,
                    "--instruct", instruct,
                    "--lang", "English",
                    "-o", str(raw_wav),
                ]
            else:
                cmd = [
                    QWEN_TTS_BIN,
                    "--model", str(CUSTOM_MODEL),
                    "--codec", str(CODEC_MODEL),
                    "--device", TTS_DEVICE,
                    "--speaker", base_speaker,
                    "--lang", "English",
                    "-o", str(raw_wav),
                ]
            subprocess.run(
                cmd,
                input=sample_text,
                text=True,
                check=True,
            )

        src_wav = raw_wav
        if rvc_model:
            with _lock:
                _stop_tts_server()
            pth_path = (RVC_DIR / rvc_model).resolve()
            if not str(pth_path).startswith(str(RVC_DIR.resolve())) or not pth_path.exists():
                raise FileNotFoundError(f"RVC model not found: {rvc_model}")
            index_path = pth_path.with_suffix(".index")
            converter = _get_rvc()
            converter.apply_conf(
                tag=tag,
                file_model=str(pth_path),
                file_index=str(index_path) if index_path.exists() else "",
                pitch_algo=pitch_algo,
                pitch_lvl=f0_up_key,
                index_influence=index_influence,
                consonant_breath_protection=consonant_protection,
            )
            results = converter(
                str(raw_wav),
                tag_list=[tag],
                overwrite=True,
                type_output="wav",
                show_progress=False,
            )
            if not results or not Path(results[0]).exists():
                raise RuntimeError(f"RVC conversion produced no output: {results}")
            src_wav = Path(results[0])

        # Normalize to 24kHz mono WAV for clean Qwen3-TTS cloning (+ optional denoise / preview speed)
        ffmpeg_cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src_wav)]
        rnnoise_model = Path("/app/rnnoise_sh.rnnn")
        filters: list[str] = []
        if denoise == "gentle":
            if rnnoise_model.exists():
                filters.append(f"highpass=f=70,arnndn=m={rnnoise_model}:mix=0.75,loudnorm=I=-16:TP=-1.5:LRA=11")
            else:
                filters.append("highpass=f=70,afftdn=nr=8:nf=-30:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11")
        elif denoise == "strong":
            if rnnoise_model.exists():
                filters.append(f"highpass=f=70,arnndn=m={rnnoise_model}:mix=0.95,afftdn=nr=10:nf=-28:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11")
            else:
                filters.append("highpass=f=70,afftdn=nr=14:nf=-25:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11")
        if apply_speed:
            speed = _clamp_speed(body.get("speed"))
            if abs(speed - 1.0) >= 0.01:
                filters.append(f"atempo={speed:.2f}")
        if filters:
            ffmpeg_cmd.extend(["-af", ",".join(filters)])
        ffmpeg_cmd.extend(["-ar", "24000", "-ac", "1", str(out_wav)])
        subprocess.run(ffmpeg_cmd, check=True)

    return sample_text


def _bake_voice(body: dict) -> dict:
    name = _safe_name(body.get("name", ""))
    speed = _clamp_speed(body.get("speed"))
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    out_wav = VOICES_DIR / f"{name}.wav"
    out_txt = VOICES_DIR / f"{name}.txt"
    out_meta = VOICES_DIR / f"{name}.json"

    sample_text = _synthesize_voice_wav(body, out_wav, tag=name, apply_speed=False)
    # trimmed, ref_tempo = _normalize_speech_tempo(out_wav.read_bytes(), sample_text, speed)
    # ref_tempo = max(0.65, min(1.35, ref_tempo))
    trimmed, ref_tempo = _trim_silence(out_wav.read_bytes()), speed
    out_wav.write_bytes(_apply_wav_speed(trimmed, ref_tempo))
    out_txt.write_text(sample_text, encoding="utf-8")
    out_meta.write_text(json.dumps({"speed": speed}), encoding="utf-8")
    if _upstream_ready():
        _register_voice_on_server(name, out_wav, out_txt)
    return {"name": name, "sample_text": sample_text, "speed": speed}


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code: int, data: object) -> None:
        raw = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            return self._send_json(200, {"status": "ok"})
        if path == "/voices":
            VOICES_DIR.mkdir(parents=True, exist_ok=True)
            RVC_DIR.mkdir(parents=True, exist_ok=True)
            baked = [
                {
                    "name": w.stem,
                    "sample_text": w.with_suffix(".txt").read_text(encoding="utf-8").strip()
                    if w.with_suffix(".txt").exists()
                    else "",
                    "size_bytes": w.stat().st_size,
                    "speed": _voice_speed(w.stem),
                }
                for w in sorted(VOICES_DIR.glob("*.wav"))
            ]
            rvc_models = sorted(
                p.relative_to(RVC_DIR).as_posix() for p in RVC_DIR.rglob("*.pth")
            )
            catalog_path = RVC_DIR / "catalog.json"
            catalog_map = {}
            if catalog_path.exists():
                try:
                    catalog_map = json.loads(catalog_path.read_text(encoding="utf-8"))
                except Exception:
                    catalog_map = {}
            rvc_catalog = []
            for rel in rvc_models:
                entry = catalog_map.get(rel)
                if not entry:
                    parts = Path(rel).parts
                    entry = {
                        "name": Path(rel).stem.replace("_", " ").title(),
                        "gender": parts[0] if len(parts) > 3 else "other",
                        "ethnicity": parts[1] if len(parts) > 3 else "other",
                        "category": parts[2] if len(parts) > 3 else "other",
                        "pitch": "mid",
                        "energy": "conversational",
                        "timbre": [],
                        "accent": "",
                        "description": "",
                    }
                rvc_catalog.append({"path": rel, **entry})
            return self._send_json(
                200,
                {
                    "backend": TTS_BACKEND,
                    "base_speakers": ["default"] if _is_omni_backend() else sorted(BASE_SPEAKERS),
                    "baked": baked,
                    "rvc_models": rvc_models,
                    "rvc_catalog": rvc_catalog,
                    "voice_design_available": DESIGN_MODEL.exists(),
                },
            )

        mb = re.fullmatch(r"/voices/base/([a-zA-Z0-9_-]+)/preview", path)
        if mb:
            spk = mb.group(1)
            allowed = {"default"} if _is_omni_backend() else BASE_SPEAKERS
            if spk not in allowed:
                return self._send_json(404, {"error": f"Unknown base speaker: {spk}"})
            BASE_SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
            wav = BASE_SAMPLES_DIR / (f"{TTS_BACKEND}_{spk}.wav" if _is_omni_backend() else f"{spk}.wav")
            if not wav.exists():
                if _is_omni_backend():
                    req = urllib.request.Request(
                        f"{_omni_url()}/v1/audio/speech",
                        data=json.dumps({
                            "model": _omni_model(),
                            "input": BASE_PREVIEW_TEXT,
                            "response_format": "wav",
                        }).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=300) as resp:
                        wav.write_bytes(resp.read())
                else:
                    with _lock:
                        _stop_tts_server()
                    subprocess.run(
                        [
                            QWEN_TTS_BIN,
                            "--model", str(CUSTOM_MODEL),
                            "--codec", str(CODEC_MODEL),
                            "--device", TTS_DEVICE,
                            "--speaker", spk,
                            "--lang", "English",
                            "-o", str(wav),
                        ],
                        input=BASE_PREVIEW_TEXT,
                        text=True,
                        check=True,
                    )
            raw = wav.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        m = re.fullmatch(r"/voices/([a-zA-Z0-9_-]+)/preview", path)
        if m:
            name = m.group(1)
            wav = VOICES_DIR / f"{name}.wav"
            if not wav.exists():
                return self._send_json(404, {"error": "Voice not found"})
            raw = _apply_wav_speed(wav.read_bytes(), _voice_speed(name))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        if path == "/v1/models":
            model_id = (
                "fish-s2-pro"
                if TTS_BACKEND == "s2pro"
                else (
                    "higgs-audio-v3"
                    if TTS_BACKEND == "higgs"
                    else "qwen3-tts"
                )
            )
            return self._send_json(200, {"object": "list", "data": [{"id": model_id, "object": "model", "owned_by": "local"}]})

        self._send_json(404, {"error": "Not found"})

    def do_DELETE(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        m = re.fullmatch(r"/voices/([a-zA-Z0-9_-]+)", path)
        if not m:
            return self._send_json(404, {"error": "Not found"})
        name = m.group(1)
        wav = VOICES_DIR / f"{name}.wav"
        txt = VOICES_DIR / f"{name}.txt"
        meta = VOICES_DIR / f"{name}.json"
        wav.unlink(missing_ok=True)
        txt.unlink(missing_ok=True)
        meta.unlink(missing_ok=True)
        if _upstream_ready():
            try:
                req = urllib.request.Request(f"{UPSTREAM}/v1/audio/voices/{name}", method="DELETE")
                urllib.request.urlopen(req, timeout=5).read()
            except Exception:
                pass
        return self._send_json(200, {"deleted": name})

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/voices/bake":
                return self._send_json(200, _bake_voice(self._read_json()))

            if path == "/voices/preview-bake":
                body = self._read_json()
                with tempfile.TemporaryDirectory() as tmp:
                    preview_wav = Path(tmp) / "preview.wav"
                    sample_text = _synthesize_voice_wav(body, preview_wav, tag="preview", apply_speed=False)
                    raw = preview_wav.read_bytes()
                    speed = _clamp_speed(body.get("speed"))
                    # raw, eff_speed = _normalize_speech_tempo(raw, sample_text, speed)
                    raw, eff_speed = _trim_silence(raw), speed
                    raw = _apply_wav_speed(raw, eff_speed)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return

            if path == "/voices/upload-rvc":
                body = self._read_json()
                filename = Path(body.get("filename", "")).name
                if not filename.endswith(".pth"):
                    return self._send_json(400, {"error": "Filename must end with .pth"})
                RVC_DIR.mkdir(parents=True, exist_ok=True)
                (RVC_DIR / filename).write_bytes(base64.b64decode(body["data_b64"]))
                return self._send_json(200, {"uploaded": filename})

            if path.rstrip("/") == "/v1/audio/speech":
                global _in_flight, _last_used
                payload = self._read_json()
                req_fmt = payload.get("response_format", "mp3")
                convert_mp3 = req_fmt == "mp3"
                if convert_mp3:
                    payload["response_format"] = "wav"
                baked = sorted(w.stem for w in VOICES_DIR.glob("*.wav"))
                voice = str(payload.get("voice", "")).strip()
                if not voice or voice == "alloy" or voice not in baked:
                    if baked:
                        payload["voice"] = baked[0]
                target_voice = str(payload.get("voice", "")).strip()
                req_speed = payload.pop("speed", None)
                speed = _clamp_speed(req_speed) if req_speed is not None else _voice_speed(target_voice)
                body_bytes = json.dumps(payload).encode("utf-8")

                with _lock:
                    _in_flight += 1
                try:
                    _ensure_tts_server()
                    full_text = str(payload.get("input", ""))
                    max_chars = 300 if TTS_BACKEND == "qwen3tts" else (480 if _is_omni_backend() else 300)
                    chunks = _split_tts_chunks(full_text, max_chars=max_chars)
                    if not chunks:
                        chunks = [full_text]
                    wav_parts: list[bytes] = []
                    ctype = "audio/wav"
                    ref_b64: str | None = None
                    ref_txt: str = DEFAULT_SAMPLE_TEXT
                    if _is_omni_backend() and target_voice:
                        voice_wav = VOICES_DIR / f"{target_voice}.wav"
                        if voice_wav.exists():
                            ref_b64 = base64.b64encode(voice_wav.read_bytes()).decode("ascii")
                            txt_path = voice_wav.with_suffix(".txt")
                            if txt_path.exists():
                                ref_txt = txt_path.read_text(encoding="utf-8").strip()
                    base_seed = sum(ord(ch) for ch in (target_voice or "default")) + 42
                    for chunk_idx, chunk_text in enumerate(chunks):
                        if _is_omni_backend():
                            chunk_payload = {
                                "model": _omni_model(),
                                "input": chunk_text,
                                "response_format": "wav",
                            }
                            if TTS_BACKEND == "higgs":
                                chunk_payload["extra_params"] = {
                                    "temperature": HIGGS_TEMPERATURE,
                                    "top_p": HIGGS_TOP_P,
                                    "top_k": HIGGS_TOP_K,
                                }
                            elif TTS_BACKEND == "qwen3tts":
                                chunk_payload["language"] = "English"
                                chunk_payload["extra_params"] = {
                                    "temperature": QWEN3TTS_TEMPERATURE,
                                    "top_p": QWEN3TTS_TOP_P,
                                    "top_k": QWEN3TTS_TOP_K,
                                }
                            if ref_b64:
                                if TTS_BACKEND == "qwen3tts":
                                    chunk_payload["task_type"] = "Base"
                                chunk_payload["ref_audio"] = f"data:audio/wav;base64,{ref_b64}"
                                chunk_payload["ref_text"] = ref_txt
                            speech_url = f"{_omni_url()}/v1/audio/speech"
                        else:
                            chunk_payload = dict(payload)
                            chunk_payload["input"] = chunk_text
                            speech_url = f"{UPSTREAM}/v1/audio/speech"
                        chunk_wav = b""
                        for attempt in range(2):
                            if _is_omni_backend():
                                if TTS_BACKEND == "qwen3tts":
                                    chunk_payload["seed"] = random.randint(1, 2_147_483_647)
                                else:
                                    chunk_payload["seed"] = base_seed + chunk_idx * 17 + attempt
                                if TTS_BACKEND == "higgs":
                                    chunk_payload["extra_params"]["temperature"] = min(
                                        1.0, HIGGS_TEMPERATURE + 0.15 * attempt
                                    )
                            req = urllib.request.Request(
                                speech_url,
                                data=json.dumps(chunk_payload).encode("utf-8"),
                                headers={"Content-Type": "application/json"},
                                method="POST",
                            )
                            with urllib.request.urlopen(req, timeout=300) as resp:
                                chunk_wav = resp.read()
                                ctype = resp.headers.get("Content-Type", ctype)
                            glitchy, reason = _is_chunk_glitchy(chunk_wav, chunk_text)
                            if not glitchy:
                                break
                            if attempt == 0:
                                print(f"[tts_proxy] Retrying glitchy chunk ({reason}): {chunk_text[:60]}", flush=True)
                        wav_parts.append(chunk_wav)

                    resp_body = _trim_silence(_concat_wavs(wav_parts, chunks))
                    if convert_mp3:
                        resp_body = _wav_to_mp3(resp_body, speed=speed)
                        ctype = "audio/mpeg"
                    elif abs(speed - 1.0) >= 0.01:
                        resp_body = _apply_wav_speed(resp_body, speed)
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(resp_body)))
                    self.end_headers()
                    self.wfile.write(resp_body)
                finally:
                    with _lock:
                        _in_flight -= 1
                        _last_used = time.monotonic()
                return
        except urllib.error.HTTPError as exc:
            err = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)
            return
        except Exception as exc:
            return self._send_json(500, {"error": str(exc)})

        self._send_json(404, {"error": "Not found"})

    def log_message(self, format: str, *args) -> None:
        pass


if __name__ == "__main__":
    atexit.register(_stop_tts_server)
    signal.signal(signal.SIGTERM, lambda *_: (_stop_tts_server(), os._exit(0)))
    threading.Thread(target=_idle_reaper, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
