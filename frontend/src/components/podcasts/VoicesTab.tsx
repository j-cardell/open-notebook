'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Filter, Loader2, Plus, Search, Sparkles, Trash2, Upload, Volume2, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface BakedVoice {
  name: string
  sample_text: string
  size_bytes: number
  speed?: number
}

interface RvcVoiceMeta {
  path: string
  name: string
  gender: string
  ethnicity: string
  category: string
  pitch: string
  energy: string
  timbre: string[]
  accent: string
  description: string
}

const DEFAULT_SAMPLE =
  'Alright, listen close, see? You walk into my joint, you play by my rules. The little guy in the corner? Nobody noticed him, till he took the whole table.'

const BASE_SPEAKERS = ['ryan', 'serena', 'vivian', 'aiden', 'uncle_fu', 'ono_anna', 'sohee', 'eric', 'dylan']

const formatTag = (val: string) => val.replace(/_/g, ' ')

export function VoicesTab() {
  const [baked, setBaked] = useState<BakedVoice[]>([])
  const [rvcModels, setRvcModels] = useState<string[]>([])
  const [rvcCatalog, setRvcCatalog] = useState<RvcVoiceMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [baking, setBaking] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [generatingSample, setGeneratingSample] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [rvcModel, setRvcModel] = useState('')
  const [backend, setBackend] = useState<'higgs' | 'qwentts'>('qwentts')
  const [baseSpeakers, setBaseSpeakers] = useState<string[]>(BASE_SPEAKERS)
  const [baseMode, setBaseMode] = useState<'custom' | 'design'>('custom')
  const [baseSpeaker, setBaseSpeaker] = useState('ryan')
  const [designInstruct, setDesignInstruct] = useState('')
  const [voiceDesignAvailable, setVoiceDesignAvailable] = useState(false)
  const [f0UpKey, setF0UpKey] = useState(0)
  const [pitchAlgo, setPitchAlgo] = useState<'rmvpe' | 'crepe' | 'harvest' | 'pm'>('rmvpe')
  const [indexInfluence, setIndexInfluence] = useState(0.66)
  const [consonantProtection, setConsonantProtection] = useState(0.33)
  const [denoise, setDenoise] = useState<'off' | 'gentle' | 'strong'>('off')
  const [speed, setSpeed] = useState(1.0)
  const [sampleText, setSampleText] = useState(DEFAULT_SAMPLE)
  const [wavFile, setWavFile] = useState<File | null>(null)

  // Library filters
  const [search, setSearch] = useState('')
  const [genderFilter, setGenderFilter] = useState('all')
  const [ethnicityFilter, setEthnicityFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [pitchFilter, setPitchFilter] = useState('all')
  const [energyFilter, setEnergyFilter] = useState('all')
  const [timbreFilter, setTimbreFilter] = useState('all')
  const [accentFilter, setAccentFilter] = useState('all')

  const bakeCardRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/voices')
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      const nextBackend = data.backend === 'higgs' ? 'higgs' : 'qwentts'
      const nextSpeakers: string[] = Array.isArray(data.base_speakers) && data.base_speakers.length > 0
        ? data.base_speakers
        : BASE_SPEAKERS
      setBackend(nextBackend)
      setBaseSpeakers(nextSpeakers)
      setBaseSpeaker((prev) => (nextSpeakers.includes(prev) ? prev : nextSpeakers[0]))
      setBaked(data.baked || [])
      setRvcModels(data.rvc_models || [])
      setRvcCatalog(data.rvc_catalog || [])
      setVoiceDesignAvailable(Boolean(data.voice_design_available))
      if (!rvcModel && data.rvc_models?.length) {
        setRvcModel(data.rvc_models[0])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load voices')
    } finally {
      setLoading(false)
    }
  }, [rvcModel])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filterOptions = useMemo(() => {
    const uniq = (vals: string[]) => Array.from(new Set(vals.filter(Boolean))).sort()
    return {
      genders: uniq(rvcCatalog.map((v) => v.gender)),
      ethnicities: uniq(rvcCatalog.map((v) => v.ethnicity)),
      categories: uniq(rvcCatalog.map((v) => v.category)),
      pitches: uniq(rvcCatalog.map((v) => v.pitch)),
      energies: uniq(rvcCatalog.map((v) => v.energy)),
      timbres: uniq(rvcCatalog.flatMap((v) => v.timbre || [])),
      accents: uniq(rvcCatalog.map((v) => v.accent)),
    }
  }, [rvcCatalog])

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rvcCatalog.filter((v) => {
      if (genderFilter !== 'all' && v.gender !== genderFilter) return false
      if (ethnicityFilter !== 'all' && v.ethnicity !== ethnicityFilter) return false
      if (categoryFilter !== 'all' && v.category !== categoryFilter) return false
      if (pitchFilter !== 'all' && v.pitch !== pitchFilter) return false
      if (energyFilter !== 'all' && v.energy !== energyFilter) return false
      if (timbreFilter !== 'all' && !(v.timbre || []).includes(timbreFilter)) return false
      if (accentFilter !== 'all' && v.accent !== accentFilter) return false
      if (q) {
        const hay = `${v.name} ${v.description} ${v.path} ${v.accent} ${(v.timbre || []).join(' ')} ${v.category}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rvcCatalog, search, genderFilter, ethnicityFilter, categoryFilter, pitchFilter, energyFilter, timbreFilter, accentFilter])

  const selectedMeta = useMemo(
    () => rvcCatalog.find((v) => v.path === rvcModel) || null,
    [rvcCatalog, rvcModel]
  )

  const hasActiveFilters =
    search !== '' ||
    genderFilter !== 'all' ||
    ethnicityFilter !== 'all' ||
    categoryFilter !== 'all' ||
    pitchFilter !== 'all' ||
    energyFilter !== 'all' ||
    timbreFilter !== 'all' ||
    accentFilter !== 'all'

  const clearFilters = () => {
    setSearch('')
    setGenderFilter('all')
    setEthnicityFilter('all')
    setCategoryFilter('all')
    setPitchFilter('all')
    setEnergyFilter('all')
    setTimbreFilter('all')
    setAccentFilter('all')
  }

  const handleSelectFromLibrary = (item: RvcVoiceMeta) => {
    setRvcModel(item.path)
    if (!name.trim()) {
      const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      setName(slug)
    }
    const traits = [item.pitch ? `${item.pitch} pitch` : '', item.energy, ...(item.timbre || [])]
      .filter(Boolean)
      .join(', ')
    const autoInstruct = `${item.gender} ${item.accent || ''} voice, ${traits}. ${item.description || ''}`
      .replace(/\s+/g, ' ')
      .trim()
    setDesignInstruct(autoInstruct)
    bakeCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleGenerateSample = async () => {
    const targetName = selectedMeta?.name || name.trim() || rvcModel
    if (!targetName && !designInstruct.trim()) {
      setError('Select an RVC model, enter a voice name, or write a VoiceDesign instruction first')
      return
    }
    setGeneratingSample(true)
    setError(null)
    try {
      const backstory = selectedMeta
        ? `${formatTag(selectedMeta.category)} voice (${formatTag(selectedMeta.gender)}, ${formatTag(selectedMeta.accent)} accent)`
        : ''
      const personality = selectedMeta
        ? `${selectedMeta.description} Pitch: ${selectedMeta.pitch}, Energy: ${selectedMeta.energy}, Timbre: ${(selectedMeta.timbre || []).join(', ')}.`
        : designInstruct.trim()
      const res = await fetch('/api/speaker-profiles/sample-line', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: targetName, backstory, personality }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      if (data.sample_text) {
        setSampleText(data.sample_text)
      }
      if (data.voicedesign_instruct && (baseMode === 'design' || !designInstruct.trim())) {
        setDesignInstruct(data.voicedesign_instruct)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate reference transcript')
    } finally {
      setGeneratingSample(false)
    }
  }

  const handleUploadPth = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/voices/upload-rvc', { method: 'POST', body: form })
      if (!res.ok) throw new Error(await res.text())
      setStatus(`Uploaded ${file.name}`)
      await refresh()
      setRvcModel(file.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const readWavB64 = async (file: File | null): Promise<string | undefined> => {
    if (!file) return undefined
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  const handlePreviewBake = async () => {
    setPreviewing(true)
    setError(null)
    setStatus(null)
    try {
      const wavB64 = await readWavB64(wavFile)
      const res = await fetch('/api/voices/preview-bake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || 'preview',
          rvc_model: rvcModel,
          base_speaker: baseSpeaker,
          use_voice_design: baseMode === 'design' && !wavFile,
          instruct: baseMode === 'design' && !wavFile ? designInstruct.trim() : undefined,
          f0_up_key: Number(f0UpKey) || 0,
          pitch_algo: pitchAlgo,
          index_influence: indexInfluence,
          consonant_breath_protection: consonantProtection,
          denoise,
          speed,
          sample_text: sampleText.trim() || DEFAULT_SAMPLE,
          wav_b64: wavB64,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const nextUrl = URL.createObjectURL(blob)
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return nextUrl
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed')
    } finally {
      setPreviewing(false)
    }
  }

  const handleBake = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Enter a voice name')
      return
    }
    setBaking(true)
    setError(null)
    setStatus(null)
    try {
      const wavB64 = await readWavB64(wavFile)
      const res = await fetch('/api/voices/bake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          rvc_model: rvcModel,
          base_speaker: baseSpeaker,
          use_voice_design: baseMode === 'design' && !wavFile,
          instruct: baseMode === 'design' && !wavFile ? designInstruct.trim() : undefined,
          f0_up_key: Number(f0UpKey) || 0,
          pitch_algo: pitchAlgo,
          index_influence: indexInfluence,
          consonant_breath_protection: consonantProtection,
          denoise,
          speed,
          sample_text: sampleText.trim() || DEFAULT_SAMPLE,
          wav_b64: wavB64,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setStatus(`Baked voice "${name.trim()}" — use it as Voice ID in Speaker Profiles.`)
      setName('')
      setWavFile(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bake failed')
    } finally {
      setBaking(false)
    }
  }

  const handleDelete = async (voiceName: string) => {
    setError(null)
    const res = await fetch(`/api/voices/${encodeURIComponent(voiceName)}`, { method: 'DELETE' })
    if (!res.ok) {
      setError(await res.text())
      return
    }
    await refresh()
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card ref={bakeCardRef}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Bake Cloned Voice ({backend === 'higgs' ? 'Higgs Audio v3' : 'Qwen3-TTS'} + RVC)
              <Badge variant="secondary" className="ml-auto text-xs font-normal">
                {backend === 'higgs' ? 'Higgs Audio v3' : 'Qwen3-TTS'}
              </Badge>
            </CardTitle>
            <CardDescription>
              Pick an RVC voice from the library below (or upload your own .pth/.wav) to bake a consistent {backend === 'higgs' ? 'Higgs Audio v3' : 'Qwen3-TTS'} voice clone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleBake} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="voice-name">Voice ID Name *</Label>
                <Input
                  id="voice-name"
                  placeholder="e.g. plankton or david_attenborough"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Base {backend === 'higgs' ? 'Higgs Audio v3' : 'Qwen3-TTS'} Generator
                  </Label>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={baseMode === 'custom' ? 'default' : 'outline'}
                      onClick={() => setBaseMode('custom')}
                      disabled={Boolean(wavFile)}
                    >
                      Preset Speaker
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={baseMode === 'design' ? 'default' : 'outline'}
                      onClick={() => setBaseMode('design')}
                      disabled={Boolean(wavFile) || !voiceDesignAvailable}
                      title={voiceDesignAvailable ? 'Generate a base voice from a text description (VoiceDesign)' : 'VoiceDesign GGUF not found in models/'}
                    >
                      VoiceDesign (Describe)
                    </Button>
                  </div>
                </div>

                {baseMode === 'custom' ? (
                  <div className="space-y-2">
                    <div className="grid gap-3 sm:grid-cols-2 items-center">
                      <select
                        id="base-speaker"
                        aria-label="Base TTS Speaker"
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                        value={baseSpeaker}
                        onChange={(e) => setBaseSpeaker(e.target.value)}
                        disabled={Boolean(wavFile)}
                      >
                        {baseSpeakers.map((spk) => (
                          <option key={spk} value={spk}>
                            {spk}
                          </option>
                        ))}
                      </select>
                      <audio
                        key={baseSpeaker}
                        controls
                        preload="none"
                        className="w-full h-9"
                        src={`/api/voices/base/${encodeURIComponent(baseSpeaker)}/preview`}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="design-instruct" className="text-xs">
                      VoiceDesign Instruction (auto-filled when you pick an RVC voice below)
                    </Label>
                    <Textarea
                      id="design-instruct"
                      rows={2}
                      placeholder="e.g. Deep, gravelly middle-aged American male with a calm, cynical late-night radio cadence"
                      value={designInstruct}
                      onChange={(e) => setDesignInstruct(e.target.value)}
                      disabled={Boolean(wavFile)}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="rvc-model">RVC Model (.pth)</Label>
                <select
                  id="rvc-model"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  value={rvcModel}
                  onChange={(e) => setRvcModel(e.target.value)}
                >
                  <option value="">None (use base/WAV as-is)</option>
                  {rvcModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {selectedMeta ? (
                <div className="rounded-md border bg-muted/40 p-2.5 text-xs space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{selectedMeta.name}</span>
                    <span className="text-muted-foreground">
                      {formatTag(selectedMeta.gender)} · {formatTag(selectedMeta.ethnicity)} · {formatTag(selectedMeta.category)}
                    </span>
                  </div>
                  {selectedMeta.description ? (
                    <p className="text-muted-foreground">{selectedMeta.description}</p>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pitch-shift">Pitch Shift (semitones)</Label>
                  <Input
                    id="pitch-shift"
                    type="number"
                    min={-12}
                    max={12}
                    value={f0UpKey}
                    onChange={(e) => setF0UpKey(Number(e.target.value))}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="upload-pth">Upload .pth Model</Label>
                  <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent">
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    <span>{uploading ? 'Uploading...' : 'Choose .pth file'}</span>
                    <input
                      id="upload-pth"
                      type="file"
                      accept=".pth"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void handleUploadPth(f)
                      }}
                    />
                  </label>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="pitch-algo" className="text-xs">Pitch Extractor</Label>
                  <select
                    id="pitch-algo"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                    value={pitchAlgo}
                    onChange={(e) => setPitchAlgo(e.target.value as 'rmvpe' | 'crepe' | 'harvest' | 'pm')}
                  >
                    <option value="rmvpe">RMVPE (Best speech)</option>
                    <option value="crepe">CREPE (Singing / smooth)</option>
                    <option value="harvest">Harvest</option>
                    <option value="pm">PM (Fast)</option>
                  </select>
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    RMVPE is best for speech/accents; try CREPE if pitch sounds jittery.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="index-influence" className="text-xs">
                    Index Influence: <span className="font-mono">{indexInfluence.toFixed(2)}</span>
                  </Label>
                  <input
                    id="index-influence"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    className="w-full h-9 accent-primary cursor-pointer"
                    value={indexInfluence}
                    onChange={(e) => setIndexInfluence(Number(e.target.value))}
                  />
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Raise (0.75+) for stronger character accent/timbre; lower (0.3–0.5) if it sounds metallic or glitchy.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="breath-protect" className="text-xs">
                    Breath Protect: <span className="font-mono">{consonantProtection.toFixed(2)}</span>
                  </Label>
                  <input
                    id="breath-protect"
                    type="range"
                    min={0}
                    max={0.5}
                    step={0.05}
                    className="w-full h-9 accent-primary cursor-pointer"
                    value={consonantProtection}
                    onChange={(e) => setConsonantProtection(Number(e.target.value))}
                  />
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Raise (0.4–0.5) if s/t/p consonants smear or lisp; lower (0.15–0.25) for deeper tone blend.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="denoise-mode" className="text-xs">Background Denoise</Label>
                  <select
                    id="denoise-mode"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                    value={denoise}
                    onChange={(e) => setDenoise(e.target.value as 'off' | 'gentle' | 'strong')}
                  >
                    <option value="off">Off (Clean models — keep untouched)</option>
                    <option value="gentle">Gentle (RNNoise neural speech denoise)</option>
                    <option value="strong">Strong (RNNoise + light FFT for noisy models)</option>
                  </select>
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Use Gentle or Strong if the RVC model adds background hiss or room noise; leave Off for clean models.
                  </p>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="voice-speed" className="text-xs">
                    Speaking Speed: <span className="font-mono">{speed.toFixed(2)}x</span>
                  </Label>
                  <input
                    id="voice-speed"
                    type="range"
                    min={0.75}
                    max={1.5}
                    step={0.05}
                    className="w-full h-9 accent-primary cursor-pointer"
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                  />
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Increase (1.05–1.25x) if the voice speaks too slowly; 1.00x is natural pace.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="upload-wav">Optional Reference WAV (skips {backend === 'higgs' ? 'Higgs' : 'Qwen'} base step)</Label>
                <Input
                  id="upload-wav"
                  type="file"
                  accept=".wav"
                  onChange={(e) => setWavFile(e.target.files?.[0] || null)}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="sample-text">Reference Transcript</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    disabled={generatingSample}
                    onClick={() => void handleGenerateSample()}
                  >
                    {generatingSample ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        Generate for Voice
                      </>
                    )}
                  </Button>
                </div>
                <Textarea
                  id="sample-text"
                  rows={3}
                  value={sampleText}
                  onChange={(e) => setSampleText(e.target.value)}
                />
              </div>

              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              {status ? <p className="text-sm text-emerald-500">{status}</p> : null}

              {previewUrl ? (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Sample Preview (not baked yet)</Label>
                  <audio key={previewUrl} controls autoPlay src={previewUrl} className="w-full h-9" />
                </div>
              ) : null}

              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={previewing || baking}
                  onClick={() => void handlePreviewBake()}
                  className="w-full"
                >
                  {previewing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Previewing...
                    </>
                  ) : (
                    <>
                      <Volume2 className="mr-2 h-4 w-4" />
                      Preview Sample
                    </>
                  )}
                </Button>

                <Button type="submit" disabled={baking || previewing} className="w-full">
                  {baking ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Baking Voice...
                    </>
                  ) : (
                    'Bake & Register Voice'
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Volume2 className="h-4 w-4" />
              Baked Voices ({baked.length})
            </CardTitle>
            <CardDescription>
              Use any voice name below as the <strong>Voice ID *</strong> in your Speaker Profiles.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 max-h-[540px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading voices...
              </div>
            ) : baked.length === 0 ? (
              <p className="text-sm text-muted-foreground">No baked voices yet. Bake one on the left to get started.</p>
            ) : (
              baked.map((v) => (
                <div key={v.name} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-sm font-semibold">{v.name}</p>
                        {v.speed && Math.abs(v.speed - 1) >= 0.01 ? (
                          <Badge variant="secondary" className="text-[10px] font-mono">
                            {v.speed.toFixed(2)}x
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">{v.sample_text}</p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => void handleDelete(v.name)} title="Delete voice">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                  <audio controls preload="none" className="w-full h-8" src={`/api/voices/${encodeURIComponent(v.name)}/preview`} />
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Filter className="h-4 w-4" />
                RVC Voice Library ({filteredCatalog.length} / {rvcCatalog.length})
              </CardTitle>
              <CardDescription>
                Filter by gender, origin, style, pitch, energy, timbre, or accent, then click <strong>Use</strong> to bake it.
              </CardDescription>
            </div>
            {hasActiveFilters ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-3.5 w-3.5" />
                Clear Filters
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative sm:col-span-2 lg:col-span-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search name, timbre, description..."
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <select
              aria-label="Filter by gender"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={genderFilter}
              onChange={(e) => setGenderFilter(e.target.value)}
            >
              <option value="all">Gender: All</option>
              {filterOptions.genders.map((g) => (
                <option key={g} value={g}>
                  Gender: {formatTag(g)}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by origin"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={ethnicityFilter}
              onChange={(e) => setEthnicityFilter(e.target.value)}
            >
              <option value="all">Origin: All</option>
              {filterOptions.ethnicities.map((e) => (
                <option key={e} value={e}>
                  Origin: {formatTag(e)}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by style"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="all">Style: All</option>
              {filterOptions.categories.map((c) => (
                <option key={c} value={c}>
                  Style: {formatTag(c)}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by pitch"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={pitchFilter}
              onChange={(e) => setPitchFilter(e.target.value)}
            >
              <option value="all">Pitch: All</option>
              {filterOptions.pitches.map((p) => (
                <option key={p} value={p}>
                  Pitch: {formatTag(p)}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by energy"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={energyFilter}
              onChange={(e) => setEnergyFilter(e.target.value)}
            >
              <option value="all">Energy: All</option>
              {filterOptions.energies.map((en) => (
                <option key={en} value={en}>
                  Energy: {formatTag(en)}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by timbre"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={timbreFilter}
              onChange={(e) => setTimbreFilter(e.target.value)}
            >
              <option value="all">Timbre: All</option>
              {filterOptions.timbres.map((t) => (
                <option key={t} value={t}>
                  Timbre: {formatTag(t)}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by accent"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={accentFilter}
              onChange={(e) => setAccentFilter(e.target.value)}
            >
              <option value="all">Accent: All</option>
              {filterOptions.accents.map((a) => (
                <option key={a} value={a}>
                  Accent: {formatTag(a)}
                </option>
              ))}
            </select>
          </div>

          <div className="max-h-[540px] overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/95 backdrop-blur border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Voice &amp; Description</th>
                  <th className="p-3">Profile</th>
                  <th className="p-3">Tone &amp; Timbre</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredCatalog.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-muted-foreground">
                      No RVC voices match your current filters.
                    </td>
                  </tr>
                ) : (
                  filteredCatalog.map((v) => {
                    const isSelected = rvcModel === v.path
                    return (
                      <tr key={v.path} className={isSelected ? 'bg-accent/50' : 'hover:bg-muted/30'}>
                        <td className="p-3 align-top max-w-md">
                          <div className="font-medium">{v.name}</div>
                          {v.description ? (
                            <div className="text-xs text-muted-foreground mt-0.5">{v.description}</div>
                          ) : null}
                          <div className="text-[11px] font-mono text-muted-foreground/75 mt-1">{v.path}</div>
                        </td>
                        <td className="p-3 align-top">
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="secondary">{formatTag(v.gender)}</Badge>
                            <Badge variant="outline">{formatTag(v.ethnicity)}</Badge>
                            <Badge variant="outline">{formatTag(v.category)}</Badge>
                            {v.accent ? <Badge variant="outline">{formatTag(v.accent)}</Badge> : null}
                          </div>
                        </td>
                        <td className="p-3 align-top">
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="secondary">{formatTag(v.pitch)} pitch</Badge>
                            <Badge variant="secondary">{formatTag(v.energy)}</Badge>
                            {(v.timbre || []).map((t) => (
                              <Badge key={t} variant="outline">
                                {formatTag(t)}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="p-3 align-top text-right">
                          <Button
                            size="sm"
                            variant={isSelected ? 'default' : 'outline'}
                            onClick={() => handleSelectFromLibrary(v)}
                          >
                            {isSelected ? (
                              <>
                                <Check className="mr-1 h-3.5 w-3.5" />
                                Selected
                              </>
                            ) : (
                              'Use'
                            )}
                          </Button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
