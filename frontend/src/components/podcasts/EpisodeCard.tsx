'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { getDateLocale } from '@/lib/utils/date-locale'
import { Check, InfoIcon, Loader2, Pencil, Play, Plus, RefreshCcw, Square, Trash2, Volume2, X } from 'lucide-react'

import apiClient from '@/lib/api/client'
import { resolvePodcastAssetUrl } from '@/lib/api/podcasts'
import { useCancelPodcastEpisode, useRerunEpisodeClip, useRerunEpisodeTts, useUpdateEpisodeTranscript } from '@/lib/hooks/use-podcasts'
import { ACTIVE_EPISODE_STATUSES, EpisodeStatus, FAILED_EPISODE_STATUSES, PodcastEpisode } from '@/lib/types/podcasts'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { TFunction } from 'i18next'

interface EpisodeCardProps {
  episode: PodcastEpisode
  onDelete: (episodeId: string) => Promise<void> | void
  deleting?: boolean
  onRetry?: (episodeId: string) => Promise<void> | void
  retrying?: boolean
}

const getSTATUS_META = (t: TFunction): Record<
  EpisodeStatus | 'unknown',
  { label: string; className: string }
> => ({
  running: {
    label: t('podcasts.processingLabel'),
    className: 'bg-warn-tint text-warn border-warn/30',
  },
  processing: {
    label: t('podcasts.processingLabel'),
    className: 'bg-warn-tint text-warn border-warn/30',
  },
  completed: {
    label: t('podcasts.completedLabel'),
    className: 'bg-fern-tint text-fern border-fern/30',
  },
  failed: {
    label: t('podcasts.failedLabel'),
    className: 'bg-destructive-tint text-destructive border-destructive/30',
  },
  error: {
    label: t('podcasts.failedLabel'),
    className: 'bg-destructive-tint text-destructive border-destructive/30',
  },
  pending: {
    label: t('podcasts.pendingLabel'),
    className: 'bg-teal-tint text-teal border-teal/30',
  },
  submitted: {
    label: t('podcasts.pendingLabel'),
    className: 'bg-teal-tint text-teal border-teal/30',
  },
  unknown: {
    label: t('common.unknown'),
    className: 'bg-muted text-muted-foreground border-transparent',
  },
})

function StatusBadge({ status }: { status?: EpisodeStatus | null }) {
  const { t } = useTranslation()
  // Don't show badge for completed episodes
  if (status === 'completed') {
    return null
  }

  const meta = getSTATUS_META(t)[status ?? 'unknown']
  return (
    <Badge
      variant="outline"
      className={cn('uppercase tracking-wide text-xs', meta.className)}
    >
      {meta.label}
    </Badge>
  )
}

type OutlineSegment = {
  name?: string
  description?: string
  size?: string
}

type OutlineData = {
  segments?: OutlineSegment[]
}

type TranscriptEntry = {
  speaker?: string
  dialogue?: string
  speed?: number
}

type TranscriptData = {
  transcript?: TranscriptEntry[]
}

function extractOutlineSegments(outline: unknown): OutlineSegment[] {
  if (outline && typeof outline === 'object' && 'segments' in outline) {
    const data = outline as OutlineData
    if (Array.isArray(data.segments)) {
      return data.segments
    }
  }
  return []
}

/**
 * "provider / name" label for a snapshot model row. Prefers the display
 * fields the API resolves from the snapshot's model references, falls back
 * to the legacy snapshot strings (pre-#1107 episodes), then to a dash.
 */
function formatModelLabel(
  provider?: string | null,
  name?: string | null,
  legacyProvider?: string | null,
  legacyName?: string | null
): string {
  return `${provider || legacyProvider || '—'} / ${name || legacyName || '—'}`
}

function extractTranscriptEntries(transcript: unknown): TranscriptEntry[] {
  if (transcript && typeof transcript === 'object' && 'transcript' in transcript) {
    const data = transcript as TranscriptData
    if (Array.isArray(data.transcript)) {
      return data.transcript
    }
  }
  return []
}

export function EpisodeCard({ episode, onDelete, deleting, onRetry, retrying }: EpisodeCardProps) {
  const { t, language } = useTranslation()
  const [audioSrc, setAudioSrc] = useState<string | undefined>()
  const [audioError, setAudioError] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [editingTranscript, setEditingTranscript] = useState(false)
  const [draftTranscript, setDraftTranscript] = useState<Array<{ speaker: string; dialogue: string; speed?: number }>>([])
  const [clipUrls, setClipUrls] = useState<Record<number, string>>({})
  const [loadingClipIndex, setLoadingClipIndex] = useState<number | null>(null)
  const [rerunningClipIndex, setRerunningClipIndex] = useState<number | null>(null)
  const [blockSpeeds, setBlockSpeeds] = useState<Record<number, number | undefined>>({})
  const [audioNonce, setAudioNonce] = useState(0)

  const updateTranscript = useUpdateEpisodeTranscript()
  const rerunTts = useRerunEpisodeTts()
  const rerunClip = useRerunEpisodeClip()
  const cancelEpisode = useCancelPodcastEpisode()

  const outlineSegments = useMemo(() => extractOutlineSegments(episode.outline), [episode.outline])
  const transcriptEntries = useMemo(() => extractTranscriptEntries(episode.transcript), [episode.transcript])

  const speakerNames = useMemo(() => {
    const names = (episode.speaker_profile?.speakers ?? []).map((s) => s.name).filter(Boolean)
    return Array.from(new Set(names))
  }, [episode.speaker_profile?.speakers])

  const startEditTranscript = () => {
    setDraftTranscript(
      transcriptEntries.map((entry, idx) => ({
        speaker: entry.speaker ?? speakerNames[0] ?? '',
        dialogue: entry.dialogue ?? '',
        speed: blockSpeeds[idx] ?? entry.speed,
      }))
    )
    setEditingTranscript(true)
  }

  const cancelEditTranscript = () => {
    setEditingTranscript(false)
    setDraftTranscript([])
  }

  const saveEditTranscript = async () => {
    const cleaned = draftTranscript
      .map((e) => ({
        speaker: e.speaker.trim(),
        dialogue: e.dialogue.trim(),
        ...(e.speed !== undefined ? { speed: e.speed } : {}),
      }))
      .filter((e) => e.speaker && e.dialogue)
    if (cleaned.length === 0) return
    await updateTranscript.mutateAsync({ episodeId: episode.id, transcript: cleaned })
    setEditingTranscript(false)
  }

  const handlePreviewClip = async (idx: number) => {
    setLoadingClipIndex(idx)
    try {
      const clipApiUrl = await resolvePodcastAssetUrl(
        `/api/podcasts/episodes/${episode.id}/clips/${idx}?v=${Date.now()}`
      )
      if (!clipApiUrl) return
      const response = await apiClient.get<Blob>(clipApiUrl, { responseType: 'blob' })
      const nextUrl = URL.createObjectURL(response.data)
      setClipUrls((prev) => {
        if (prev[idx]) URL.revokeObjectURL(prev[idx])
        return { ...prev, [idx]: nextUrl }
      })
    } catch (err) {
      console.error('Unable to load clip preview', err)
    } finally {
      setLoadingClipIndex(null)
    }
  }

  const handleRerunClip = async (
    idx: number,
    overrides?: { speaker?: string; dialogue?: string; speed?: number }
  ) => {
    setRerunningClipIndex(idx)
    try {
      const speedVal = overrides?.speed ?? blockSpeeds[idx] ?? transcriptEntries[idx]?.speed
      await rerunClip.mutateAsync({
        episodeId: episode.id,
        clipIndex: idx,
        payload: {
          ...(overrides?.speaker ? { speaker: overrides.speaker } : {}),
          ...(overrides?.dialogue ? { dialogue: overrides.dialogue } : {}),
          ...(speedVal !== undefined ? { speed: speedVal } : {}),
        },
      })
      setAudioNonce((n) => n + 1)
      await handlePreviewClip(idx)
    } finally {
      setRerunningClipIndex(null)
    }
  }

  useEffect(() => {
    let revokeUrl: string | undefined
    setAudioError(null)

    // If backend exposed a protected endpoint, fetch it with auth headers
    const loadProtectedAudio = async () => {
      // First resolve the audio URL
      const directAudioUrl = await resolvePodcastAssetUrl(episode.audio_url ?? episode.audio_file)

      if (!directAudioUrl || !episode.audio_url) {
        setAudioSrc(directAudioUrl)
        return
      }

      try {
        // apiClient attaches the auth header; directAudioUrl is absolute so
        // the dynamic baseURL is ignored.
        const response = await apiClient.get<Blob>(directAudioUrl, {
          responseType: 'blob',
        })

        revokeUrl = URL.createObjectURL(response.data)
        setAudioSrc(revokeUrl)
      } catch (error) {
        console.error('Unable to load podcast audio', error)
        setAudioError(t('podcasts.audioUnavailable'))
        setAudioSrc(undefined)
      }
    }

    void loadProtectedAudio()

    return () => {
      if (revokeUrl) {
        URL.revokeObjectURL(revokeUrl)
      }
    }
  }, [episode.audio_url, episode.audio_file, episode.job_status, audioNonce, t])

  const distance = episode.created
    ? formatDistanceToNow(new Date(episode.created), {
        addSuffix: true,
        locale: getDateLocale(language),
      })
    : null

  const createdLabel = distance
    ? t('podcasts.created', { time: distance })
    : null

  const handleDelete = () => {
    void onDelete(episode.id)
  }

  const handleRetry = () => {
    if (onRetry) {
      void onRetry(episode.id)
    }
  }

  const isFailed = FAILED_EPISODE_STATUSES.includes(episode.job_status as EpisodeStatus)
  const isActive = ACTIVE_EPISODE_STATUSES.includes(episode.job_status as EpisodeStatus)

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">
                {episode.name}
              </h3>
              <StatusBadge status={episode.job_status} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('podcasts.profile')}: {episode.episode_profile?.name || t('common.unknown')}
              {createdLabel ? ` • ${createdLabel}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isActive ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => void cancelEpisode.mutateAsync(episode.id)}
                disabled={cancelEpisode.isPending}
                title="Stop generation"
              >
                <Square className="mr-2 h-3.5 w-3.5 fill-current" />
                {cancelEpisode.isPending ? 'Stopping...' : 'Stop'}
              </Button>
            ) : null}
            {transcriptEntries.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void rerunTts.mutateAsync(episode.id)}
                disabled={rerunTts.isPending || isActive}
                title="Regenerate audio from saved transcript"
              >
                <Volume2 className={cn('mr-2 h-4 w-4', rerunTts.isPending && 'animate-pulse')} />
                {rerunTts.isPending ? 'Starting TTS...' : 'Rerun TTS'}
              </Button>
            ) : null}
            <Dialog
              open={detailsOpen}
              onOpenChange={(open) => {
                setDetailsOpen(open)
                if (!open) {
                  setEditingTranscript(false)
                }
              }}
            >
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <InfoIcon className="mr-2 h-4 w-4" /> {t('podcasts.details')}
                </Button>
              </DialogTrigger>
              <DialogContent className="w-[min(90vw,720px)] max-h-[85vh] overflow-hidden">
                <DialogHeader>
                  <DialogTitle>{episode.name}</DialogTitle>
                  <DialogDescription>
                    {episode.episode_profile?.name || t('common.unknown')}
                    {createdLabel ? ` • ${createdLabel}` : ''}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 overflow-hidden">
                  {audioSrc ? (
                    <div className="rounded-md border bg-card p-2">
                      <audio controls preload="none" src={audioSrc} className="w-full" />
                    </div>
                  ) : audioError ? (
                    <p className="text-sm text-destructive">{audioError}</p>
                  ) : null}

                  <Tabs defaultValue="summary" className="h-[60vh] flex flex-col">
                    <TabsList className="grid w-full grid-cols-3">
                      <TabsTrigger value="summary">{t('podcasts.summaryTab')}</TabsTrigger>
                      <TabsTrigger value="outline">{t('podcasts.outlineTab')}</TabsTrigger>
                      <TabsTrigger value="transcript">{t('podcasts.transcriptTab')}</TabsTrigger>
                    </TabsList>

                    <TabsContent value="summary" className="flex-1 overflow-hidden">
                      <ScrollArea className="h-full pr-4">
                        <div className="space-y-6">
                          <section className="space-y-2">
                            <h4 className="text-sm font-semibold text-foreground">{t('podcasts.episodeProfile')}</h4>
                            <div className="grid gap-2 text-sm md:grid-cols-2">
                              <div>
                                <p className="text-muted-foreground">{t('podcasts.outlineModel')}</p>
                                <p>
                                  {formatModelLabel(
                                    episode.episode_profile?.outline_model_provider,
                                    episode.episode_profile?.outline_model_name,
                                    episode.episode_profile?.outline_provider,
                                    episode.episode_profile?.outline_model
                                  )}
                                </p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">{t('podcasts.transcriptModel')}</p>
                                <p>
                                  {formatModelLabel(
                                    episode.episode_profile?.transcript_model_provider,
                                    episode.episode_profile?.transcript_model_name,
                                    episode.episode_profile?.transcript_provider,
                                    episode.episode_profile?.transcript_model
                                  )}
                                </p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">{t('podcasts.segments')}</p>
                                <p>{episode.episode_profile?.num_segments ?? '—'}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground">{t('podcasts.maxTokens')}</p>
                                <p>{episode.episode_profile?.max_tokens ?? '—'}</p>
                              </div>
                            </div>
                            {episode.episode_profile?.default_briefing ? (
                              <div className="rounded border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
                                {episode.episode_profile.default_briefing}
                              </div>
                            ) : null}
                          </section>

                          <section className="space-y-2">
                            <h4 className="text-sm font-semibold text-foreground">{t('podcasts.speakerProfile')}</h4>
                            <p className="text-xs text-muted-foreground">
                              {formatModelLabel(
                                episode.speaker_profile?.voice_model_provider,
                                episode.speaker_profile?.voice_model_name,
                                episode.speaker_profile?.tts_provider,
                                episode.speaker_profile?.tts_model
                              )}
                            </p>
                            {episode.speaker_profile?.speakers?.map((speaker, index) => (
                              <div
                                key={`${speaker.name}-${index}`}
                                className="rounded-md border bg-muted/20 p-3 text-xs"
                              >
                                <p className="font-semibold text-foreground">{speaker.name}</p>
                                <p className="text-muted-foreground">{t('podcasts.voiceId')}: {speaker.voice_id}</p>
                                <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                                  <span className="font-semibold">{t('podcasts.backstory')}:</span> {speaker.backstory}
                                </p>
                                <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                                  <span className="font-semibold">{t('podcasts.personality')}:</span> {speaker.personality}
                                </p>
                              </div>
                            ))}
                          </section>

                          {episode.briefing ? (
                            <section className="space-y-2">
                              <h4 className="text-sm font-semibold text-foreground">{t('podcasts.briefing')}</h4>
                              <div className="rounded border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
                                {episode.briefing}
                              </div>
                            </section>
                          ) : null}
                        </div>
                      </ScrollArea>
                    </TabsContent>

                    <TabsContent value="outline" className="flex-1 overflow-hidden">
                      <ScrollArea className="h-full pr-4">
                        {outlineSegments.length > 0 ? (
                          <div className="space-y-3">
                            {outlineSegments.map((segment, index) => (
                              <div key={index} className="rounded border bg-muted/20 p-3 text-xs space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="font-semibold text-foreground">{segment.name ?? `${t('podcasts.segment')} ${index + 1}`}</p>
                                  {segment.size ? (
                                    <Badge variant="outline" className="text-[10px] uppercase tracking-wide">{segment.size}</Badge>
                                  ) : null}
                                </div>
                                <p className="text-muted-foreground whitespace-pre-wrap">{segment.description ?? t('podcasts.noDescription')}</p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">{t('podcasts.noOutline')}</p>
                        )}
                      </ScrollArea>
                    </TabsContent>

                    <TabsContent value="transcript" className="flex-1 min-h-0 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col gap-2">
                      {transcriptEntries.length > 0 ? (
                        <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
                          {editingTranscript ? (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={cancelEditTranscript}
                                disabled={updateTranscript.isPending}
                              >
                                <X className="mr-1.5 h-3.5 w-3.5" /> Cancel
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void saveEditTranscript()}
                                disabled={updateTranscript.isPending}
                              >
                                <Check className="mr-1.5 h-3.5 w-3.5" />
                                {updateTranscript.isPending ? 'Saving...' : 'Save Transcript'}
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={startEditTranscript}
                            >
                              <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit Transcript
                            </Button>
                          )}
                        </div>
                      ) : null}

                      <ScrollArea className="flex-1 min-h-0 pr-4">
                        <div className="space-y-3">
                          {editingTranscript ? (
                            <>
                              {draftTranscript.map((entry, index) => {
                                const options = Array.from(
                                  new Set([...speakerNames, entry.speaker].filter(Boolean))
                                )
                                return (
                                  <div key={index} className="rounded border bg-muted/20 p-3 text-xs space-y-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div className="flex items-center gap-2">
                                        <span className="font-mono text-[10px] text-muted-foreground">#{index + 1}</span>
                                        <select
                                          aria-label={`Speaker line ${index + 1}`}
                                          className="flex h-7 rounded-md border border-input bg-background px-2 text-xs font-semibold"
                                          value={entry.speaker}
                                          onChange={(e) => {
                                            const val = e.target.value
                                            setDraftTranscript((prev) =>
                                              prev.map((item, i) => (i === index ? { ...item, speaker: val } : item))
                                            )
                                          }}
                                        >
                                          {options.map((name) => (
                                            <option key={name} value={name}>
                                              {name}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        <select
                                          aria-label={`Speed line ${index + 1}`}
                                          className="flex h-7 rounded-md border border-input bg-background px-1.5 text-[11px] font-mono"
                                          value={entry.speed ?? ''}
                                          onChange={(e) => {
                                            const val = e.target.value ? Number(e.target.value) : undefined
                                            setDraftTranscript((prev) =>
                                              prev.map((item, i) => (i === index ? { ...item, speed: val } : item))
                                            )
                                            setBlockSpeeds((prev) => ({ ...prev, [index]: val }))
                                          }}
                                        >
                                          <option value="">Speed: Voice</option>
                                          {[0.75, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3].map((s) => (
                                            <option key={s} value={s}>{s.toFixed(2)}x</option>
                                          ))}
                                        </select>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-7 px-2 text-[11px]"
                                          disabled={loadingClipIndex === index}
                                          onClick={() => void handlePreviewClip(index)}
                                        >
                                          {loadingClipIndex === index ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                          ) : (
                                            <Play className="h-3 w-3" />
                                          )}
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-7 px-2 text-[11px]"
                                          disabled={rerunningClipIndex === index || isActive}
                                          onClick={() =>
                                            void handleRerunClip(index, {
                                              speaker: entry.speaker,
                                              dialogue: entry.dialogue,
                                              speed: entry.speed,
                                            })
                                          }
                                        >
                                          {rerunningClipIndex === index ? (
                                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                          ) : (
                                            <RefreshCcw className="mr-1 h-3 w-3" />
                                          )}
                                          Rerun
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-7 w-7 text-destructive"
                                          disabled={draftTranscript.length <= 1}
                                          onClick={() =>
                                            setDraftTranscript((prev) => prev.filter((_, i) => i !== index))
                                          }
                                          title="Remove line"
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                      </div>
                                    </div>
                                    <Textarea
                                      rows={3}
                                      className="text-xs"
                                      value={entry.dialogue}
                                      onChange={(e) => {
                                        const val = e.target.value
                                        setDraftTranscript((prev) =>
                                          prev.map((item, i) => (i === index ? { ...item, dialogue: val } : item))
                                        )
                                      }}
                                    />
                                    {clipUrls[index] ? (
                                      <audio controls autoPlay src={clipUrls[index]} className="w-full h-8" />
                                    ) : null}
                                  </div>
                                )
                              })}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="w-full"
                                onClick={() =>
                                  setDraftTranscript((prev) => [
                                    ...prev,
                                    {
                                      speaker: speakerNames[0] ?? prev[prev.length - 1]?.speaker ?? '',
                                      dialogue: '',
                                    },
                                  ])
                                }
                              >
                                <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Line
                              </Button>
                            </>
                          ) : transcriptEntries.length > 0 ? (
                            transcriptEntries.map((entry, index) => {
                              const currentSpeed = blockSpeeds[index] ?? entry.speed
                              return (
                                <div key={index} className="rounded border bg-muted/20 p-3 text-xs space-y-2">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="font-semibold text-foreground">
                                      <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">#{index + 1}</span>
                                      {entry.speaker ?? t('podcasts.speaker')}
                                    </p>
                                    <div className="flex items-center gap-1.5">
                                      <select
                                        aria-label={`Speed block ${index + 1}`}
                                        className="flex h-7 rounded-md border border-input bg-background px-1.5 text-[11px] font-mono"
                                        value={currentSpeed ?? ''}
                                        onChange={(e) => {
                                          const val = e.target.value ? Number(e.target.value) : undefined
                                          setBlockSpeeds((prev) => ({ ...prev, [index]: val }))
                                        }}
                                      >
                                        <option value="">Speed: Voice</option>
                                        {[0.75, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3].map((s) => (
                                          <option key={s} value={s}>{s.toFixed(2)}x</option>
                                        ))}
                                      </select>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-7 px-2 text-[11px]"
                                        disabled={loadingClipIndex === index}
                                        onClick={() => void handlePreviewClip(index)}
                                        title="Preview this block"
                                      >
                                        {loadingClipIndex === index ? (
                                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                        ) : (
                                          <Play className="mr-1 h-3 w-3" />
                                        )}
                                        Preview
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-7 px-2 text-[11px]"
                                        disabled={rerunningClipIndex === index || isActive}
                                        onClick={() => void handleRerunClip(index)}
                                        title="Rerun TTS for this block and re-mux"
                                      >
                                        {rerunningClipIndex === index ? (
                                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                        ) : (
                                          <RefreshCcw className="mr-1 h-3 w-3" />
                                        )}
                                        {rerunningClipIndex === index ? 'Rerunning...' : 'Rerun'}
                                      </Button>
                                    </div>
                                  </div>
                                  <p className="text-muted-foreground whitespace-pre-wrap">{entry.dialogue ?? ''}</p>
                                  {clipUrls[index] ? (
                                    <audio controls autoPlay src={clipUrls[index]} className="w-full h-8" />
                                  ) : null}
                                </div>
                              )
                            })
                          ) : (
                            <p className="text-xs text-muted-foreground">{t('podcasts.noTranscript')}</p>
                          )}
                        </div>
                      </ScrollArea>
                    </TabsContent>
                  </Tabs>
                </div>
              </DialogContent>
            </Dialog>
            {isFailed && onRetry ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRetry}
                disabled={retrying}
              >
                <RefreshCcw className={cn('mr-2 h-4 w-4', retrying && 'animate-spin')} />
                {retrying ? t('podcasts.retrying') : t('podcasts.retry')}
              </Button>
            ) : null}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('podcasts.delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('podcasts.deleteEpisodeTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('podcasts.deleteEpisodeDesc', { name: episode.name })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} disabled={deleting}>
                    {deleting ? t('podcasts.deleting') : t('podcasts.delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {audioSrc ? (
          <div className="rounded-md border bg-card p-2">
            <audio controls preload="none" src={audioSrc} className="w-full" />
          </div>
        ) : audioError ? (
          <p className="text-sm text-destructive">{audioError}</p>
        ) : null}

        {isFailed && episode.error_message ? (
          <div className="rounded-md border border-destructive/30 bg-destructive-tint p-3">
            <p className="text-xs font-medium text-destructive">{t('podcasts.errorDetails')}</p>
            <p className="mt-1 text-xs whitespace-pre-wrap text-destructive">{episode.error_message}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
