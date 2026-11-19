'use client'

import { useCallback, useEffect, useState } from 'react'
import { Controller, useFieldArray, useForm } from 'react-hook-form'
import type { FieldErrorsImpl } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, Plus, RefreshCw, Send, Sparkles, Trash2, Volume2, Wand2, X } from 'lucide-react'

import { SpeakerProfile } from '@/lib/types/podcasts'
import {
  useCreateSpeakerProfile,
  useUpdateSpeakerProfile,
} from '@/lib/hooks/use-podcasts'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { ModelSelector } from '@/components/common/ModelSelector'

import type { TFunction } from 'i18next'
import { useTranslation } from '@/lib/hooks/use-translation'

const speakerConfigSchema = (t: TFunction) => z.object({
  name: z.string().min(1, t('common.nameRequired') || 'Name is required'),
  voice_id: z.string().min(1, t('podcasts.voiceIdRequired') || 'Voice ID is required'),
  backstory: z.string().min(1, t('podcasts.backstoryRequired') || 'Backstory is required'),
  personality: z.string().min(1, t('podcasts.personalityRequired') || 'Personality is required'),
  voice_model: z.string().nullable().optional(),
})

const speakerProfileSchema = (t: TFunction) => z.object({
  name: z.string().min(1, t('common.nameRequired') || 'Name is required'),
  description: z.string().optional(),
  voice_model: z.string().min(1, t('podcasts.voiceModelRequired') || 'Voice model is required'),
  speakers: z
    .array(speakerConfigSchema(t))
    .min(1, t('podcasts.speakerCountMin') || 'At least one speaker is required')
    .max(4, t('podcasts.speakerCountMax') || 'You can configure up to 4 speakers'),
})

export type SpeakerProfileFormValues = z.infer<ReturnType<typeof speakerProfileSchema>>

interface SpeakerProfileFormDialogProps {
  mode: 'create' | 'edit'
  open: boolean
  onOpenChange: (open: boolean) => void
  initialData?: SpeakerProfile
}

const EMPTY_SPEAKER = {
  name: '',
  voice_id: '',
  backstory: '',
  personality: '',
  voice_model: null as string | null,
}

export function SpeakerProfileFormDialog({
  mode,
  open,
  onOpenChange,
  initialData,
}: SpeakerProfileFormDialogProps) {
  const { t } = useTranslation()
  const createProfile = useCreateSpeakerProfile()
  const updateProfile = useUpdateSpeakerProfile()

  const getDefaults = useCallback((): SpeakerProfileFormValues => {
    if (initialData) {
      return {
        name: initialData.name,
        description: initialData.description ?? '',
        voice_model: initialData.voice_model ?? '',
        speakers: initialData.speakers?.map((speaker) => ({
          ...speaker,
          voice_model: speaker.voice_model ?? null,
        })) ?? [{ ...EMPTY_SPEAKER }],
      }
    }

    return {
      name: '',
      description: '',
      voice_model: '',
      speakers: [{ ...EMPTY_SPEAKER }],
    }
  }, [initialData])

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<SpeakerProfileFormValues>({
    resolver: zodResolver(speakerProfileSchema(t)),
    defaultValues: getDefaults(),
  })

  // Inline Voice Rebake state (per-speaker index)
  const [rebakeIndex, setRebakeIndex] = useState<number | null>(null)
  const [rebakeRvcModels, setRebakeRvcModels] = useState<string[]>([])
  const [rebakeCatalog, setRebakeCatalog] = useState<Array<{ path: string; name: string; gender: string; pitch: string; energy: string; timbre?: string[]; accent?: string; description?: string }>>([])
  const [rebakeBakedSet, setRebakeBakedSet] = useState<Record<string, string>>({})
  const [rebakeVdAvailable, setRebakeVdAvailable] = useState(false)
  const [rebakeBaseSpeakers, setRebakeBaseSpeakers] = useState<string[]>([
    'ryan', 'serena', 'vivian', 'aiden', 'uncle_fu', 'ono_anna', 'sohee', 'eric', 'dylan',
  ])
  const [rebakeBaseMode, setRebakeBaseMode] = useState<'custom' | 'design'>('custom')
  const [rebakeBaseSpeaker, setRebakeBaseSpeaker] = useState('ryan')
  const [rebakeInstruct, setRebakeInstruct] = useState('')
  const [rebakeRvcModel, setRebakeRvcModel] = useState('')
  const [rebakeRvcSearch, setRebakeRvcSearch] = useState('')
  const [rebakeRvcOpen, setRebakeRvcOpen] = useState(false)
  const [rebakePitch, setRebakePitch] = useState(0)
  const [rebakePitchAlgo, setRebakePitchAlgo] = useState<'rmvpe' | 'crepe' | 'harvest' | 'pm'>('rmvpe')
  const [rebakeIndexInfluence, setRebakeIndexInfluence] = useState(0.66)
  const [rebakeConsonantProtection, setRebakeConsonantProtection] = useState(0.33)
  const [rebakeDenoise, setRebakeDenoise] = useState<'off' | 'gentle' | 'strong'>('off')
  const [rebakeSpeed, setRebakeSpeed] = useState(1.0)
  const [rebakePreviewing, setRebakePreviewing] = useState(false)
  const [rebakePreviewUrl, setRebakePreviewUrl] = useState<string | null>(null)
  const [rebakeSampleText, setRebakeSampleText] = useState('')
  const [generatingSampleLine, setGeneratingSampleLine] = useState(false)
  const [rebaking, setRebaking] = useState(false)
  const [rebakeError, setRebakeError] = useState<string | null>(null)
  const [rebakeStatus, setRebakeStatus] = useState<string | null>(null)
  const [rebakeTick, setRebakeTick] = useState(0)

  const openRebaker = async (idx: number) => {
    if (rebakeIndex === idx) {
      setRebakeIndex(null)
      return
    }
    setRebakeIndex(idx)
    setRebakeError(null)
    setRebakeStatus(null)
    setRebakeRvcSearch('')
    setRebakeRvcOpen(false)
    const currentVoiceId = (watch(`speakers.${idx}.voice_id`) || '').trim()
    try {
      const res = await fetch('/api/voices')
      if (res.ok) {
        const data = await res.json()
        setRebakeRvcModels(data.rvc_models || [])
        setRebakeCatalog(data.rvc_catalog || [])
        setRebakeVdAvailable(Boolean(data.voice_design_available))
        if (Array.isArray(data.base_speakers) && data.base_speakers.length > 0) {
          setRebakeBaseSpeakers(data.base_speakers)
          setRebakeBaseSpeaker((prev) =>
            data.base_speakers.includes(prev) ? prev : data.base_speakers[0]
          )
        }
        const bakedMap: Record<string, string> = {}
        const speedMap: Record<string, number> = {}
        for (const b of data.baked || []) {
          bakedMap[b.name] = b.sample_text || ''
          speedMap[b.name] = typeof b.speed === 'number' ? b.speed : 1.0
        }
        setRebakeBakedSet(bakedMap)
        setRebakeSpeed(currentVoiceId && currentVoiceId in speedMap ? speedMap[currentVoiceId] : 1.0)
        if (currentVoiceId && bakedMap[currentVoiceId]) {
          setRebakeSampleText(bakedMap[currentVoiceId])
        } else {
          setRebakeSampleText(
            'Alright, listen close, see? You walk into my joint, you play by my rules. The little guy in the corner? Nobody noticed him, till he took the whole table.'
          )
        }
      }
    } catch {
      // ignore transient load failure
    }
  }

  const handleSelectRebakeRvc = (path: string) => {
    setRebakeRvcModel(path)
    setRebakeRvcOpen(false)
    setRebakeRvcSearch('')
    const meta = rebakeCatalog.find((c) => c.path === path)
    if (meta) {
      const traits = [meta.pitch ? `${meta.pitch} pitch` : '', meta.energy, ...(meta.timbre || [])]
        .filter(Boolean)
        .join(', ')
      setRebakeInstruct(
        `${meta.gender} ${meta.accent || ''} voice, ${traits}. ${meta.description || ''}`
          .replace(/\s+/g, ' ')
          .trim()
      )
    }
  }

  const handleGenerateSampleLine = async (idx: number) => {
    const name = (watch(`speakers.${idx}.name`) || '').trim()
    const backstory = (watch(`speakers.${idx}.backstory`) || '').trim()
    const personality = (watch(`speakers.${idx}.personality`) || '').trim()
    if (!name && !backstory && !personality) {
      setRebakeError('Fill in Name, Backstory, or Personality first')
      return
    }
    setGeneratingSampleLine(true)
    setRebakeError(null)
    try {
      const res = await fetch('/api/speaker-profiles/sample-line', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, backstory, personality }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      if (data.sample_text) {
        setRebakeSampleText(data.sample_text)
      }
      if (data.voicedesign_instruct && (rebakeBaseMode === 'design' || !rebakeInstruct.trim())) {
        setRebakeInstruct(data.voicedesign_instruct)
      }
    } catch (err) {
      setRebakeError(err instanceof Error ? err.message : 'Failed to generate sample line')
    } finally {
      setGeneratingSampleLine(false)
    }
  }

  const handlePreviewRebake = async (idx: number) => {
    const voiceId = (watch(`speakers.${idx}.voice_id`) || '').trim() || 'preview'
    setRebakePreviewing(true)
    setRebakeError(null)
    setRebakeStatus(null)
    try {
      const res = await fetch('/api/voices/preview-bake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: voiceId,
          rvc_model: rebakeRvcModel,
          base_speaker: rebakeBaseSpeaker,
          use_voice_design: rebakeBaseMode === 'design',
          instruct: rebakeBaseMode === 'design' ? rebakeInstruct.trim() : undefined,
          f0_up_key: Number(rebakePitch) || 0,
          pitch_algo: rebakePitchAlgo,
          index_influence: rebakeIndexInfluence,
          consonant_breath_protection: rebakeConsonantProtection,
          denoise: rebakeDenoise,
          speed: rebakeSpeed,
          sample_text: rebakeSampleText.trim() || undefined,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const nextUrl = URL.createObjectURL(blob)
      setRebakePreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return nextUrl
      })
    } catch (err) {
      setRebakeError(err instanceof Error ? err.message : 'Preview failed')
    } finally {
      setRebakePreviewing(false)
    }
  }

  const handleRebakeVoice = async (idx: number) => {
    const voiceId = (watch(`speakers.${idx}.voice_id`) || '').trim()
    if (!voiceId) {
      setRebakeError('Enter a Voice ID first')
      return
    }
    setRebaking(true)
    setRebakeError(null)
    setRebakeStatus(null)
    try {
      const res = await fetch('/api/voices/bake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: voiceId,
          rvc_model: rebakeRvcModel,
          base_speaker: rebakeBaseSpeaker,
          use_voice_design: rebakeBaseMode === 'design',
          instruct: rebakeBaseMode === 'design' ? rebakeInstruct.trim() : undefined,
          f0_up_key: Number(rebakePitch) || 0,
          pitch_algo: rebakePitchAlgo,
          index_influence: rebakeIndexInfluence,
          consonant_breath_protection: rebakeConsonantProtection,
          denoise: rebakeDenoise,
          speed: rebakeSpeed,
          sample_text: rebakeSampleText.trim() || undefined,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setRebakeBakedSet((prev) => ({ ...prev, [voiceId]: rebakeSampleText.trim() }))
      setRebakeTick((t) => t + 1)
      setRebakeStatus(`Rebaked "${voiceId}"!`)
    } catch (err) {
      setRebakeError(err instanceof Error ? err.message : 'Rebake failed')
    } finally {
      setRebaking(false)
    }
  }

  // AI Character Designer state (per-speaker index)
  const [designerIndex, setDesignerIndex] = useState<number | null>(null)
  const [designMessages, setDesignMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [designInput, setDesignInput] = useState('')
  const [designQuestions, setDesignQuestions] = useState<
    Array<{ id: string; label: string; prompt: string; placeholder?: string }>
  >([])
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({})
  const [designReply, setDesignReply] = useState<string | null>(null)
  const [designLoading, setDesignLoading] = useState(false)
  const [designError, setDesignError] = useState<string | null>(null)
  const [designDraft, setDesignDraft] = useState<{
    name: string
    backstory: string
    personality: string
    suggested_rvc_model?: string | null
    suggested_rvc_reason?: string
    suggested_voice_id?: string
    suggested_base_speaker?: string
    suggested_f0_up_key?: number
    suggested_sample_text?: string
  } | null>(null)
  const [bakingSuggested, setBakingSuggested] = useState(false)
  const [bakeSuccessMsg, setBakeSuccessMsg] = useState<string | null>(null)

  const openDesigner = (idx: number) => {
    if (designerIndex === idx) {
      setDesignerIndex(null)
      return
    }
    setDesignerIndex(idx)
    setDesignMessages([])
    setDesignInput('')
    setDesignQuestions([])
    setQuestionAnswers({})
    setDesignReply(null)
    setDesignError(null)
    setDesignDraft(null)
    setBakeSuccessMsg(null)
  }

  const sendDesignTurn = async (finalize = false) => {
    let composed = designInput.trim()
    if (designQuestions.length > 0) {
      const answeredLines = designQuestions
        .map((q) => {
          const ans = (questionAnswers[q.id] || '').trim()
          return ans ? `${q.label}: ${ans}` : null
        })
        .filter(Boolean) as string[]
      if (composed) answeredLines.push(`Extra notes: ${composed}`)
      composed = answeredLines.join('\n')
    }
    if (!composed && !finalize) return

    const nextMessages = composed
      ? [...designMessages, { role: 'user' as const, content: composed }]
      : designMessages
    if (composed) {
      setDesignMessages(nextMessages)
      setDesignInput('')
      setQuestionAnswers({})
    }
    setDesignLoading(true)
    setDesignError(null)
    try {
      const res = await fetch('/api/speaker-profiles/design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages, finalize }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      const cleanReply = typeof data.reply === 'string' ? data.reply.replace(/\*\*/g, '') : ''
      if (cleanReply) {
        setDesignReply(cleanReply)
        setDesignMessages([...nextMessages, { role: 'assistant', content: cleanReply }])
      }
      if (Array.isArray(data.questions) && data.questions.length > 0 && data.status !== 'ready') {
        setDesignQuestions(data.questions)
      } else {
        setDesignQuestions([])
      }
      if (data.status === 'ready' && data.draft) {
        setDesignDraft(data.draft)
        setDesignQuestions([])
      }
    } catch (err) {
      setDesignError(err instanceof Error ? err.message : 'Design request failed')
    } finally {
      setDesignLoading(false)
    }
  }

  const applyDraftToSpeaker = (idx: number) => {
    if (!designDraft) return
    setValue(`speakers.${idx}.name`, designDraft.name, { shouldDirty: true, shouldValidate: true })
    setValue(`speakers.${idx}.backstory`, designDraft.backstory, { shouldDirty: true, shouldValidate: true })
    setValue(`speakers.${idx}.personality`, designDraft.personality, { shouldDirty: true, shouldValidate: true })
    if (designDraft.suggested_voice_id) {
      setValue(`speakers.${idx}.voice_id`, designDraft.suggested_voice_id, { shouldDirty: true, shouldValidate: true })
    }
  }

  const bakeSuggestedVoice = async () => {
    if (!designDraft?.suggested_rvc_model || !designDraft?.suggested_voice_id) return
    setBakingSuggested(true)
    setDesignError(null)
    setBakeSuccessMsg(null)
    try {
      const res = await fetch('/api/voices/bake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: designDraft.suggested_voice_id,
          rvc_model: designDraft.suggested_rvc_model,
          base_speaker: designDraft.suggested_base_speaker || 'ryan',
          f0_up_key: Number(designDraft.suggested_f0_up_key) || 0,
          sample_text: designDraft.suggested_sample_text || undefined,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setBakeSuccessMsg(`Baked "${designDraft.suggested_voice_id}" — ready to use!`)
    } catch (err) {
      setDesignError(err instanceof Error ? err.message : 'Failed to bake suggested voice')
    } finally {
      setBakingSuggested(false)
    }
  }

  const {
    fields,
    append,
    remove,
  } = useFieldArray({
    control,
    name: 'speakers',
  })

  const speakersArrayError = (
    errors.speakers as FieldErrorsImpl<{ root?: { message?: string } }> | undefined
  )?.root?.message

  useEffect(() => {
    if (!open) {
      return
    }
    reset(getDefaults())
  }, [open, reset, getDefaults])

  const onSubmit = async (values: SpeakerProfileFormValues) => {
    const payload = {
      ...values,
      description: values.description ?? '',
      speakers: values.speakers.map((s) => ({
        ...s,
        voice_model: s.voice_model || null,
      })),
    }

    if (mode === 'create') {
      await createProfile.mutateAsync(payload)
    } else if (initialData) {
      await updateProfile.mutateAsync({
        profileId: initialData.id,
        payload,
      })
    }

    onOpenChange(false)
  }

  const isSubmitting = createProfile.isPending || updateProfile.isPending
  const disableSubmit = isSubmitting
  const isEdit = mode === 'edit'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('podcasts.editSpeakerProfile') : t('podcasts.createSpeakerProfile')}
          </DialogTitle>
          <DialogDescription>
            {t('podcasts.speakerProfileFormDesc')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 pt-2">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">{t('podcasts.profileName')} *</Label>
              <Input id="name" placeholder={t('podcasts.profileNamePlaceholder')} {...register('name')} />
              {errors.name ? (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">{t('common.description')}</Label>
              <Textarea
                id="description"
                rows={3}
                placeholder={t('podcasts.descriptionPlaceholder')}
                {...register('description')}
              />
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t('podcasts.voiceModel')}
              </h3>
              <Separator className="mt-2" />
            </div>
            <Controller
              control={control}
              name="voice_model"
              render={({ field }) => (
                <div>
                  <ModelSelector
                    label={`${t('podcasts.voiceModel')} *`}
                    modelType="text_to_speech"
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={t('podcasts.selectVoiceModel')}
                  />
                  {errors.voice_model ? (
                    <p className="text-xs text-destructive mt-1">
                      {errors.voice_model.message}
                    </p>
                  ) : null}
                </div>
              )}
            />
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('podcasts.speakers')}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t('podcasts.speakersDesc')}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => append({ ...EMPTY_SPEAKER })}
                disabled={fields.length >= 4}
              >
                <Plus className="mr-2 h-4 w-4" /> {t('podcasts.addSpeaker')}
              </Button>
            </div>
            <Separator />

            {fields.map((field, index) => (
              <div key={field.id} className="rounded-lg border p-4 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {t('podcasts.speakerNumber', { number: (index + 1).toString() })}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant={rebakeIndex === index ? 'secondary' : 'outline'}
                      size="sm"
                      onClick={() => void openRebaker(index)}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      {rebakeIndex === index ? 'Close Rebake' : 'Rebake Voice'}
                    </Button>
                    <Button
                      type="button"
                      variant={designerIndex === index ? 'secondary' : 'outline'}
                      size="sm"
                      onClick={() => openDesigner(index)}
                    >
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                      {designerIndex === index ? 'Close Designer' : 'Design with AI'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(index)}
                      disabled={fields.length <= 1}
                      className="text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" /> {t('common.remove')}
                    </Button>
                  </div>
                </div>

                {rebakeIndex === index ? (
                  <div className="rounded-md border bg-muted/40 p-3 space-y-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold flex items-center gap-1.5">
                        <RefreshCw className="h-3.5 w-3.5" />
                        Rebake Voice: <span className="font-mono">{watch(`speakers.${index}.voice_id`) || '(enter Voice ID)'}</span>
                      </span>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant={rebakeBaseMode === 'custom' ? 'default' : 'outline'}
                          onClick={() => setRebakeBaseMode('custom')}
                        >
                          Preset Speaker
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={rebakeBaseMode === 'design' ? 'default' : 'outline'}
                          onClick={() => setRebakeBaseMode('design')}
                          disabled={!rebakeVdAvailable}
                        >
                          VoiceDesign
                        </Button>
                      </div>
                    </div>

                    {(() => {
                      const vid = (watch(`speakers.${index}.voice_id`) || '').trim()
                      if (vid && vid in rebakeBakedSet) {
                        return (
                          <audio
                            key={`${vid}-${rebakeTick}`}
                            controls
                            preload="none"
                            className="w-full h-8"
                            src={`/api/voices/${encodeURIComponent(vid)}/preview?v=${rebakeTick}`}
                          />
                        )
                      }
                      return null
                    })()}

                    <div className="grid gap-3 sm:grid-cols-3">
                      {rebakeBaseMode === 'custom' ? (
                        <div className="space-y-1">
                          <Label className="text-[11px]">Base Speaker</Label>
                          <select
                            aria-label="Rebake Base Speaker"
                            className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                            value={rebakeBaseSpeaker}
                            onChange={(e) => setRebakeBaseSpeaker(e.target.value)}
                          >
                            {rebakeBaseSpeakers.map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <Label className="text-[11px]">VoiceDesign Instruction</Label>
                          <Input
                            className="h-8 text-xs"
                            placeholder="e.g. Deep gravelly male..."
                            value={rebakeInstruct}
                            onChange={(e) => setRebakeInstruct(e.target.value)}
                          />
                        </div>
                      )}

                      <div className="space-y-1 relative">
                        <Label className="text-[11px]">RVC Model (.pth)</Label>
                        <div className="relative">
                          <Input
                            aria-label="Rebake RVC Model"
                            className="h-8 pr-7 text-xs"
                            placeholder={
                              rebakeRvcModel
                                ? rebakeCatalog.find((c) => c.path === rebakeRvcModel)?.name || rebakeRvcModel
                                : 'None (base only) — type to search...'
                            }
                            value={
                              rebakeRvcOpen
                                ? rebakeRvcSearch
                                : rebakeRvcModel
                                  ? rebakeCatalog.find((c) => c.path === rebakeRvcModel)?.name || rebakeRvcModel
                                  : ''
                            }
                            onFocus={() => {
                              setRebakeRvcSearch('')
                              setRebakeRvcOpen(true)
                            }}
                            onBlur={() => {
                              setTimeout(() => setRebakeRvcOpen(false), 120)
                            }}
                            onChange={(e) => {
                              setRebakeRvcSearch(e.target.value)
                              setRebakeRvcOpen(true)
                            }}
                          />
                          {(rebakeRvcModel || rebakeRvcSearch) && (
                            <button
                              type="button"
                              aria-label="Clear RVC model"
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                              onMouseDown={(e) => {
                                e.preventDefault()
                                setRebakeRvcModel('')
                                setRebakeRvcSearch('')
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        {rebakeRvcOpen && (
                          <div className="absolute left-0 right-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                            <button
                              type="button"
                              className={`w-full rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground ${
                                rebakeRvcModel === '' ? 'bg-accent/60 font-medium' : ''
                              }`}
                              onMouseDown={(e) => {
                                e.preventDefault()
                                handleSelectRebakeRvc('')
                              }}
                            >
                              None (base only)
                            </button>
                            {(() => {
                              const q = rebakeRvcSearch.trim().toLowerCase()
                              const matches = rebakeRvcModels
                                .filter((m) => {
                                  if (!q) return true
                                  const meta = rebakeCatalog.find((c) => c.path === m)
                                  const hay = `${m} ${meta?.name || ''} ${meta?.accent || ''} ${(meta?.timbre || []).join(' ')} ${meta?.description || ''}`.toLowerCase()
                                  return q.split(/\s+/).every((tok) => hay.includes(tok))
                                })
                                .slice(0, 80)
                              if (matches.length === 0) {
                                return (
                                  <div className="px-2 py-2 text-[11px] text-muted-foreground">
                                    No RVC models match &ldquo;{rebakeRvcSearch}&rdquo;
                                  </div>
                                )
                              }
                              return matches.map((m) => {
                                const meta = rebakeCatalog.find((c) => c.path === m)
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    className={`w-full rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground ${
                                      rebakeRvcModel === m ? 'bg-accent/60 font-medium' : ''
                                    }`}
                                    onMouseDown={(e) => {
                                      e.preventDefault()
                                      handleSelectRebakeRvc(m)
                                    }}
                                  >
                                    <div className="truncate font-medium">{meta?.name || m}</div>
                                    <div className="truncate text-[10px] text-muted-foreground">{m}</div>
                                  </button>
                                )
                              })
                            })()}
                          </div>
                        )}
                      </div>

                      <div className="space-y-1">
                        <Label className="text-[11px]">Pitch Shift (semitones)</Label>
                        <Input
                          type="number"
                          min={-12}
                          max={12}
                          className="h-8 text-xs"
                          value={rebakePitch}
                          onChange={(e) => setRebakePitch(Number(e.target.value))}
                        />
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label className="text-[11px]">Pitch Extractor</Label>
                        <select
                          aria-label="Rebake Pitch Extractor"
                          className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                          value={rebakePitchAlgo}
                          onChange={(e) => setRebakePitchAlgo(e.target.value as 'rmvpe' | 'crepe' | 'harvest' | 'pm')}
                        >
                          <option value="rmvpe">RMVPE (Best speech)</option>
                          <option value="crepe">CREPE (Singing / smooth)</option>
                          <option value="harvest">Harvest</option>
                          <option value="pm">PM (Fast)</option>
                        </select>
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          RMVPE for speech/accents; CREPE if pitch sounds jittery.
                        </p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px]">
                          Index Influence: <span className="font-mono">{rebakeIndexInfluence.toFixed(2)}</span>
                        </Label>
                        <input
                          aria-label="Rebake Index Influence"
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          className="w-full h-8 accent-primary cursor-pointer"
                          value={rebakeIndexInfluence}
                          onChange={(e) => setRebakeIndexInfluence(Number(e.target.value))}
                        />
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Raise (0.75+) for stronger timbre; lower (0.3–0.5) if metallic.
                        </p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px]">
                          Breath Protect: <span className="font-mono">{rebakeConsonantProtection.toFixed(2)}</span>
                        </Label>
                        <input
                          aria-label="Rebake Breath Protect"
                          type="range"
                          min={0}
                          max={0.5}
                          step={0.05}
                          className="w-full h-8 accent-primary cursor-pointer"
                          value={rebakeConsonantProtection}
                          onChange={(e) => setRebakeConsonantProtection(Number(e.target.value))}
                        />
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Raise (0.4–0.5) if consonants smear; lower (0.15–0.25) for deeper blend.
                        </p>
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label className="text-[11px]">Background Denoise</Label>
                        <select
                          aria-label="Rebake Background Denoise"
                          className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                          value={rebakeDenoise}
                          onChange={(e) => setRebakeDenoise(e.target.value as 'off' | 'gentle' | 'strong')}
                        >
                          <option value="off">Off (Clean models — keep untouched)</option>
                          <option value="gentle">Gentle (RNNoise neural speech denoise)</option>
                          <option value="strong">Strong (RNNoise + light FFT for noisy models)</option>
                        </select>
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Use Gentle or Strong if the RVC model adds background hiss or room noise; leave Off for clean models.
                        </p>
                      </div>

                      <div className="space-y-1">
                        <Label className="text-[11px]">
                          Speaking Speed: <span className="font-mono">{rebakeSpeed.toFixed(2)}x</span>
                        </Label>
                        <input
                          aria-label="Rebake Speaking Speed"
                          type="range"
                          min={0.75}
                          max={1.5}
                          step={0.05}
                          className="w-full h-8 accent-primary cursor-pointer"
                          value={rebakeSpeed}
                          onChange={(e) => setRebakeSpeed(Number(e.target.value))}
                        />
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Increase (1.05–1.25x) if the voice speaks too slowly; 1.00x is natural pace.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-[11px]">Sample Line (spoken to clone cadence &amp; dialect)</Label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={generatingSampleLine}
                          onClick={() => void handleGenerateSampleLine(index)}
                        >
                          {generatingSampleLine ? (
                            <>
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <Sparkles className="mr-1 h-3 w-3" />
                              Generate from Profile
                            </>
                          )}
                        </Button>
                      </div>
                      <Textarea
                        rows={2}
                        className="text-xs"
                        value={rebakeSampleText}
                        onChange={(e) => setRebakeSampleText(e.target.value)}
                      />
                    </div>

                    {rebakeError ? <p className="text-destructive">{rebakeError}</p> : null}
                    {rebakeStatus ? <p className="text-emerald-500">{rebakeStatus}</p> : null}

                    {rebakePreviewUrl ? (
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">Sample Preview (not baked yet)</Label>
                        <audio key={rebakePreviewUrl} controls autoPlay src={rebakePreviewUrl} className="w-full h-8" />
                      </div>
                    ) : null}

                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={rebakePreviewing || rebaking}
                        onClick={() => void handlePreviewRebake(index)}
                      >
                        {rebakePreviewing ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Previewing...
                          </>
                        ) : (
                          <>
                            <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                            Preview Sample
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={rebaking || rebakePreviewing}
                        onClick={() => void handleRebakeVoice(index)}
                      >
                        {rebaking ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Rebaking...
                          </>
                        ) : (
                          'Rebake Voice Now'
                        )}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {designerIndex === index ? (
                  <div className="rounded-md border bg-muted/40 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5" />
                        AI Character &amp; Dialect Designer
                      </p>
                      <span className="text-[11px] text-muted-foreground">
                        Describe role, region/origin, and vibe — AI will ask follow-ups &amp; suggest an RVC voice
                      </span>
                    </div>

                    {designReply ? (
                      <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
                        {designReply}
                      </div>
                    ) : null}

                    {designQuestions.length > 0 ? (
                      <div className="space-y-2.5 rounded-md border bg-background/70 p-3">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Quick Follow-Up Details (leave any blank to let AI improvise)
                        </p>
                        {designQuestions.map((q) => (
                          <div key={q.id} className="space-y-1">
                            <Label htmlFor={`dq-${index}-${q.id}`} className="text-xs font-medium">
                              {q.label}
                            </Label>
                            <p className="text-[11px] text-muted-foreground">{q.prompt}</p>
                            <Input
                              id={`dq-${index}-${q.id}`}
                              placeholder={q.placeholder || 'Type your answer...'}
                              value={questionAnswers[q.id] || ''}
                              onChange={(e) =>
                                setQuestionAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                              }
                            />
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <Textarea
                        rows={2}
                        placeholder={
                          designQuestions.length > 0
                            ? 'Optional extra notes, catchphrases, or tweaks...'
                            : "Describe your character (who they are, where they're from, vocal vibe, dialect quirks)..."
                        }
                        value={designInput}
                        onChange={(e) => setDesignInput(e.target.value)}
                      />
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {designMessages.length > 0 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={designLoading}
                            onClick={() => void sendDesignTurn(true)}
                          >
                            Skip &amp; Generate Now
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          disabled={
                            designLoading ||
                            (!designInput.trim() &&
                              !Object.values(questionAnswers).some((v) => v.trim()))
                          }
                          onClick={() => void sendDesignTurn(false)}
                        >
                          {designLoading ? (
                            <>
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              Thinking...
                            </>
                          ) : (
                            <>
                              <Send className="mr-1.5 h-3.5 w-3.5" />
                              {designQuestions.length > 0 ? 'Submit Answers' : 'Continue'}
                            </>
                          )}
                        </Button>
                      </div>
                    </div>

                    {designError ? <p className="text-xs text-destructive">{designError}</p> : null}

                    {designDraft ? (
                      <div className="rounded border bg-background p-3 space-y-2 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-sm">{designDraft.name}</span>
                          <div className="flex items-center gap-2">
                            {designDraft.suggested_rvc_model ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={bakingSuggested}
                                onClick={() => void bakeSuggestedVoice()}
                              >
                                {bakingSuggested ? (
                                  <>
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                    Baking...
                                  </>
                                ) : (
                                  'Bake Suggested Voice'
                                )}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => applyDraftToSpeaker(index)}
                            >
                              Apply to Speaker
                            </Button>
                          </div>
                        </div>
                        <p><span className="font-medium">Voice ID:</span> <span className="font-mono">{designDraft.suggested_voice_id || '—'}</span></p>
                        {designDraft.suggested_rvc_model ? (
                          <p>
                            <span className="font-medium">Suggested RVC:</span>{' '}
                            <span className="font-mono">{designDraft.suggested_rvc_model}</span>
                            {designDraft.suggested_rvc_reason ? ` — ${designDraft.suggested_rvc_reason}` : ''}
                          </p>
                        ) : null}
                        {bakeSuccessMsg ? <p className="text-emerald-500">{bakeSuccessMsg}</p> : null}
                        <p><span className="font-medium">Backstory:</span> {designDraft.backstory}</p>
                        <p><span className="font-medium">Personality &amp; Dialect:</span> {designDraft.personality}</p>
                        {designDraft.suggested_sample_text !== undefined ? (
                          <div className="space-y-1 pt-1">
                            <Label className="text-[11px] font-medium">Voice Baking Sample Line (spoken to clone cadence &amp; attitude)</Label>
                            <Textarea
                              rows={2}
                              className="text-xs"
                              value={designDraft.suggested_sample_text}
                              onChange={(e) =>
                                setDesignDraft((prev) =>
                                  prev ? { ...prev, suggested_sample_text: e.target.value } : prev
                                )
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`speaker-name-${index}`}>{t('common.name')} *</Label>
                    <Input
                      id={`speaker-name-${index}`}
                      {...register(`speakers.${index}.name` as const)}
                      placeholder={t('podcasts.hostPlaceholder', { number: (index + 1).toString() })}
                      autoComplete="off"
                    />
                    {errors.speakers?.[index]?.name ? (
                      <p className="text-xs text-destructive">
                        {errors.speakers[index]?.name?.message}
                      </p>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`speaker-voice-${index}`}>{t('podcasts.voiceId')} *</Label>
                    <Input
                      id={`speaker-voice-${index}`}
                      {...register(`speakers.${index}.voice_id` as const)}
                      placeholder="voice_123"
                      autoComplete="off"
                    />
                    {errors.speakers?.[index]?.voice_id ? (
                      <p className="text-xs text-destructive">
                        {errors.speakers[index]?.voice_id?.message}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`speaker-backstory-${index}`}>{t('podcasts.backstory')} *</Label>
                  <Textarea
                    id={`speaker-backstory-${index}`}
                    rows={3}
                    placeholder={t('podcasts.backstoryPlaceholder')}
                    {...register(`speakers.${index}.backstory` as const)}
                    autoComplete="off"
                  />
                  {errors.speakers?.[index]?.backstory ? (
                    <p className="text-xs text-destructive">
                      {errors.speakers[index]?.backstory?.message}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`speaker-personality-${index}`}>{t('podcasts.personality')} *</Label>
                  <Textarea
                    id={`speaker-personality-${index}`}
                    rows={3}
                    placeholder={t('podcasts.personalityPlaceholder')}
                    {...register(`speakers.${index}.personality` as const)}
                    autoComplete="off"
                  />
                  {errors.speakers?.[index]?.personality ? (
                    <p className="text-xs text-destructive">
                      {errors.speakers[index]?.personality?.message}
                    </p>
                  ) : null}
                </div>
                <Controller
                  control={control}
                  name={`speakers.${index}.voice_model` as const}
                  render={({ field: vmField }) => (
                    <div>
                      <ModelSelector
                        label={t('podcasts.perSpeakerTtsOverride')}
                        modelType="text_to_speech"
                        value={vmField.value ?? ''}
                        onChange={(v) => vmField.onChange(v || null)}
                        placeholder={t('podcasts.useProfileDefault')}
                      />
                    </div>
                  )}
                />
              </div>
            ))}

            {speakersArrayError ? (
              <p className="text-xs text-destructive">{speakersArrayError}</p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={disableSubmit}>
              {isSubmitting
                ? t('common.saving')
                : isEdit
                  ? t('common.saveChanges')
                  : t('podcasts.createProfile')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
