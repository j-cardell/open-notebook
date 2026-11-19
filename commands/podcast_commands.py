import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from loguru import logger
from surreal_commands import CommandInput, CommandOutput, command

from open_notebook.ai.models import DefaultModels
from open_notebook.config import PODCASTS_FOLDER
from open_notebook.database.repository import ensure_record_id, repo_query
from open_notebook.podcasts.audio_paths import to_relative_audio_path
from open_notebook.podcasts.models import (
    EpisodeProfile,
    PodcastEpisode,
    SpeakerProfile,
    _resolve_model_config,
)
from open_notebook.utils.model_utils import full_model_dump

try:
    from podcast_creator import Dialogue, PodcastState, SpeakerProfile as PCSpeakerProfile, configure, create_podcast
    from podcast_creator.nodes import combine_audio_node, generate_single_audio_clip
except ImportError as e:
    logger.error(f"Failed to import podcast_creator: {e}")
    raise ValueError("podcast_creator library not available")


def build_episode_output_dir(
    podcasts_folder: str = PODCASTS_FOLDER,
) -> tuple[str, Path]:
    """Build a filesystem-safe output directory path for a podcast episode.

    Uses a UUID as the directory name so the path is safe regardless of
    what the user typed as episode name (spaces, special chars, etc.).

    Builds under PODCASTS_FOLDER — the same root to_relative_audio_path()
    validates against at write time (#1030) — so the two can't drift apart.

    Returns:
        A tuple of (episode_dir_name, output_dir_path).
    """
    episode_dir_name = str(uuid.uuid4())
    output_dir = Path(podcasts_folder) / "episodes" / episode_dir_name
    return episode_dir_name, output_dir


def explain_generation_failure(error_msg: str) -> Optional[str]:
    """Map a podcast-generation failure to an actionable hint, or None.

    Ordered most specific first. The GPT-5 extended-thinking hint used to be
    the only one, so the two most common real failures got either nothing
    (`Invalid speaker name`) or advice about the wrong provider - a truncated
    Gemini response was told to switch to gpt-4o (#1238).
    """
    if "Invalid speaker name" in error_msg:
        return (
            "The transcript model returned a speaker name that is not in the "
            "speaker profile - usually a placeholder copied from the prompt "
            'such as "..." rather than an invented person. Speaker names must '
            "match the profile exactly. Retrying the episode often succeeds, "
            "since each attempt is a fresh sample."
        )

    if "Voice name" in error_msg and "not supported" in error_msg:
        return (
            "The speaker profile's voice_id is not valid for its TTS model. "
            "Check the speaker profile voices in Podcasts -> Profiles against the ones "
            "your voice model provides (the profiles seeded on install use "
            "OpenAI voice names)."
        )

    if "Requested entity was not found" in error_msg:
        return (
            "Google returns this for any resource it cannot find, without "
            "naming which one. Two candidates, likeliest first: a speaker "
            "profile voice_id that its TTS model doesn't provide (the profiles "
            "seeded on install use OpenAI voice names, which Gemini voice "
            "models reject with exactly this message), or a model id in the "
            "episode profile that doesn't exist for its provider. If the "
            "transcript finished and the failure came during audio, it is the "
            "voice."
        )

    if "Invalid json output" in error_msg or "Expecting value" in error_msg:
        return (
            "The model's response could not be parsed as JSON. Two common "
            "causes: (1) the response was truncated - podcast-creator requests "
            "up to 8192 output tokens per outline or transcript step unless the "
            "episode profile sets max_tokens; if the model stops earlier (a "
            "lower output limit, or a token-expensive language), set max_tokens "
            "to its limit or use fewer and shorter segments; (2) a model using "
            "extended thinking (e.g. "
            "GPT-5) put all of its output inside <think> tags, leaving nothing "
            "to parse - try gpt-4o, gpt-4o-mini or gpt-4-turbo instead."
        )

    return None


def pick_voice_model(
    profile_name: str,
    profile_voice_model: Optional[str],
    default_voice_model: Optional[str],
) -> str:
    """
    Pick the TTS model for a speaker profile.

    The profile's own voice model wins. Without one, the Default
    Text-to-Speech Model from Manage -> Models is used. Raises
    ValueError (a permanent failure, no retry) when neither is set.
    """

    if profile_voice_model:
        return str(profile_voice_model)

    if default_voice_model:
        return str(default_voice_model)

    raise ValueError(
        f"Speaker profile '{profile_name}' has no voice model configured and no "
        "default Text-to-Speech model is set. Select a voice model in the speaker "
        "profile, or set a default Text-to-Speech model in Manage -> Models."
    )


class PodcastGenerationInput(CommandInput):
    episode_profile: str
    # Speaker profile record ID or name (the API boundary resolves the
    # user-facing name to a record ID before submitting; both are accepted
    # here for robustness).
    speaker_profile: Optional[str] = None
    episode_name: str
    content: str
    briefing_suffix: Optional[str] = None


class PodcastGenerationOutput(CommandOutput):
    success: bool
    episode_id: Optional[str] = None
    audio_file_path: Optional[str] = None
    transcript: Optional[dict] = None
    outline: Optional[dict] = None
    processing_time: float
    error_message: Optional[str] = None


@command("generate_podcast", app="open_notebook", retry={"max_attempts": 1})
async def generate_podcast_command(
    input_data: PodcastGenerationInput,
) -> PodcastGenerationOutput:
    """
    Real podcast generation using podcast-creator library with Episode Profiles
    """
    start_time = time.time()

    try:
        logger.info(
            f"Starting podcast generation for episode: {input_data.episode_name}"
        )
        logger.info(f"Using episode profile: {input_data.episode_profile}")

        # 1. Load Episode and Speaker profiles from SurrealDB
        episode_profile = await EpisodeProfile.get_by_name(input_data.episode_profile)
        if not episode_profile:
            raise ValueError(
                f"Episode profile '{input_data.episode_profile}' not found"
            )

        # Honor the explicitly requested speaker profile when provided,
        # falling back to the episode profile's configured speaker
        # (a speaker_profile record ID since migration 20, None when the
        # referenced profile no longer exists).
        speaker_ref = input_data.speaker_profile or episode_profile.speaker_config
        if not speaker_ref:
            raise ValueError(
                f"Episode profile '{episode_profile.name}' has no speaker "
                "profile configured. Please update the profile to select a "
                "speaker profile."
            )
        speaker_profile = await SpeakerProfile.resolve(speaker_ref)
        if not speaker_profile:
            if input_data.speaker_profile:
                raise ValueError(f"Speaker profile '{speaker_ref}' not found")
            raise ValueError(
                f"Episode profile '{episode_profile.name}' references a "
                "speaker profile that no longer exists. Please update the "
                "profile to select a speaker profile."
            )

        logger.info(f"Loaded episode profile: {episode_profile.name}")
        logger.info(f"Loaded speaker profile: {speaker_profile.name}")

        # Create the episode before anything below can fail, so a failure
        # (missing or unresolvable model, provider error) shows up as a
        # failed episode in the list instead of nothing at all (#1400).
        briefing = episode_profile.default_briefing
        if input_data.briefing_suffix:
            briefing += f"\n\nAdditional instructions: {input_data.briefing_suffix}"

        episode = PodcastEpisode(
            name=input_data.episode_name,
            episode_profile=full_model_dump(episode_profile.model_dump()),
            speaker_profile=full_model_dump(speaker_profile.model_dump()),
            command=ensure_record_id(input_data.execution_context.command_id)
            if input_data.execution_context
            else None,
            briefing=briefing,
            content=input_data.content,
            audio_file=None,
            transcript=None,
            outline=None,
        )
        await episode.save()

        # 2. Validate that model registry fields are populated
        if not episode_profile.outline_llm:
            raise ValueError(
                f"Episode profile '{episode_profile.name}' has no outline model configured. "
                "Please update the profile to select an outline model."
            )
        if not episode_profile.transcript_llm:
            raise ValueError(
                f"Episode profile '{episode_profile.name}' has no transcript model configured. "
                "Please update the profile to select a transcript model."
            )

        # The selected profile's own voice model wins; without one, fall back
        # to the Default Text-to-Speech Model.
        defaults = await DefaultModels.get_instance()
        default_tts_model = defaults.default_text_to_speech_model
        voice_model_id = pick_voice_model(
            speaker_profile.name, speaker_profile.voice_model, default_tts_model
        )

        # 3. Resolve model configs with credentials
        (
            outline_provider,
            outline_model_name,
            outline_config,
        ) = await episode_profile.resolve_outline_config()
        (
            transcript_provider,
            transcript_model_name,
            transcript_config,
        ) = await episode_profile.resolve_transcript_config()
        (
            tts_provider,
            tts_model_name,
            tts_config,
        ) = await _resolve_model_config(voice_model_id)

        logger.info(
            f"Resolved models - outline: {outline_provider}/{outline_model_name}, "
            f"transcript: {transcript_provider}/{transcript_model_name}, "
            f"tts: {tts_provider}/{tts_model_name}"
        )

        # 4. Load all profiles and configure podcast-creator
        episode_profiles = await repo_query("SELECT * FROM episode_profile")
        speaker_profiles = await repo_query("SELECT * FROM speaker_profile")

        # Transform the surrealdb array into a dictionary for podcast-creator
        episode_profiles_dict = {
            profile["name"]: profile for profile in episode_profiles
        }
        speaker_profiles_dict = {
            profile["name"]: profile for profile in speaker_profiles
        }

        # Map speaker_profile record ID -> name so podcast-creator keeps
        # receiving speaker names (its EpisodeProfile.speaker_config is a
        # required non-empty name string, cross-referenced against the
        # speakers config keyed by name).
        speaker_name_by_id = {
            str(profile["id"]): profile["name"] for profile in speaker_profiles
        }

        # 5. Inject resolved model configs into profile dicts
        # Resolve ALL episode profiles (podcast-creator validates all).
        # Remove profiles that fail resolution to prevent validation errors.
        for ep_name in list(episode_profiles_dict.keys()):
            ep_dict = episode_profiles_dict[ep_name]

            # Since migration 20, speaker_config stores a record ID (and is
            # None when the referenced speaker profile no longer exists).
            # Rewrite it back to the speaker name for podcast-creator; drop
            # profiles whose reference doesn't resolve so a single orphaned
            # profile can't fail validation for the whole config. The profile
            # being generated always resolves: its speaker was validated above.
            speaker_ref = ep_dict.get("speaker_config")
            speaker_name = (
                speaker_name_by_id.get(str(speaker_ref)) if speaker_ref else None
            )
            if not speaker_name and ep_name == episode_profile.name:
                speaker_name = speaker_profile.name
            if not speaker_name:
                logger.warning(
                    f"Episode profile '{ep_name}' references a speaker profile "
                    f"that no longer exists ({speaker_ref!r}), removing from "
                    "config to prevent validation errors"
                )
                del episode_profiles_dict[ep_name]
                continue
            ep_dict["speaker_config"] = speaker_name

            try:
                if ep_dict.get("outline_llm"):
                    prov, model, conf = await _resolve_model_config(
                        str(ep_dict["outline_llm"]),
                        max_tokens=ep_dict.get("max_tokens"),
                    )
                    ep_dict["outline_provider"] = prov
                    ep_dict["outline_model"] = model
                    ep_dict["outline_config"] = conf
                if ep_dict.get("transcript_llm"):
                    prov, model, conf = await _resolve_model_config(
                        str(ep_dict["transcript_llm"]),
                        max_tokens=ep_dict.get("max_tokens"),
                    )
                    ep_dict["transcript_provider"] = prov
                    ep_dict["transcript_model"] = model
                    ep_dict["transcript_config"] = conf
            except Exception as e:
                logger.warning(
                    f"Failed to resolve models for episode profile '{ep_name}', "
                    f"removing from config to prevent validation errors: {e}"
                )
                del episode_profiles_dict[ep_name]

        # Resolved TTS configs by model ID: the default model shared by several
        # profiles, and the selected profile's model resolved above, are
        # resolved only once.
        tts_configs = {voice_model_id: (tts_provider, tts_model_name, tts_config)}

        # Resolve TTS for ALL speaker profiles (podcast-creator validates all).
        # Remove profiles that fail resolution to prevent validation errors.
        for sp_name in list(speaker_profiles_dict.keys()):
            sp_dict = speaker_profiles_dict[sp_name]
            # Same rule as the selected profile: its own voice model, else the
            # Default Text-to-Speech Model (#1467). podcast-creator requires
            # tts_provider/tts_model on every profile in the config, so a
            # profile with neither is removed instead of failing every
            # generation (#1450). The selected profile always has one: it was
            # validated above.
            try:
                sp_voice_model = pick_voice_model(
                    sp_name, sp_dict.get("voice_model"), default_tts_model
                )
            except ValueError:
                logger.warning(
                    f"Speaker profile '{sp_name}' has no voice model and no default "
                    "Text-to-Speech model is set, removing from config to prevent "
                    "validation errors"
                )
                del speaker_profiles_dict[sp_name]
                continue

            try:
                if sp_voice_model not in tts_configs:
                    tts_configs[sp_voice_model] = await _resolve_model_config(
                        sp_voice_model
                    )

                prov, model, conf = tts_configs[sp_voice_model]

                sp_dict["tts_provider"] = prov
                sp_dict["tts_model"] = model
                sp_dict["tts_config"] = dict(conf)
            except Exception as e:
                logger.warning(
                    f"Failed to resolve TTS for speaker profile '{sp_name}', "
                    f"removing from config to prevent validation errors: {e}"
                )
                del speaker_profiles_dict[sp_name]
                continue

            # Per-speaker TTS overrides
            for speaker in sp_dict.get("speakers", []):
                if speaker.get("voice_model"):
                    try:
                        prov, model, conf = await _resolve_model_config(
                            str(speaker["voice_model"])
                        )
                        speaker["tts_provider"] = prov
                        speaker["tts_model"] = model
                        speaker["tts_config"] = conf
                    except Exception as e:
                        logger.warning(
                            f"Failed to resolve per-speaker TTS for '{speaker.get('name')}': {e}"
                        )

        # SECURITY NOTE for future work: podcast_creator also supports
        # configure("templates", {...}), which compiles the given string
        # directly as Jinja2 template *source* (Prompter(template_text=...)
        # in podcast_creator/config.py) - the exact SSTI shape already fixed
        # in open_notebook/graphs/transformation.py (GHSA-f35w-wx37-26q7).
        # We don't call it today (confirmed: no code path here sets the
        # "templates" key, so podcast generation always uses the file-based
        # prompts/podcast/*.jinja templates in this repo). If a "custom
        # podcast template" feature is ever added, do NOT wire user/profile
        # text into configure("templates", ...) - render it through a
        # fixed, developer-authored template with the user text passed in
        # as a plain variable instead, matching transformation.py's fix.
        configure("speakers_config", {"profiles": speaker_profiles_dict})
        configure("episode_config", {"profiles": episode_profiles_dict})

        logger.info("Configured podcast-creator with episode and speaker profiles")

        logger.info(f"Generated briefing (length: {len(briefing)} chars)")

        # 7. Create output directory using UUID for filesystem-safe paths
        episode_dir_name, output_dir = build_episode_output_dir()
        output_dir.mkdir(parents=True, exist_ok=True)

        logger.info(f"Created output directory: {output_dir}")

        # 8. Generate podcast using podcast-creator
        logger.info("Starting podcast generation with podcast-creator...")

        async def _save_progress(prog: Optional[Dict[str, Any]]) -> None:
            episode.progress = prog
            try:
                await episode.save()
            except Exception as err:
                logger.warning(f"Failed saving progress for {episode.id}: {err}")

        await _save_progress({"stage": "outline"})

        import podcast_creator.graph as pc_graph_mod

        real_graph = pc_graph_mod.graph

        class _StreamingGraphProxy:
            """Streams node updates so outline/transcript persist before TTS finishes."""

            def __init__(self, inner):
                self._inner = inner

            def __getattr__(self, name):
                return getattr(self._inner, name)

            async def ainvoke(self, state, config=None, **kwargs):
                final_state = dict(state) if isinstance(state, dict) else {}
                async for event in self._inner.astream(
                    state, config=config, stream_mode="updates", **kwargs
                ):
                    if not isinstance(event, dict):
                        continue
                    for node_name, node_update in event.items():
                        if not isinstance(node_update, dict):
                            continue
                        final_state.update(node_update)
                        changed = False
                        if "outline" in node_update and node_update["outline"] is not None:
                            episode.outline = full_model_dump(node_update["outline"])
                            episode.progress = {"stage": "transcript"}
                            changed = True
                        if "transcript" in node_update and node_update["transcript"] is not None:
                            episode.transcript = {
                                "transcript": full_model_dump(node_update["transcript"])
                            }
                            entries = episode.transcript.get("transcript") or []
                            total_clips = sum(
                                1 for e in entries if str((e or {}).get("dialogue", "")).strip()
                            )
                            episode.progress = {
                                "stage": "audio",
                                "completed_clips": 0,
                                "total_clips": total_clips,
                                "clips_dir": str(output_dir / "clips"),
                            }
                            changed = True
                        if node_name == "generate_all_audio":
                            cur = dict(episode.progress or {})
                            total_clips = cur.get("total_clips") or len(
                                node_update.get("audio_clips") or []
                            )
                            episode.progress = {
                                "stage": "combining",
                                "completed_clips": total_clips,
                                "total_clips": total_clips,
                            }
                            changed = True
                        if changed:
                            await _save_progress(episode.progress)
                return final_state

        pc_graph_mod.graph = _StreamingGraphProxy(real_graph)
        try:
            result = await create_podcast(
                content=input_data.content,
                briefing=briefing,
                episode_name=episode_dir_name,
                output_dir=str(output_dir),
                speaker_config=speaker_profile.name,
                episode_profile=episode_profile.name,
            )
        finally:
            pc_graph_mod.graph = real_graph
            episode.progress = None

        # podcast-creator reports audio-combination failures IN-BAND: on
        # ffmpeg/clip errors combine_audio_files() returns an "ERROR: ..."
        # string in final_output_file_path instead of a path. Detect it
        # before path conversion so the real error surfaces (below, after
        # the transcript/outline are persisted) instead of a misleading
        # "outside the podcasts folder" ValueError.
        raw_audio_path = result.get("final_output_file_path") if result else None
        audio_error: Optional[str] = None
        if raw_audio_path is not None and str(raw_audio_path).startswith("ERROR:"):
            audio_error = str(raw_audio_path)
            raw_audio_path = None

        # Store the audio path RELATIVE to PODCASTS_FOLDER (#1030). The
        # validation inside to_relative_audio_path guarantees the DB never
        # holds an absolute or root-escaping value; a violation raises
        # ValueError, which marks the job permanently failed (no retry).
        audio_file_rel = (
            to_relative_audio_path(raw_audio_path) if raw_audio_path else None
        )
        episode.audio_file = audio_file_rel
        episode.transcript = {
            "transcript": full_model_dump(result["transcript"]) if result else None
        }
        episode.outline = full_model_dump(result["outline"]) if result else None
        await episode.save()

        if audio_error:
            # Transcript/outline are saved above; fail the job with the real
            # audio-combination error instead of reporting a silent success
            # for an episode with no playable audio.
            raise RuntimeError(f"Podcast audio generation failed: {audio_error}")

        processing_time = time.time() - start_time
        logger.info(
            f"Successfully generated podcast episode: {episode.id} in {processing_time:.2f}s"
        )

        return PodcastGenerationOutput(
            success=True,
            episode_id=str(episode.id),
            audio_file_path=audio_file_rel,
            transcript={"transcript": full_model_dump(result["transcript"])}
            if result.get("transcript")
            else None,
            outline=full_model_dump(result["outline"])
            if result.get("outline")
            else None,
            processing_time=processing_time,
        )

    except ValueError as e:
        # ValueError is the command layer's "permanent failure, do not retry"
        # signal (retry config uses stop_on=[ValueError]), so the type has to
        # survive - but LangChain's OutputParserException and
        # json.JSONDecodeError are ValueError subclasses too. Every parser
        # failure therefore left through here, past the hint mapper below:
        # the placeholder speaker name and the truncated-JSON cases reached
        # the user with no guidance at all (#1238).
        hint = explain_generation_failure(str(e))
        if not hint:
            raise
        logger.error(f"Podcast generation failed: {e}")
        raise ValueError(f"{e}\n\nNOTE: {hint}") from e

    except Exception as e:
        logger.error(f"Podcast generation failed: {e}")
        logger.exception(e)

        error_msg = str(e)
        hint = explain_generation_failure(error_msg)
        if hint:
            error_msg += f"\n\nNOTE: {hint}"

        raise RuntimeError(error_msg) from e


async def _is_command_cancelled(input_data: CommandInput) -> bool:
    cmd_id = getattr(getattr(input_data, "execution_context", None), "command_id", None)
    if not cmd_id:
        return False
    try:
        rows = await repo_query(
            "SELECT status FROM $cmd",
            {"cmd": ensure_record_id(cmd_id)},
        )
        if rows and rows[0].get("status") in ("failed", "error", "cancelled"):
            return True
    except Exception:
        pass
    return False


class RerunPodcastTTSInput(CommandInput):
    episode_id: str


class RerunPodcastTTSOutput(CommandOutput):
    success: bool
    episode_id: str
    audio_file_path: Optional[str] = None
    processing_time: float
    error_message: Optional[str] = None


@command("rerun_podcast_tts", app="open_notebook", retry={"max_attempts": 1})
async def rerun_podcast_tts_command(
    input_data: RerunPodcastTTSInput,
) -> RerunPodcastTTSOutput:
    """Regenerate audio for an episode using its saved (possibly edited) transcript."""
    start_time = time.time()
    try:
        episode = await PodcastEpisode.get(input_data.episode_id)
        if not episode:
            raise ValueError(f"Episode '{input_data.episode_id}' not found")

        raw_entries = (episode.transcript or {}).get("transcript") or []
        if not raw_entries:
            raise ValueError("Episode has no transcript entries to synthesize")

        dialogue_list = [
            Dialogue(
                speaker=str(entry.get("speaker", "")).strip(),
                dialogue=str(entry.get("dialogue", "")).strip(),
            )
            for entry in raw_entries
            if str(entry.get("dialogue", "")).strip()
        ]
        if not dialogue_list:
            raise ValueError("Episode transcript has no non-empty dialogue lines")

        sp_dict = dict(episode.speaker_profile or {})
        if sp_dict.get("voice_model"):
            prov, model, conf = await _resolve_model_config(str(sp_dict["voice_model"]))
            sp_dict["tts_provider"] = prov
            sp_dict["tts_model"] = model
            sp_dict["tts_config"] = conf
        for speaker in sp_dict.get("speakers", []):
            if speaker.get("voice_model"):
                prov, model, conf = await _resolve_model_config(str(speaker["voice_model"]))
                speaker["tts_provider"] = prov
                speaker["tts_model"] = model
                speaker["tts_config"] = conf

        pc_speaker_profile = PCSpeakerProfile(**sp_dict)
        episode_dir_name, output_dir = build_episode_output_dir()
        output_dir.mkdir(parents=True, exist_ok=True)

        state: PodcastState = {
            "content": "",
            "briefing": episode.briefing or "",
            "num_segments": 0,
            "language": None,
            "outline": None,
            "transcript": dialogue_list,
            "audio_clips": [],
            "final_output_file_path": None,
            "output_dir": output_dir,
            "episode_name": episode_dir_name,
            "speaker_profile": pc_speaker_profile,
            "json_mode_models": [],
        }

        all_clip_paths = []
        voices = pc_speaker_profile.get_voice_mapping()
        tts_provider = pc_speaker_profile.tts_provider
        tts_model = pc_speaker_profile.tts_model
        tts_config = pc_speaker_profile.tts_config or {}
        non_empty_raw = [e for e in raw_entries if str(e.get("dialogue", "")).strip()]
        total_clips = len(dialogue_list)
        episode.progress = {
            "stage": "audio",
            "completed_clips": 0,
            "total_clips": total_clips,
            "clips_dir": str(output_dir / "clips"),
        }
        try:
            await episode.save()
        except Exception:
            pass
        for i, dlg in enumerate(dialogue_list):
            if await _is_command_cancelled(input_data):
                raise RuntimeError("Stopped by user")
            speaker = pc_speaker_profile.get_speaker_by_name(dlg.speaker)
            entry_speed = non_empty_raw[i].get("speed") if i < len(non_empty_raw) else None
            sp_cfg = speaker.tts_config if speaker.tts_config is not None else tts_config
            if entry_speed is not None:
                from esperanto import AIFactory

                clips_dir = output_dir / "clips"
                clips_dir.mkdir(exist_ok=True, parents=True)
                clip_path = clips_dir / f"{i:04d}.mp3"
                cfg = dict(sp_cfg or {})
                api_key = cfg.pop("api_key", None)
                base_url = cfg.pop("base_url", None)
                model_inst = AIFactory.create_text_to_speech(
                    speaker.tts_provider or tts_provider,
                    speaker.tts_model or tts_model,
                    api_key=api_key,
                    base_url=base_url,
                    **cfg,
                )
                await model_inst.agenerate_speech(
                    text=dlg.dialogue,
                    voice=voices[dlg.speaker],
                    output_file=clip_path,
                    speed=float(entry_speed),
                )
            else:
                clip_path = await generate_single_audio_clip(
                    {
                        "dialogue": dlg,
                        "index": i,
                        "output_dir": output_dir,
                        "tts_provider": speaker.tts_provider or tts_provider,
                        "tts_model": speaker.tts_model or tts_model,
                        "voices": voices,
                        "tts_config": sp_cfg,
                    }
                )
            all_clip_paths.append(clip_path)
            episode.progress = {
                "stage": "audio",
                "completed_clips": i + 1,
                "total_clips": total_clips,
                "clips_dir": str(output_dir / "clips"),
            }
            try:
                await episode.save()
            except Exception:
                pass

        if await _is_command_cancelled(input_data):
            raise RuntimeError("Stopped by user")

        episode.progress = {
            "stage": "combining",
            "completed_clips": total_clips,
            "total_clips": total_clips,
        }
        try:
            await episode.save()
        except Exception:
            pass

        state["audio_clips"] = all_clip_paths
        final_res = await combine_audio_node(state, {})

        raw_audio_path = final_res.get("final_output_file_path")
        if raw_audio_path is None or str(raw_audio_path).startswith("ERROR:"):
            raise RuntimeError(f"Podcast audio generation failed: {raw_audio_path}")

        audio_file_rel = to_relative_audio_path(str(raw_audio_path))
        old_audio_file = episode.audio_file
        episode.audio_file = audio_file_rel
        episode.progress = None
        await episode.save()

        if old_audio_file and old_audio_file != audio_file_rel:
            from open_notebook.podcasts.audio_paths import resolve_contained_audio_path

            old_path = resolve_contained_audio_path(old_audio_file)
            if old_path is not None and old_path.exists():
                try:
                    old_path.unlink()
                except Exception as exc:
                    logger.warning(f"Failed to delete old audio file {old_path}: {exc}")

        processing_time = time.time() - start_time
        logger.info(f"Regenerated TTS for episode {episode.id} in {processing_time:.2f}s")
        return RerunPodcastTTSOutput(
            success=True,
            episode_id=str(episode.id),
            audio_file_path=audio_file_rel,
            processing_time=processing_time,
        )
    except Exception as e:
        episode.progress = None
        try:
            await episode.save()
        except Exception:
            pass
        logger.error(f"TTS regeneration failed for {input_data.episode_id}: {e}")
        logger.exception(e)
        raise RuntimeError(str(e)) from e
