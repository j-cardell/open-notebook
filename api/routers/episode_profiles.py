import json
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from loguru import logger
from pydantic import BaseModel, Field

from open_notebook.ai.provision import provision_langchain_model
from open_notebook.exceptions import InvalidInputError, OpenNotebookError
from open_notebook.podcasts.models import EpisodeProfile, SpeakerProfile

router = APIRouter()


class EpisodeProfileResponse(BaseModel):
    id: str
    name: str
    description: str
    speaker_config: Optional[str] = Field(
        None, description="speaker_profile record ID (null when orphaned)"
    )
    speaker_config_name: Optional[str] = Field(
        None, description="Resolved speaker profile name (for display)"
    )
    outline_llm: Optional[str] = None
    transcript_llm: Optional[str] = None
    language: Optional[str] = None
    default_briefing: str
    num_segments: int
    max_tokens: Optional[int] = None


async def _speaker_names_by_id() -> Dict[str, str]:
    """Map speaker_profile record ID -> name for list serialization."""
    speakers = await SpeakerProfile.get_all()
    return {str(speaker.id): speaker.name for speaker in speakers}


async def _speaker_name_for(speaker_config: Optional[str]) -> Optional[str]:
    """Resolve one profile's speaker_config record ID to the speaker name.

    Returns None for a missing or dangling reference - the frontend renders
    that as "needs setup"."""
    if not speaker_config:
        return None
    speaker = await SpeakerProfile.resolve(speaker_config)
    return speaker.name if speaker else None


def _profile_to_response(
    profile: EpisodeProfile, speaker_name: Optional[str]
) -> EpisodeProfileResponse:
    return EpisodeProfileResponse(
        id=str(profile.id),
        name=profile.name,
        description=profile.description or "",
        speaker_config=profile.speaker_config,
        speaker_config_name=speaker_name,
        outline_llm=profile.outline_llm,
        transcript_llm=profile.transcript_llm,
        language=profile.language,
        default_briefing=profile.default_briefing,
        num_segments=profile.num_segments,
        max_tokens=profile.max_tokens,
    )


async def _resolve_speaker_config(value: str) -> SpeakerProfile:
    """Resolve an incoming speaker_config (record ID, or name for backward
    compatibility) to the referenced SpeakerProfile."""
    speaker = await SpeakerProfile.resolve(value)
    if not speaker:
        raise InvalidInputError(f"Speaker profile '{value}' not found")
    return speaker


@router.get("/episode-profiles", response_model=List[EpisodeProfileResponse])
async def list_episode_profiles():
    """List all available episode profiles"""
    try:
        profiles = await EpisodeProfile.get_all(order_by="name asc")
        speaker_names = await _speaker_names_by_id()
        return [
            _profile_to_response(
                p, speaker_names.get(p.speaker_config) if p.speaker_config else None
            )
            for p in profiles
        ]
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch episode profiles: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch episode profiles")


@router.get("/episode-profiles/{profile_name}", response_model=EpisodeProfileResponse)
async def get_episode_profile(profile_name: str):
    """Get a specific episode profile by name"""
    try:
        profile = await EpisodeProfile.get_by_name(profile_name)

        if not profile:
            raise HTTPException(
                status_code=404, detail=f"Episode profile '{profile_name}' not found"
            )

        return _profile_to_response(
            profile, await _speaker_name_for(profile.speaker_config)
        )

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch episode profile '{profile_name}': {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch episode profile")


class EpisodeProfileCreate(BaseModel):
    name: str = Field(..., description="Unique profile name")
    description: str = Field("", description="Profile description")
    speaker_config: str = Field(
        ...,
        description=(
            "speaker_profile record ID (a profile name is also accepted "
            "for backward compatibility)"
        ),
    )
    outline_llm: Optional[str] = Field(None, description="Model record ID for outline")
    transcript_llm: Optional[str] = Field(
        None, description="Model record ID for transcript"
    )
    language: Optional[str] = Field(None, description="Podcast language code")
    default_briefing: str = Field(..., description="Default briefing template")
    num_segments: int = Field(default=5, description="Number of podcast segments")
    max_tokens: Optional[int] = Field(
        None,
        description="Max output tokens for outline/transcript generation",
    )


@router.post("/episode-profiles", response_model=EpisodeProfileResponse)
async def create_episode_profile(profile_data: EpisodeProfileCreate):
    """Create a new episode profile"""
    try:
        speaker = await _resolve_speaker_config(profile_data.speaker_config)
        profile = EpisodeProfile(
            name=profile_data.name,
            description=profile_data.description,
            speaker_config=str(speaker.id),
            outline_llm=profile_data.outline_llm,
            transcript_llm=profile_data.transcript_llm,
            language=profile_data.language,
            default_briefing=profile_data.default_briefing,
            num_segments=profile_data.num_segments,
            max_tokens=profile_data.max_tokens,
        )

        await profile.save()
        return _profile_to_response(profile, speaker.name)

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to create episode profile: {e}")
        raise HTTPException(status_code=500, detail="Failed to create episode profile")


@router.put("/episode-profiles/{profile_id}", response_model=EpisodeProfileResponse)
async def update_episode_profile(profile_id: str, profile_data: EpisodeProfileCreate):
    """Update an existing episode profile"""
    try:
        profile = await EpisodeProfile.get(profile_id)

        if not profile:
            raise HTTPException(
                status_code=404, detail=f"Episode profile '{profile_id}' not found"
            )

        update_data = profile_data.model_dump(exclude_unset=True)
        speaker_name: Optional[str] = None
        if "speaker_config" in update_data:
            speaker = await _resolve_speaker_config(update_data["speaker_config"])
            update_data["speaker_config"] = str(speaker.id)
            speaker_name = speaker.name
        for field, value in update_data.items():
            setattr(profile, field, value)

        await profile.save()
        if speaker_name is None:
            speaker_name = await _speaker_name_for(profile.speaker_config)
        return _profile_to_response(profile, speaker_name)

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to update episode profile: {e}")
        raise HTTPException(status_code=500, detail="Failed to update episode profile")


@router.delete("/episode-profiles/{profile_id}")
async def delete_episode_profile(profile_id: str):
    """Delete an episode profile"""
    try:
        profile = await EpisodeProfile.get(profile_id)

        if not profile:
            raise HTTPException(
                status_code=404, detail=f"Episode profile '{profile_id}' not found"
            )

        await profile.delete()

        return {"message": "Episode profile deleted successfully"}

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to delete episode profile: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete episode profile")


@router.post(
    "/episode-profiles/{profile_id}/duplicate", response_model=EpisodeProfileResponse
)
async def duplicate_episode_profile(profile_id: str):
    """Duplicate an episode profile"""
    try:
        original = await EpisodeProfile.get(profile_id)

        if not original:
            raise HTTPException(
                status_code=404, detail=f"Episode profile '{profile_id}' not found"
            )

        duplicate = EpisodeProfile(
            name=f"{original.name} - Copy",
            description=original.description,
            speaker_config=original.speaker_config,
            outline_llm=original.outline_llm,
            transcript_llm=original.transcript_llm,
            language=original.language,
            default_briefing=original.default_briefing,
            num_segments=original.num_segments,
            max_tokens=original.max_tokens,
        )

        await duplicate.save()
        return _profile_to_response(
            duplicate, await _speaker_name_for(duplicate.speaker_config)
        )

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Failed to duplicate episode profile: {e}")
        raise HTTPException(
            status_code=500, detail="Failed to duplicate episode profile"
        )


class EpisodeDesignMessage(BaseModel):
    role: str
    content: str


class EpisodeDesignRequest(BaseModel):
    messages: List[EpisodeDesignMessage]
    finalize: bool = False


def _extract_episode_json(text: str, allow_fallback_question: bool = True) -> Dict[str, Any]:
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
    if fence:
        cleaned = fence.group(1).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(cleaned[start : end + 1])
            except Exception:
                pass
        if allow_fallback_question and cleaned:
            return {"status": "question", "reply": cleaned, "questions": None, "draft": None}
        raise


@router.post("/episode-profiles/design")
async def design_episode_profile(payload: EpisodeDesignRequest):
    """Interactive LLM assistant to design a podcast episode profile (format, briefing, segments, speaker pairing)."""
    speaker_summaries: List[str] = []
    try:
        speakers = await SpeakerProfile.get_all(order_by="name asc")
        for sp in speakers:
            cast = ", ".join(
                f"{s.get('name', '?')} ({s.get('voice_id', '?')})" for s in (sp.speakers or [])
            )
            speaker_summaries.append(f"{sp.id} | {sp.name} | {sp.description or ''} | cast: [{cast}]")
    except Exception as exc:
        logger.warning(f"Could not fetch speaker profiles for episode designer: {exc}")

    system_prompt = (
        "You are a creative podcast showrunner & episode format designer.\n"
        "Your job is to help the user design an Episode Profile (show name, description, segment count, "
        "and a rich `default_briefing` that guides the outline & transcript LLMs on tone, banter, pacing, and how hosts react to source material).\n\n"
        "IMPORTANT RULES:\n"
        "1. If the user's idea is brief or missing key details (and finalize=False), ask 1-3 short, focused follow-up questions using the `questions` array. "
        "Ask about things like:\n"
        "   - Show premise & vibe (e.g. two gangsters breaking down tech news, late-night diner roast, investigative deep dive)\n"
        "   - How hosts treat the source material (skeptical, hype, comedic,ELI5, storytelling, rapid-fire)\n"
        "   - Pacing, segment count (3-20), and recurring bits/catchphrases or intro/outro style\n"
        "2. When you have enough detail (or when finalize=True), return `status: 'ready'` with `draft`.\n"
        "3. Write `default_briefing` as a vivid, actionable director's brief for the podcast scriptwriter: "
        "specify tone, banter rules, how to weave in the speakers' dialects/personalities, segment flow, and opening/closing style.\n"
        "4. Pick `suggested_speaker_profile_id` as an EXACT `id` from the Available Speaker Profiles below (or null if none fit).\n\n"
        "Available Speaker Profiles (id | name | description | cast):\n"
        + ("\n".join(speaker_summaries) if speaker_summaries else "(none)")
        + "\n\nRespond ONLY with valid JSON matching this exact schema:\n"
        "{\n"
        '  "status": "question" | "ready",\n'
        '  "reply": "Short 1-2 sentence conversational reaction (plain text, no markdown asterisks)",\n'
        '  "questions": null | [\n'
        '    {"id": "q1", "label": "Short 2-4 word label", "prompt": "Clear question for the user", "placeholder": "e.g. example answer"}\n'
        "  ],\n"
        '  "draft": null | {\n'
        '    "name": "Episode Profile Name",\n'
        '    "description": "1-2 sentence summary of this episode format",\n'
        '    "num_segments": 5,\n'
        '    "suggested_speaker_profile_id": "exact speaker_profile id or null",\n'
        '    "default_briefing": "Detailed showrunner briefing for outline & transcript generation"\n'
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
        return _extract_episode_json(raw_text, allow_fallback_question=not payload.finalize)
    except Exception as exc:
        logger.error(f"Episode designer failed: {exc}")
        raise HTTPException(status_code=500, detail=f"Episode designer failed: {exc}")
