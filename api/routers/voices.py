import base64
import os
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
import httpx
from pydantic import BaseModel

router = APIRouter()

TTS_PROXY_URL = os.environ.get("TTS_PROXY_URL", "http://tts_proxy:8083").rstrip("/")


class BakeVoiceRequest(BaseModel):
    name: str
    rvc_model: Optional[str] = ""
    base_speaker: str = "ryan"
    instruct: Optional[str] = None
    use_voice_design: bool = False
    f0_up_key: int = 0
    pitch_algo: str = "rmvpe"
    index_influence: float = 0.66
    consonant_breath_protection: float = 0.33
    denoise: str = "off"
    speed: float = 1.0
    sample_text: Optional[str] = None
    wav_b64: Optional[str] = None


@router.get("/voices")
async def list_voices():
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{TTS_PROXY_URL}/voices")
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.post("/voices/bake")
async def bake_voice(payload: BakeVoiceRequest):
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(f"{TTS_PROXY_URL}/voices/bake", json=payload.model_dump())
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.post("/voices/upload-rvc")
async def upload_rvc_model(file: UploadFile = File(...)):
    if not file.filename or not file.filename.endswith(".pth"):
        raise HTTPException(status_code=400, detail="File must be a .pth RVC model")
    raw = await file.read()
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{TTS_PROXY_URL}/voices/upload-rvc",
            json={"filename": file.filename, "data_b64": base64.b64encode(raw).decode("ascii")},
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()


@router.post("/voices/preview-bake")
async def preview_bake_voice(payload: BakeVoiceRequest):
    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            f"{TTS_PROXY_URL}/voices/preview-bake", json=payload.model_dump()
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return Response(content=resp.content, media_type="audio/wav")


@router.get("/voices/base/{speaker}/preview")
async def preview_base_speaker(speaker: str):
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.get(f"{TTS_PROXY_URL}/voices/base/{speaker}/preview")
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return Response(content=resp.content, media_type="audio/wav")


@router.get("/voices/{name}/preview")
async def preview_voice(name: str):
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{TTS_PROXY_URL}/voices/{name}/preview")
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return Response(content=resp.content, media_type="audio/wav")


@router.delete("/voices/{name}")
async def delete_voice(name: str):
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(f"{TTS_PROXY_URL}/voices/{name}")
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()
