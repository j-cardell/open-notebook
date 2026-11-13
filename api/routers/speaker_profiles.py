import json
import os
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
import httpx
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from loguru import logger
from pydantic import BaseModel, Field

from open_notebook.ai.provision import provision_langchain_model
from open_notebook.exceptions import OpenNotebookError
from open_notebook.podcasts.models import SpeakerProfile

router = APIRouter()


class SpeakerProfileResponse(BaseModel):
    id: str
    name: str
    description: str
    voice_model: Optional[str] = None
    speakers: List[Dict[str, Any]]


def _profile_to_response(profile: SpeakerProfile) -> SpeakerProfileResponse:
    return SpeakerProfileResponse(
        id=str(profile.id),
        name=profile.name,
        description=profile.description or "",
        voice_model=profile.voice_model,
        speakers=profile.speakers,
    )


@router.get("/speaker-profiles", response_model=List[SpeakerProfileResponse])
async def list_speaker_profiles():
    """List all available speaker profiles"""
    try:
        profiles = await SpeakerProfile.get_all(order_by="name asc")
        return [_profile_to_response(p) for p in profiles]
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch speaker profiles: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch speaker profiles")


@router.get("/speaker-profiles/{profile_name}", response_model=SpeakerProfileResponse)
async def get_speaker_profile(profile_name: str):
    """Get a specific speaker profile by name"""
    try:
        profile = await SpeakerProfile.get_by_name(profile_name)

        if not profile:
            raise HTTPException(
                status_code=404, detail=f"Speaker profile '{profile_name}' not found"
            )

        return _profile_to_response(profile)

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch speaker profile '{profile_name}': {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch speaker profile")


class SpeakerProfileCreate(BaseModel):
    name: str = Field(..., description="Unique profile name")
    description: str = Field("", description="Profile description")
    voice_model: Optional[str] = Field(None, description="Model record ID for TTS")
    speakers: List[Dict[str, Any]] = Field(
        ..., description="Array of speaker configurations"
    )


@router.post("/speaker-profiles", response_model=SpeakerProfileResponse)
async def create_speaker_profile(profile_data: SpeakerProfileCreate):
    """Create a new speaker profile"""
    try:
        profile = SpeakerProfile(
            name=profile_data.name,
            description=profile_data.description,
            voice_model=profile_data.voice_model,
            speakers=profile_data.speakers,
        )

        await profile.save()
        return _profile_to_response(profile)

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to create speaker profile: {e}")
        raise HTTPException(status_code=500, detail="Failed to create speaker profile")


@router.put("/speaker-profiles/{profile_id}", response_model=SpeakerProfileResponse)
async def update_speaker_profile(profile_id: str, profile_data: SpeakerProfileCreate):
    """Update an existing speaker profile"""
    try:
        profile = await SpeakerProfile.get(profile_id)

        if not profile:
            raise HTTPException(
                status_code=404, detail=f"Speaker profile '{profile_id}' not found"
            )

        for field, value in profile_data.model_dump(exclude_unset=True).items():
            setattr(profile, field, value)

        await profile.save()
        return _profile_to_response(profile)

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to update speaker profile: {e}")
        raise HTTPException(status_code=500, detail="Failed to update speaker profile")


@router.delete("/speaker-profiles/{profile_id}")
async def delete_speaker_profile(profile_id: str):
    """Delete a speaker profile"""
    try:
        profile = await SpeakerProfile.get(profile_id)

        if not profile:
            raise HTTPException(
                status_code=404, detail=f"Speaker profile '{profile_id}' not found"
            )

        await profile.delete()

        return {"message": "Speaker profile deleted successfully"}

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to delete speaker profile: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete speaker profile")


@router.post(
    "/speaker-profiles/{profile_id}/duplicate", response_model=SpeakerProfileResponse
)
async def duplicate_speaker_profile(profile_id: str):
    """Duplicate a speaker profile"""
    try:
        original = await SpeakerProfile.get(profile_id)

        if not original:
            raise HTTPException(
                status_code=404, detail=f"Speaker profile '{profile_id}' not found"
            )

        duplicate = SpeakerProfile(
            name=f"{original.name} - Copy",
            description=original.description,
            voice_model=original.voice_model,
            speakers=original.speakers,
        )

        await duplicate.save()
        return _profile_to_response(duplicate)

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to duplicate speaker profile: {e}")
        raise HTTPException(
            status_code=500, detail="Failed to duplicate speaker profile"
        )


class DesignMessage(BaseModel):
    role: str
    content: str


class SpeakerDesignRequest(BaseModel):
    messages: List[DesignMessage]
    finalize: bool = False


def _extract_json(text: str, allow_fallback_question: bool = True) -> Dict[str, Any]:
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
    if fence:
        cleaned = fence.group(1).strip()
    try:
        return json.loads(cleaned, strict=False)
    except Exception:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(cleaned[start : end + 1], strict=False)
            except Exception:
                pass
        if allow_fallback_question and cleaned:
            return {"status": "question", "reply": cleaned, "draft": None}
        raise


@router.post("/speaker-profiles/design")
async def design_speaker_profile(payload: SpeakerDesignRequest):
    """Interactive LLM assistant to design a podcast speaker profile + suggest a matching RVC voice."""
    tts_proxy_url = os.environ.get("TTS_PROXY_URL", "http://tts_proxy:8083").rstrip("/")
    baked_names: List[str] = []
    catalog_lines: List[str] = []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{tts_proxy_url}/voices")
            if resp.status_code == 200:
                vdata = resp.json()
                baked_names = [b.get("name", "") for b in vdata.get("baked", []) if b.get("name")]
                for item in vdata.get("rvc_catalog", []):
                    timbre = ",".join(item.get("timbre") or [])
                    catalog_lines.append(
                        f"{item.get('path')} | {item.get('name')} | {item.get('gender')}/{item.get('ethnicity')}/{item.get('category')} | "
                        f"{item.get('pitch')}/{item.get('energy')} | {timbre} | {item.get('accent')}"
                    )
    except Exception as exc:
        logger.warning(f"Could not fetch voices from tts_proxy for designer: {exc}")

    system_prompt = (
        "You are a creative podcast character & voice casting designer.\n"
        "Your job is to help the user build a vivid podcast speaker profile (name, backstory, personality/speech style) "
        "and recommend the best matching voice from their available RVC library or baked voices.\n\n"
        "IMPORTANT RULES:\n"
        "1. If the user's description is brief or missing key details (and finalize=False), ask 1-3 short, focused follow-up questions. "
        "Specifically ask about:\n"
        "   - What they do / their background & role on the podcast\n"
        "   - Where they are from (city/region/upbringing) so you can bake authentic dialect, glottal stops, contractions, and phonetic spellings "
        "(e.g. \"nothin'\", \"gonna\", \"ain't\", Philly \"wudder\", Boston \"wat'ah\", dropped g's, cadence, catchphrases) into their personality\n"
        "   - Their vocal energy & vibe (soft, gravelly, fast-talking, deadpan, booming, etc.)\n"
        "2. When you have enough detail (or when finalize=True), generate the complete speaker draft with status='ready'.\n"
        "3. In `personality`, include BOTH personality traits AND explicit TTS script-writing cues: regional dialect, glottal stops, phonetic spellings "
        "(including specific regional word respellings like Boston \"cah\" for car, \"pahk\" for park, \"yahd\" for yard, \"wat'ah\" for water, or Philly \"wudder\"), "
        "contractions, pacing, and verbal tics so the podcast scriptwriter writes lines that sound natural when spoken.\n"
        "   CRITICAL TTS RULE: NEVER use ALL CAPS for shouting or emphasis anywhere in `personality`, `backstory`, or `suggested_sample_text` "
        "(e.g. never write \"SHUT UP\" or \"KILLIN'\") — TTS engines read ALL CAPS letter-by-letter! Always use normal casing with exclamation marks.\n"
        "4. Pick `suggested_rvc_model` as an EXACT `path` from the RVC Catalog below (or null if none fit), and explain why in `suggested_rvc_reason`. "
        "Set `suggested_voice_id` to an existing baked voice name if one already fits, otherwise a clean lowercase_snake slug for baking.\n"
        "5. ALWAYS write `suggested_sample_text`: a 2-3 sentence (~10-second) in-character monologue written in the character's exact dialect, glottal stops, "
        "contractions, and vocal attitude (for example, Sal the gangster: \"Alright, listen close, see? You walk into my joint, you play by my rules...\"). "
        "This exact text will be spoken to bake their cloned voice, so it MUST sound like how the character actually talks.\n"
        "6. Pick `suggested_base_speaker` from ['ryan', 'serena', 'vivian', 'aiden', 'uncle_fu', 'ono_anna', 'sohee', 'eric', 'dylan'] (use 'ryan' or 'aiden'/'eric'/'dylan' for male, 'serena'/'vivian' for female) and `suggested_f0_up_key` (integer semitone shift -12 to 12, usually 0).\n\n"
        f"Already Baked Voices: {json.dumps(baked_names)}\n"
        f"RVC Catalog (path | name | gender/ethnicity/category | pitch/energy | timbre | accent):\n"
        + "\n".join(catalog_lines[:500])
        + "\n\nRespond ONLY with valid JSON matching this exact schema:\n"
        "{\n"
        '  "status": "question" | "ready",\n'
        '  "reply": "Short 1-2 sentence conversational reaction (plain text, no markdown asterisks)",\n'
        '  "questions": null | [\n'
        '    {"id": "q1", "label": "Short 2-4 word label", "prompt": "Clear question for the user", "placeholder": "e.g. example answer"}\n'
        '  ],\n'
        '  "draft": null | {\n'
        '    "name": "Character Name",\n'
        '    "backstory": "2-4 sentence backstory",\n'
        '    "personality": "Personality, speaking cadence, regional dialect, phonetic quirks & glottal stops",\n'
        '    "suggested_rvc_model": "exact/path/from/catalog.pth or null",\n'
        '    "suggested_rvc_reason": "Why this voice fits",\n'
        '    "suggested_voice_id": "slug_or_existing_baked_voice",\n'
        '    "suggested_base_speaker": "ryan",\n'
        '    "suggested_f0_up_key": 0,\n'
        '    "suggested_sample_text": "2-3 sentence in-character monologue with dialect & attitude for voice baking"\n'
        "  }\n"
        "}"
    )

    try:
        llm = await provision_langchain_model("", None, "chat", temperature=0.7, max_tokens=4096)
    except Exception:
        llm = await provision_langchain_model("", None, "transformation", temperature=0.7, max_tokens=4096)

    lc_messages: List[Any] = [SystemMessage(content=system_prompt)]
    for m in payload.messages:
        if m.role == "assistant":
            lc_messages.append(AIMessage(content=m.content))
        else:
            lc_messages.append(HumanMessage(content=m.content))
    if payload.finalize:
        lc_messages.append(
            HumanMessage(
                content="Please finalize now and return status='ready' with the complete draft JSON based on everything we've discussed."
            )
        )

    try:
        ai_resp = await llm.ainvoke(lc_messages)
        raw_text = ai_resp.content if isinstance(ai_resp.content, str) else str(ai_resp.content)
        return _extract_json(raw_text, allow_fallback_question=not payload.finalize)
    except Exception as exc:
        logger.error(f"Speaker designer failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Speaker designer failed: {exc}")


class SampleLineRequest(BaseModel):
    name: str = ""
    backstory: str = ""
    personality: str = ""


@router.post("/speaker-profiles/sample-line")
async def generate_sample_line(payload: SampleLineRequest):
    """Generate an in-character sample line + VoiceDesign prompt from a speaker's backstory & personality."""
    if not (payload.backstory.strip() or payload.personality.strip() or payload.name.strip()):
        raise HTTPException(
            status_code=400, detail="Provide at least a name, backstory, or personality."
        )

    system_prompt = (
        "You are a voice-acting dialogue writer for TTS voice cloning.\n"
        "Given a podcast character's name, backstory, and personality/speech style, write:\n"
        "1. `sample_text`: A punchy 2-3 sentence (~10-second spoken) in-character monologue written in the "
        "character's EXACT dialect, glottal stops, phonetic spellings, contractions, verbal tics, and attitude "
        "(e.g. dropped g's, regional respellings like \"cah\" for car, \"pahk\", \"fackin'\", \"wot\", \"wudder\", \"ain't\", catchphrases, pacing). "
        "NEVER use ALL CAPS for shouting or emphasis (e.g. never \"SHUT UP\" or \"KILLIN'\") because TTS reads all-caps letter-by-letter; use normal casing with exclamation marks instead. "
        "This text is spoken aloud by TTS to bake their voice clone, so it must sound unmistakably like them.\n"
        "2. `voicedesign_instruct`: A concise 1-sentence Qwen3-TTS VoiceDesign voice description "
        "(gender, approximate age, pitch, vocal texture like gravelly/nasal/raspy/warm, regional accent, and energy/pacing).\n\n"
        "Respond ONLY with valid JSON:\n"
        '{"sample_text": "...", "voicedesign_instruct": "..."}'
    )
    user_prompt = (
        f"Name: {payload.name.strip() or 'Unknown'}\n"
        f"Backstory: {payload.backstory.strip() or 'N/A'}\n"
        f"Personality & Speech Style: {payload.personality.strip() or 'N/A'}"
    )

    try:
        llm = await provision_langchain_model("", None, "chat", temperature=0.75, max_tokens=4096)
    except Exception:
        llm = await provision_langchain_model("", None, "transformation", temperature=0.75, max_tokens=4096)

    try:
        ai_resp = await llm.ainvoke([SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)])
        raw_text = ai_resp.content if isinstance(ai_resp.content, str) else str(ai_resp.content)
        try:
            data = _extract_json(raw_text, allow_fallback_question=False)
        except Exception:
            cleaned = re.sub(r"<think>[\s\S]*?</think>", "", raw_text).strip()
            st_match = re.search(r'"sample_text"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)', cleaned)
            vd_match = re.search(r'"voicedesign_instruct"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)', cleaned)
            if st_match:
                data = {
                    "sample_text": st_match.group(1).replace('\\"', '"').replace("\\n", " "),
                    "voicedesign_instruct": vd_match.group(1).replace('\\"', '"').replace("\\n", " ") if vd_match else "",
                }
            else:
                raise
        return {
            "sample_text": (data.get("sample_text") or "").strip(),
            "voicedesign_instruct": (data.get("voicedesign_instruct") or "").strip(),
        }
    except Exception as exc:
        logger.error(f"Sample line generation failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Sample line generation failed: {exc}")
