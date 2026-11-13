import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { podcastsApi, EpisodeProfileInput, SpeakerProfileInput } from '@/lib/api/podcasts'
import { QUERY_KEYS } from '@/lib/api/query-client'
import { useToast } from '@/lib/hooks/use-toast'
import { useTranslation } from '@/lib/hooks/use-translation'
import { getApiErrorKey } from '@/lib/utils/error-handler'
import {
  ACTIVE_EPISODE_STATUSES,
  EpisodeProfile,
  EpisodeStatusGroups,
  PodcastEpisode,
  PodcastGenerationRequest,
  groupEpisodesByStatus,
  speakerUsageMap,
} from '@/lib/types/podcasts'

export function useLanguages() {
  return useQuery({
    queryKey: QUERY_KEYS.languages,
    queryFn: podcastsApi.listLanguages,
    staleTime: Infinity,
  })
}

interface EpisodeStatusCounts {
  total: number
  running: number
  completed: number
  failed: number
  pending: number
}

function hasActiveEpisodes(episodes: PodcastEpisode[]) {
  return episodes.some((episode) => {
    const status = episode.job_status ?? 'unknown'
    return ACTIVE_EPISODE_STATUSES.includes(status)
  })
}

export function usePodcastEpisodes(options?: { autoRefresh?: boolean }) {
  const { autoRefresh = true } = options ?? {}

  const query = useQuery({
    queryKey: QUERY_KEYS.podcastEpisodes,
    queryFn: podcastsApi.listEpisodes,
    refetchInterval: (current) => {
      if (!autoRefresh) {
        return false
      }

      const data = current.state.data as PodcastEpisode[] | undefined
      if (!data || data.length === 0) {
        return false
      }

      return hasActiveEpisodes(data) ? 15_000 : false
    },
  })

  const episodes = useMemo(() => query.data ?? [], [query.data])

  const statusGroups = useMemo<EpisodeStatusGroups>(
    () => groupEpisodesByStatus(episodes),
    [episodes]
  )

  const statusCounts = useMemo<EpisodeStatusCounts>(
    () => ({
      total: episodes.length,
      running: statusGroups.running.length,
      completed: statusGroups.completed.length,
      failed: statusGroups.failed.length,
      pending: statusGroups.pending.length,
    }),
    [episodes.length, statusGroups]
  )

  const active = useMemo(() => hasActiveEpisodes(episodes), [episodes])

  return {
    ...query,
    episodes,
    statusGroups,
    statusCounts,
    hasActiveEpisodes: active,
  }
}

export function useRetryPodcastEpisode() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (episodeId: string) => podcastsApi.retryEpisode(episodeId),
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.retryStarted'),
        description: t('podcasts.retryStartedDesc'),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToRetry'),
        description: getApiErrorKey(error, t('common.error')),
        variant: 'destructive',
      })
    },
  })
}

export function useUpdateEpisodeTranscript() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: ({
      episodeId,
      transcript,
    }: {
      episodeId: string
      transcript: Array<{ speaker: string; dialogue: string; speed?: number }>
    }) => podcastsApi.updateEpisodeTranscript(episodeId, transcript),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: 'Transcript saved',
        description: 'Click Rerun TTS on the episode card to regenerate the audio.',
      })
    },
    onError: (error: unknown) => {
      toast({
        title: 'Failed to save transcript',
        description: error instanceof Error ? error.message : 'Unable to save transcript',
        variant: 'destructive',
      })
    },
  })
}

export function useRerunEpisodeClip() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: ({
      episodeId,
      clipIndex,
      payload,
    }: {
      episodeId: string
      clipIndex: number
      payload: { speaker?: string; dialogue?: string; speed?: number }
    }) => podcastsApi.rerunEpisodeClip(episodeId, clipIndex, payload),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: `Block #${variables.clipIndex + 1} updated`,
        description: 'Regenerated block audio and re-muxed the episode.',
      })
    },
    onError: (error: unknown) => {
      toast({
        title: 'Failed to rerun block TTS',
        description: error instanceof Error ? error.message : 'Unable to rerun block',
        variant: 'destructive',
      })
    },
  })
}

export function useRerunEpisodeTts() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: (episodeId: string) => podcastsApi.rerunEpisodeTts(episodeId),
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: 'TTS regeneration started',
        description: 'The episode audio is being regenerated from the saved transcript.',
      })
    },
    onError: (error: unknown) => {
      toast({
        title: 'Failed to rerun TTS',
        description: error instanceof Error ? error.message : 'Unable to rerun TTS',
        variant: 'destructive',
      })
    },
  })
}

export function useCancelPodcastEpisode() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: (episodeId: string) => podcastsApi.cancelEpisode(episodeId),
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: 'Generation stopped',
        description: 'The active generation job has been stopped.',
      })
    },
    onError: (error: unknown) => {
      toast({
        title: 'Failed to stop generation',
        description: error instanceof Error ? error.message : 'Unable to stop generation',
        variant: 'destructive',
      })
    },
  })
}

export function useDeletePodcastEpisode() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (episodeId: string) => podcastsApi.deleteEpisode(episodeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.episodeDeleted'),
        description: t('podcasts.episodeDeletedDesc'),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToDeleteEpisode'),
        description: getApiErrorKey(error, t('common.error')),
        variant: 'destructive',
      })
    },
  })
}

export function useEpisodeProfiles() {
  const query = useQuery({
    queryKey: QUERY_KEYS.episodeProfiles,
    queryFn: podcastsApi.listEpisodeProfiles,
  })

  return {
    ...query,
    episodeProfiles: query.data ?? [],
  }
}

export function useCreateEpisodeProfile() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (payload: EpisodeProfileInput) =>
      podcastsApi.createEpisodeProfile(payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.episodeProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.profileCreated'),
        description: t('podcasts.profileCreatedDesc', { name: data.name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToCreateProfile'),
        description: getApiErrorKey(error, t('common.error')),
        variant: 'destructive',
      })
    },
  })
}

export function useUpdateEpisodeProfile() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: ({
      profileId,
      payload,
    }: {
      profileId: string
      payload: EpisodeProfileInput
    }) => podcastsApi.updateEpisodeProfile(profileId, payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.episodeProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.profileUpdated'),
        description: t('podcasts.profileUpdatedDesc', { name: data.name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToUpdateProfile'),
        description: getApiErrorKey(error, t('common.error')),
        variant: 'destructive',
      })
    },
  })
}

export function useDeleteEpisodeProfile() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: ({ profileId }: { profileId: string; name: string }) =>
      podcastsApi.deleteEpisodeProfile(profileId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.episodeProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.profileDeleted'),
        description: t('podcasts.profileDeletedDesc', { name: variables.name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToDeleteProfile'),
        description: getApiErrorKey(error, t('podcasts.failedToDeleteProfileDesc')),
        variant: 'destructive',
      })
    },
  })
}

export function useDuplicateEpisodeProfile() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (profileId: string) =>
      podcastsApi.duplicateEpisodeProfile(profileId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.episodeProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.profileDuplicated'),
        description: t('podcasts.profileDuplicatedDesc', { name: data.name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToDuplicateProfile'),
        description: getApiErrorKey(error, t('common.error')),
        variant: 'destructive',
      })
    },
  })
}

export function useSpeakerProfiles(episodeProfiles?: EpisodeProfile[]) {
  const query = useQuery({
    queryKey: QUERY_KEYS.speakerProfiles,
    queryFn: podcastsApi.listSpeakerProfiles,
  })

  const speakerProfiles = useMemo(() => query.data ?? [], [query.data])

  const usage = useMemo(
    () => speakerUsageMap(speakerProfiles, episodeProfiles),
    [speakerProfiles, episodeProfiles]
  )

  return {
    ...query,
    speakerProfiles,
    usage,
  }
}

export function useCreateSpeakerProfile() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (payload: SpeakerProfileInput) =>
      podcastsApi.createSpeakerProfile(payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.speakerProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.episodeProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.speakerCreated'),
        description: t('podcasts.speakerCreatedDesc', { name: data.name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToCreateSpeaker'),
        description: getApiErrorKey(error, t('common.error')),
        variant: 'destructive',
      })
    },
  })
}

export function useUpdateSpeakerProfile() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: ({
      profileId,
      payload,
    }: {
      profileId: string
      payload: SpeakerProfileInput
    }) => podcastsApi.updateSpeakerProfile(profileId, payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.speakerProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.episodeProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.speakerUpdated'),
        description: t('podcasts.speakerUpdatedDesc', { name: data.name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToUpdateSpeaker'),
        description: getApiErrorKey(error, t('common.error')),
        variant: 'destructive',
      })
    },
  })
}

export function useDeleteSpeakerProfile() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: ({ profileId }: { profileId: string; name: string }) =>
      podcastsApi.deleteSpeakerProfile(profileId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.speakerProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.episodeProfiles })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.speakerDeleted'),
        description: t('podcasts.speakerDeletedDesc', { name: variables.name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToDeleteSpeaker'),
        description: getApiErrorKey(error, t('podcasts.failedToDeleteSpeakerDesc')),
        variant: 'destructive',
      })
    },
  })
}

export function useDuplicateSpeakerProfile() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (profileId: string) =>
      podcastsApi.duplicateSpeakerProfile(profileId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.speakerProfiles })
      toast({
        title: t('podcasts.speakerDuplicated'),
        description: t('podcasts.speakerDuplicatedDesc', { name: data.name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToDuplicateSpeaker'),
        description: getApiErrorKey(error, t('common.error')),
        variant: 'destructive',
      })
    },
  })
}

export function useGeneratePodcast() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { t } = useTranslation()

  return useMutation({
    mutationFn: (payload: PodcastGenerationRequest) =>
      podcastsApi.generatePodcast(payload),
    onSuccess: async (response) => {
      // Immediately refetch to show the new episode
      await queryClient.refetchQueries({ queryKey: QUERY_KEYS.podcastEpisodes })
      toast({
        title: t('podcasts.generationStarted'),
        description: t('podcasts.generationStartedDesc', { name: response.episode_name }),
      })
    },
    onError: (error: unknown) => {
      toast({
        title: t('podcasts.failedToStartGeneration'),
        description: getApiErrorKey(error, t('podcasts.tryAgainMoment')),
        variant: 'destructive',
      })
    },
  })
}
