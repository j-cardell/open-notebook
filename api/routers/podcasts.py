import shutil
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from loguru import logger
from pydantic import BaseModel
from surreal_commands import submit_command

from api.podcast_service import (
    PodcastGenerationRequest,
    PodcastGenerationResponse,
    PodcastService,
)
from open_notebook.ai.models import Model
from open_notebook.database.repository import ensure_record_id, repo_query
from open_notebook.exceptions import OpenNotebookError
from open_notebook.podcasts.audio_paths import podcasts_root, resolve_contained_audio_path
from open_notebook.podcasts.models import PodcastEpisode

router = APIRouter()

# Model reference fields stored in the denormalized profile snapshots on an
# episode, mapped to the resolved display fields the frontend renders
# ("provider / name" rows in EpisodeCard). Mirrors the speaker_config ->
# speaker_config_name precedent in api/routers/episode_profiles.py.
_EPISODE_PROFILE_MODEL_FIELDS = {
    "outline_llm": ("outline_model_provider", "outline_model_name"),
    "transcript_llm": ("transcript_model_provider", "transcript_model_name"),
}
_SPEAKER_PROFILE_MODEL_FIELDS = {
    "voice_model": ("voice_model_provider", "voice_model_name"),
}


def _collect_snapshot_model_ids(episodes: List[PodcastEpisode]) -> List[str]:
    """Collect the distinct model record IDs referenced by episode snapshots."""
    ids = set()
    for episode in episodes:
        for field in _EPISODE_PROFILE_MODEL_FIELDS:
            ref = (episode.episode_profile or {}).get(field)
            if ref:
                ids.add(str(ref))
        for field in _SPEAKER_PROFILE_MODEL_FIELDS:
            ref = (episode.speaker_profile or {}).get(field)
            if ref:
                ids.add(str(ref))
    return sorted(ids)


def _with_resolved_model_fields(
    snapshot: dict,
    field_map: dict,
    models_by_id: dict,
) -> dict:
    """Return a copy of a profile snapshot with resolved model display fields.

    Only sets the display fields when the reference resolves; unresolvable
    references (deleted model) and legacy snapshots without references are
    left untouched so the frontend can fall back to the historical
    provider/model strings, then to a placeholder.
    """
    enriched = dict(snapshot or {})
    for ref_field, (provider_field, name_field) in field_map.items():
        ref = enriched.get(ref_field)
        info = models_by_id.get(str(ref)) if ref else None
        if info:
            enriched[provider_field] = info["provider"]
            enriched[name_field] = info["name"]
    return enriched


async def _resolve_snapshot_models(
    episodes: List[PodcastEpisode],
) -> dict:
    """Batch-resolve every model reference in the episodes' snapshots.

    One query for the whole list (see Model.get_display_info_for_ids) - a
    failure degrades to no resolved fields rather than failing the request.
    """
    try:
        return await Model.get_display_info_for_ids(
            _collect_snapshot_model_ids(episodes)
        )
    except Exception as e:
        logger.warning(f"Error batch-resolving snapshot model references: {str(e)}")
        return {}


def _delete_episode_audio(episode: PodcastEpisode, episode_id: str) -> None:
    """Best-effort cleanup of an episode's directory/audio files, refusing invalid paths.

    Shared by the delete and retry endpoints. Removes the entire
    ``episodes/<uuid>`` directory (main MP3, loose ``clips/``, JSON files)
    when contained under ``podcasts_root()/episodes``; otherwise unlinks
    only the main audio file.
    """
    episodes_root = podcasts_root() / "episodes"
    removed_dirs: set[Path] = set()

    if episode.audio_file:
        audio_path = resolve_contained_audio_path(episode.audio_file)
        if audio_path is None:
            logger.warning(
                f"Refusing to delete audio file outside podcasts directory "
                f"for episode {episode_id}: {episode.audio_file}"
            )
        else:
            ep_dir = audio_path.parent.parent
            if ep_dir.parent == episodes_root and ep_dir.is_dir():
                try:
                    shutil.rmtree(ep_dir)
                    removed_dirs.add(ep_dir)
                    logger.info(f"Deleted episode directory: {ep_dir}")
                except Exception as e:
                    logger.warning(f"Failed to delete episode directory {ep_dir}: {e}")
            elif audio_path.exists():
                try:
                    audio_path.unlink()
                    logger.info(f"Deleted audio file: {audio_path}")
                except Exception as e:
                    logger.warning(f"Failed to delete audio file {audio_path}: {e}")

    clips_dir = (episode.progress or {}).get("clips_dir")
    if clips_dir:
        try:
            ep_dir = Path(clips_dir).resolve().parent
            if ep_dir.parent == episodes_root and ep_dir.is_dir() and ep_dir not in removed_dirs:
                shutil.rmtree(ep_dir)
                logger.info(f"Deleted failed/in-progress episode directory: {ep_dir}")
        except Exception as e:
            logger.warning(f"Failed to delete clips directory for {episode_id}: {e}")


def _episode_has_clips(episode: PodcastEpisode) -> bool:
    if not episode.audio_file:
        return False
    audio_path = resolve_contained_audio_path(episode.audio_file)
    if audio_path is None:
        return False
    clips_dir = audio_path.parent.parent / "clips"
    return clips_dir.is_dir() and any(clips_dir.glob("*.mp3"))


class PodcastEpisodeResponse(BaseModel):
    id: str
    name: str
    episode_profile: dict
    speaker_profile: dict
    briefing: str
    audio_file: Optional[str] = None
    audio_url: Optional[str] = None
    transcript: Optional[dict] = None
    outline: Optional[dict] = None
    created: Optional[str] = None
    job_status: Optional[str] = None
    error_message: Optional[str] = None
    progress: Optional[dict] = None
    has_clips: bool = False


def _resolve_episode_progress(episode: PodcastEpisode, job_status: Optional[str]) -> Optional[dict]:
    if job_status not in ("running", "processing", "submitted", "queued"):
        return None
    if not episode.progress:
        return None
    prog = dict(episode.progress)
    clips_dir = prog.pop("clips_dir", None)
    if prog.get("stage") == "audio" and clips_dir:
        try:
            p = Path(clips_dir)
            if p.is_dir():
                completed_indices = sorted(
                    int(f.stem) for f in p.glob("*.mp3") if f.stem.isdigit()
                )
                total = prog.get("total_clips")
                prog["completed_clips"] = (
                    min(len(completed_indices), total) if total else len(completed_indices)
                )
                prog["completed_clip_indices"] = completed_indices
        except Exception:
            pass
    return prog


@router.post("/podcasts/generate", response_model=PodcastGenerationResponse)
async def generate_podcast(request: PodcastGenerationRequest):
    """
    Generate a podcast episode using Episode Profiles.
    Returns immediately with job ID for status tracking.
    """
    try:
        job_id = await PodcastService.submit_generation_job(
            episode_profile_name=request.episode_profile,
            speaker_profile_name=request.speaker_profile,
            episode_name=request.episode_name,
            notebook_id=request.notebook_id,
            content=request.content,
            briefing_suffix=request.briefing_suffix,
        )

        return PodcastGenerationResponse(
            job_id=job_id,
            status="submitted",
            message=f"Podcast generation started for episode '{request.episode_name}'",
            episode_profile=request.episode_profile,
            episode_name=request.episode_name,
        )

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error generating podcast: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to generate podcast")


@router.get("/podcasts/jobs/{job_id}")
async def get_podcast_job_status(job_id: str):
    """Get the status of a podcast generation job"""
    try:
        status_data = await PodcastService.get_job_status(job_id)
        return status_data

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching podcast job status: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch job status")


@router.get("/podcasts/episodes", response_model=List[PodcastEpisodeResponse])
async def list_podcast_episodes():
    """List all podcast episodes"""
    try:
        episodes = await PodcastService.list_episodes()

        # Batch-fetch job status for every episode with a command in one
        # query instead of one round trip per episode (see
        # PodcastEpisode.get_job_details_for_commands docstring).
        try:
            details_by_command = await PodcastEpisode.get_job_details_for_commands(
                [episode.command for episode in episodes if episode.command]
            )
        except Exception as e:
            logger.warning(f"Error batch-fetching podcast job statuses: {str(e)}")
            details_by_command = {}

        # Batch-resolve the snapshots' model references (outline_llm,
        # transcript_llm, voice_model) to display fields in one query
        # instead of one lookup per episode.
        models_by_id = await _resolve_snapshot_models(episodes)

        response_episodes = []
        for episode in episodes:
            # Skip incomplete episodes without command or audio
            if not episode.command and not episode.audio_file:
                continue

            # Get job status and error message if available
            job_status = None
            error_message = None
            if episode.command:
                detail = details_by_command.get(str(episode.command))
                if detail is not None:
                    job_status = detail["status"]
                    error_message = detail["error_message"]
                else:
                    job_status = "unknown"
            else:
                # No command but has audio file = completed import
                job_status = "completed"

            audio_url = None
            audio_path = resolve_contained_audio_path(episode.audio_file)
            if audio_path is not None and audio_path.exists():
                audio_url = f"/api/podcasts/episodes/{episode.id}/audio"

            response_episodes.append(
                PodcastEpisodeResponse(
                    id=str(episode.id),
                    name=episode.name,
                    episode_profile=_with_resolved_model_fields(
                        episode.episode_profile,
                        _EPISODE_PROFILE_MODEL_FIELDS,
                        models_by_id,
                    ),
                    speaker_profile=_with_resolved_model_fields(
                        episode.speaker_profile,
                        _SPEAKER_PROFILE_MODEL_FIELDS,
                        models_by_id,
                    ),
                    briefing=episode.briefing,
                    audio_file=episode.audio_file,
                    audio_url=audio_url,
                    transcript=episode.transcript,
                    outline=episode.outline,
                    created=str(episode.created) if episode.created else None,
                    job_status=job_status,
                    error_message=error_message,
                    progress=_resolve_episode_progress(episode, job_status),
                    has_clips=_episode_has_clips(episode),
                )
            )

        return response_episodes

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error listing podcast episodes: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to list podcast episodes")


@router.get("/podcasts/episodes/{episode_id}", response_model=PodcastEpisodeResponse)
async def get_podcast_episode(episode_id: str):
    """Get a specific podcast episode"""
    try:
        episode = await PodcastService.get_episode(episode_id)

        # Get job status and error message if available
        job_status = None
        error_message = None
        if episode.command:
            try:
                detail = await episode.get_job_detail()
                job_status = detail["status"]
                error_message = detail["error_message"]
            except Exception:
                job_status = "unknown"
        else:
            # No command but has audio file = completed import
            job_status = "completed" if episode.audio_file else "unknown"

        audio_url = None
        audio_path = resolve_contained_audio_path(episode.audio_file)
        if audio_path is not None and audio_path.exists():
            audio_url = f"/api/podcasts/episodes/{episode.id}/audio"

        models_by_id = await _resolve_snapshot_models([episode])

        return PodcastEpisodeResponse(
            id=str(episode.id),
            name=episode.name,
            episode_profile=_with_resolved_model_fields(
                episode.episode_profile,
                _EPISODE_PROFILE_MODEL_FIELDS,
                models_by_id,
            ),
            speaker_profile=_with_resolved_model_fields(
                episode.speaker_profile,
                _SPEAKER_PROFILE_MODEL_FIELDS,
                models_by_id,
            ),
            briefing=episode.briefing,
            audio_file=episode.audio_file,
            audio_url=audio_url,
            transcript=episode.transcript,
            outline=episode.outline,
            created=str(episode.created) if episode.created else None,
            job_status=job_status,
            error_message=error_message,
            progress=_resolve_episode_progress(episode, job_status),
            has_clips=_episode_has_clips(episode),
        )

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching podcast episode: {str(e)}")
        raise HTTPException(status_code=404, detail="Episode not found")


@router.get("/podcasts/episodes/{episode_id}/audio")
async def stream_podcast_episode_audio(episode_id: str):
    """Stream the audio file associated with a podcast episode"""
    try:
        episode = await PodcastService.get_episode(episode_id)
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error fetching podcast episode for audio: {str(e)}")
        raise HTTPException(status_code=404, detail="Episode not found")

    if not episode.audio_file:
        raise HTTPException(status_code=404, detail="Episode has no audio file")

    audio_path = resolve_contained_audio_path(episode.audio_file)
    if audio_path is None:
        logger.warning(
            f"Blocked audio access outside podcasts directory for episode "
            f"{episode_id}: {episode.audio_file}"
        )
        raise HTTPException(status_code=403, detail="Access to file denied")

    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    return FileResponse(
        audio_path,
        media_type="audio/mpeg",
        filename=audio_path.name,
    )


@router.post("/podcasts/episodes/{episode_id}/retry")
async def retry_podcast_episode(episode_id: str):
    """Retry a failed podcast episode by deleting it and submitting a new job"""
    try:
        episode = await PodcastService.get_episode(episode_id)

        # Validate episode is in a failed state
        detail = await episode.get_job_detail()
        if detail["status"] not in ("failed", "error"):
            raise HTTPException(
                status_code=400,
                detail=f"Episode is not in a failed state (current: {detail['status']})",
            )

        # Extract params for re-submission
        ep_profile_name = episode.episode_profile.get("name")
        sp_profile_name = episode.speaker_profile.get("name")
        episode_name = episode.name
        content = episode.content

        if not ep_profile_name or not sp_profile_name:
            raise HTTPException(
                status_code=400,
                detail="Cannot retry: episode or speaker profile name missing from stored data",
            )

        # Delete audio file if any
        _delete_episode_audio(episode, episode_id)

        # Delete the failed episode
        await episode.delete()

        # Submit a new job
        job_id = await PodcastService.submit_generation_job(
            episode_profile_name=ep_profile_name,
            speaker_profile_name=sp_profile_name,
            episode_name=episode_name,
            content=content,
        )

        return {"job_id": job_id, "message": "Retry submitted successfully"}

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error retrying podcast episode: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retry episode")


class TranscriptEntryPayload(BaseModel):
    speaker: str
    dialogue: str
    speed: Optional[float] = None


class UpdateTranscriptRequest(BaseModel):
    transcript: List[TranscriptEntryPayload]


class RerunClipRequest(BaseModel):
    speaker: Optional[str] = None
    dialogue: Optional[str] = None
    speed: Optional[float] = None


@router.patch("/podcasts/episodes/{episode_id}/transcript")
async def update_podcast_episode_transcript(
    episode_id: str,
    payload: UpdateTranscriptRequest,
):
    """Save edits to an episode's transcript."""
    try:
        episode = await PodcastService.get_episode(episode_id)
        cleaned = []
        for entry in payload.transcript:
            if entry.speaker.strip() and entry.dialogue.strip():
                item: dict = {"speaker": entry.speaker.strip(), "dialogue": entry.dialogue.strip()}
                if entry.speed is not None:
                    item["speed"] = round(max(0.5, min(2.0, float(entry.speed))), 2)
                cleaned.append(item)
        if not cleaned:
            raise HTTPException(
                status_code=400,
                detail="Transcript must contain at least one non-empty line",
            )
        episode.transcript = {"transcript": cleaned}
        await episode.save()
        return {"episode_id": str(episode.id), "transcript": episode.transcript}
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error updating episode transcript: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update transcript")


@router.post("/podcasts/episodes/{episode_id}/rerun-tts")
async def rerun_podcast_episode_tts(episode_id: str):
    """Regenerate episode audio from its saved transcript."""
    try:
        episode = await PodcastService.get_episode(episode_id)
        entries = (episode.transcript or {}).get("transcript") or []
        if not entries:
            raise HTTPException(
                status_code=400,
                detail="Episode has no transcript to synthesize",
            )
        import commands.podcast_commands  # noqa: F401

        job_id = submit_command(
            "open_notebook",
            "rerun_podcast_tts",
            {"episode_id": str(episode.id)},
        )
        if not job_id:
            raise HTTPException(status_code=500, detail="Failed to submit TTS rerun job")
        episode.command = ensure_record_id(str(job_id))
        await episode.save()
        return {
            "job_id": str(job_id),
            "status": "submitted",
            "message": "TTS regeneration started",
        }
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error rerunning episode TTS: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to rerun TTS")


class ShutdownRequest(BaseModel):
    mode: str = "all"


@router.post("/podcasts/system/shutdown")
async def shutdown_system_containers(payload: ShutdownRequest):
    """Stop GPU model services (and optionally the Open Notebook compose stack) via host arbiter."""
    import asyncio
    import urllib.request

    endpoint = "/_arbiter/stop-gpu" if payload.mode == "gpu" else "/_arbiter/stop-all"
    url = f"http://host.docker.internal:8086{endpoint}"

    def _post() -> bytes:
        req = urllib.request.Request(url, data=b"{}", method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read()

    try:
        await asyncio.to_thread(_post)
        return {"ok": True, "mode": "gpu" if payload.mode == "gpu" else "all"}
    except Exception as e:
        logger.error(f"Failed to stop containers via arbiter: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to contact host arbiter: {e}")


@router.delete("/podcasts/episodes/{episode_id}/clips")
async def cleanup_podcast_episode_clips(episode_id: str):
    """Delete loose per-block clip MP3s while keeping the main episode audio."""
    episode = await PodcastService.get_episode(episode_id)
    if not episode.audio_file:
        raise HTTPException(status_code=404, detail="Episode has no audio file")
    audio_path = resolve_contained_audio_path(episode.audio_file)
    if audio_path is None:
        raise HTTPException(status_code=403, detail="Access to file denied")
    clips_dir = audio_path.parent.parent / "clips"
    deleted_files = 0
    freed_bytes = 0
    if clips_dir.is_dir():
        for f in clips_dir.iterdir():
            if f.is_file():
                deleted_files += 1
                freed_bytes += f.stat().st_size
        shutil.rmtree(clips_dir)
        logger.info(
            f"Cleaned up {deleted_files} clip files ({freed_bytes} bytes) for {episode_id}"
        )
    return {
        "episode_id": str(episode.id),
        "deleted_files": deleted_files,
        "freed_bytes": freed_bytes,
    }


@router.get("/podcasts/episodes/{episode_id}/clips/{clip_index}")
async def stream_podcast_episode_clip(episode_id: str, clip_index: int):
    """Stream an individual dialogue clip MP3 for an episode."""
    if clip_index < 0:
        raise HTTPException(status_code=400, detail="Invalid clip index")
    episode = await PodcastService.get_episode(episode_id)
    clip_path: Optional[Path] = None

    clips_dir = (episode.progress or {}).get("clips_dir")
    if clips_dir:
        resolved_clips_dir = Path(clips_dir).resolve()
        root = podcasts_root()
        if not resolved_clips_dir.is_relative_to(root):
            raise HTTPException(status_code=403, detail="Access to file denied")
        candidate = resolved_clips_dir / f"{clip_index:04d}.mp3"
        if candidate.exists():
            clip_path = candidate

    if clip_path is None:
        if not episode.audio_file:
            raise HTTPException(status_code=404, detail="Clip file not found")
        audio_path = resolve_contained_audio_path(episode.audio_file)
        if audio_path is None:
            raise HTTPException(status_code=403, detail="Access to file denied")
        clip_path = audio_path.parent.parent / "clips" / f"{clip_index:04d}.mp3"
        if not clip_path.exists():
            raise HTTPException(status_code=404, detail="Clip file not found")

    return FileResponse(
        clip_path,
        media_type="audio/mpeg",
        filename=clip_path.name,
        headers={"Cache-Control": "no-store"},
    )


@router.post("/podcasts/episodes/{episode_id}/clips/{clip_index}/rerun")
async def rerun_podcast_episode_clip(
    episode_id: str,
    clip_index: int,
    payload: RerunClipRequest,
):
    """Regenerate a single transcript block's TTS clip and re-mux the episode MP3."""
    try:
        from esperanto import AIFactory
        from podcast_creator.core import combine_audio_files
        from open_notebook.podcasts.models import _resolve_model_config

        episode = await PodcastService.get_episode(episode_id)
        entries = list((episode.transcript or {}).get("transcript") or [])
        if clip_index < 0 or clip_index >= len(entries):
            raise HTTPException(status_code=404, detail="Transcript block not found")
        if not episode.audio_file:
            raise HTTPException(status_code=400, detail="Episode has no audio file to re-mux")

        audio_path = resolve_contained_audio_path(episode.audio_file)
        if audio_path is None:
            raise HTTPException(status_code=403, detail="Access to file denied")

        audio_dir = audio_path.parent
        clips_dir = audio_dir.parent / "clips"
        clips_dir.mkdir(parents=True, exist_ok=True)
        clip_path = clips_dir / f"{clip_index:04d}.mp3"

        entry = dict(entries[clip_index])
        if payload.speaker is not None and payload.speaker.strip():
            entry["speaker"] = payload.speaker.strip()
        if payload.dialogue is not None and payload.dialogue.strip():
            entry["dialogue"] = payload.dialogue.strip()
        if payload.speed is not None:
            entry["speed"] = round(max(0.5, min(2.0, float(payload.speed))), 2)
        entries[clip_index] = entry
        episode.transcript = {"transcript": entries}
        await episode.save()

        sp_dict = dict(episode.speaker_profile or {})
        tts_provider = sp_dict.get("tts_provider")
        tts_model_name = sp_dict.get("tts_model")
        tts_config = dict(sp_dict.get("tts_config") or {})
        if sp_dict.get("voice_model"):
            tts_provider, tts_model_name, tts_config = await _resolve_model_config(
                str(sp_dict["voice_model"])
            )

        voice_id = None
        for sp in sp_dict.get("speakers", []):
            if sp.get("name") == entry["speaker"]:
                voice_id = sp.get("voice_id")
                if sp.get("voice_model"):
                    tts_provider, tts_model_name, tts_config = await _resolve_model_config(
                        str(sp["voice_model"])
                    )
                break
        if not voice_id:
            raise HTTPException(
                status_code=400,
                detail=f"Speaker '{entry['speaker']}' not found in episode speaker profile",
            )

        cfg = dict(tts_config or {})
        api_key = cfg.pop("api_key", None)
        base_url = cfg.pop("base_url", None)
        tts_model = AIFactory.create_text_to_speech(
            tts_provider, tts_model_name, api_key=api_key, base_url=base_url, **cfg
        )

        speech_kwargs: dict = {}
        if entry.get("speed") is not None:
            speech_kwargs["speed"] = float(entry["speed"])
        await tts_model.agenerate_speech(
            text=entry["dialogue"],
            voice=voice_id,
            output_file=clip_path,
            **speech_kwargs,
        )

        await combine_audio_files(clips_dir, audio_path.name, audio_dir)
        return {
            "episode_id": str(episode.id),
            "clip_index": clip_index,
            "entry": entry,
        }
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error rerunning clip {clip_index} for {episode_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to rerun block TTS: {e}")


@router.post("/podcasts/episodes/{episode_id}/cancel")
async def cancel_podcast_episode(episode_id: str):
    """Stop an in-progress podcast generation or TTS rerun job."""
    try:
        episode = await PodcastService.get_episode(episode_id)
        if not episode.command:
            return {"episode_id": str(episode.id), "cancelled": False}
        await repo_query(
            "UPDATE $cmd SET status = 'failed', error_message = 'Stopped by user'",
            {"cmd": ensure_record_id(episode.command)},
        )
        return {"episode_id": str(episode.id), "cancelled": True}
    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error cancelling episode job: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to stop generation")


@router.delete("/podcasts/episodes/{episode_id}")
async def delete_podcast_episode(episode_id: str):
    """Delete a podcast episode and its associated audio file"""
    try:
        # Get the episode first to check if it exists and get the audio file path
        episode = await PodcastService.get_episode(episode_id)

        # Delete the physical audio file if it exists
        _delete_episode_audio(episode, episode_id)

        # Delete the episode from the database
        await episode.delete()

        logger.info(f"Deleted podcast episode: {episode_id}")
        return {"message": "Episode deleted successfully", "episode_id": episode_id}

    except HTTPException:
        raise
    except OpenNotebookError:
        raise
    except Exception as e:
        logger.error(f"Error deleting podcast episode: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to delete episode")
