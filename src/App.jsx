import { useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { chordFor, degreeFor, fingers, HINTS, STYLES } from './gesture.js'

// MediaPipe's browser builds load from the CDN at runtime
const HANDS_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240'
const CAMERA_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js'

const NOTES = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5']
const PINCH_ON = 0.3
const PINCH_OFF = 0.45
const ARP = [0, 1, 2, 1]
const EMPTY = { tracking: false, note: '–', freq: 0, x: 0, y: 0, lane: -1, playing: false, scale: 'major', deg: -1, roman: '', name: '', quality: '', style: 1, vol: 0 }

const clamp = (v) => Math.min(1, Math.max(0, v))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing?.dataset.loaded) return resolve()
    const el = existing || Object.assign(document.createElement('script'), { src, crossOrigin: 'anonymous' })
    el.addEventListener('load', () => { el.dataset.loaded = '1'; resolve() })
    el.addEventListener('error', () => reject(new Error('Could not load MediaPipe from the CDN. Check your connection.')))
    if (!existing) document.head.appendChild(el)
  })
}

function buildAudio() {
  const reverb = new Tone.Reverb({ decay: 4, wet: 0.5 }).toDestination()
  const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.35, wet: 0.25 }).connect(reverb)
  const filter = new Tone.Filter(3000, 'lowpass').connect(delay)
  const synth = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.3, decay: 0.2, sustain: 0.8, release: 2 },
    portamento: 0.08,
  }).connect(filter)
  const poly = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.25, decay: 0.3, sustain: 0.7, release: 1.5 },
  }).connect(filter)
  poly.maxPolyphony = 8
  synth.volume.value = -30
  poly.volume.value = -14

  const g = { scale: 'major', cand: -1, n: 0, deg: -1, style: 1, chord: null, held: null, heldKey: '', step: 0 }
  const loop = new Tone.Loop((time) => {
    if (!g.chord) return
    if (g.style === 2) poly.triggerAttackRelease(g.chord.notes[ARP[g.step++ % 4]], '8n', time)
    else if (g.style === 3 && g.step++ % 2 === 0) poly.triggerAttackRelease(g.chord.notes, '4n', time)
  }, '8n').start(0)
  Tone.getTransport().bpm.value = 100
  Tone.getTransport().start()

  return { synth, poly, filter, g, pinched: false, note: null, nodes: [loop, synth, poly, filter, delay, reverb] }
}

export default function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const handsRef = useRef(null)
  const cameraRef = useRef(null)
  const audioRef = useRef(null)
  const modeRef = useRef('gesture')
  const hudT = useRef(0)
  const [mode, setMode] = useState('gesture')
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [hud, setHud] = useState(EMPTY)

  const publish = (obj) => {
    const t = performance.now()
    if (t - hudT.current > 100) {
      hudT.current = t
      setHud(obj)
    }
  }

  const release = () => {
    const a = audioRef.current
    if (a?.pinched) { a.synth.triggerRelease(); a.pinched = false }
  }

  const silence = () => {
    const a = audioRef.current
    if (!a) return
    release()
    a.poly.releaseAll()
    Object.assign(a.g, { cand: -1, n: 0, deg: -1, chord: null, held: null, heldKey: '' })
  }

  const switchMode = (m) => {
    silence()
    modeRef.current = m
    setMode(m)
    setHud(EMPTY)
    audioRef.current?.filter.frequency.rampTo(m === 'gesture' ? 3000 : 1200, 0.1)
  }

  const teardown = () => {
    cameraRef.current?.stop()
    cameraRef.current = null
    handsRef.current?.close()
    handsRef.current = null
    videoRef.current?.srcObject?.getTracks().forEach((t) => t.stop())
    const a = audioRef.current
    audioRef.current = null
    if (a) {
      a.synth.triggerRelease()
      a.poly.releaseAll()
      Tone.getTransport().stop()
      Tone.getTransport().cancel()
      a.nodes.forEach((n) => n.dispose())
    }
  }

  useEffect(() => teardown, [])

  const draw = (ctx, lm, w, h, pinchLine) => {
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(34,211,238,0.9)'
    ctx.beginPath()
    for (const [i, j] of window.HAND_CONNECTIONS) {
      ctx.moveTo(lm[i].x * w, lm[i].y * h)
      ctx.lineTo(lm[j].x * w, lm[j].y * h)
    }
    ctx.stroke()
    ctx.fillStyle = '#e879f9'
    for (const p of lm) {
      ctx.beginPath()
      ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2)
      ctx.fill()
    }
    if (pinchLine) {
      ctx.strokeStyle = pinchLine === 'on' ? '#facc15' : 'rgba(255,255,255,0.5)'
      ctx.beginPath()
      ctx.moveTo(lm[4].x * w, lm[4].y * h)
      ctx.lineTo(lm[8].x * w, lm[8].y * h)
      ctx.stroke()
    }
  }

  const theremin = (a, lm) => {
    const x = clamp(1 - lm[8].x)
    const y = clamp(lm[8].y)
    const lane = Math.min(NOTES.length - 1, Math.floor(x * NOTES.length))
    const note = NOTES[lane]
    const ratio = dist(lm[4], lm[8]) / dist(lm[0], lm[9])
    const level = 1 - y
    a.filter.frequency.rampTo(200 * Math.pow(30, level), 0.05)
    a.synth.volume.rampTo(-30 + level * 24, 0.05)
    if (!a.pinched && ratio < PINCH_ON) { a.pinched = true; a.note = note; a.synth.triggerAttack(note) }
    else if (a.pinched && ratio > PINCH_OFF) release()
    else if (a.pinched && note !== a.note) { a.note = note; a.synth.setNote(note) }
    return { ...EMPTY, tracking: true, note, freq: Tone.Frequency(note).toFrequency(), x, y, lane, playing: a.pinched }
  }

  const gesture = (a, hands) => {
    const g = a.g
    const sorted = [...hands].sort((p, q) => q[0].x - p[0].x)
    const L = hands.length === 2 ? sorted[0] : sorted[0][0].x > 0.5 ? sorted[0] : null
    const R = hands.length === 2 ? sorted[1] : sorted[0][0].x > 0.5 ? null : sorted[0]

    const raw = L ? degreeFor(fingers(L)) : -1
    if (raw === g.cand) g.n++
    else { g.cand = raw; g.n = 1 }
    if (g.n >= 3) g.deg = raw

    if (L) {
      const tilt = -Math.atan2(L[9].x - L[0].x, L[0].y - L[9].y) * (180 / Math.PI)
      if (tilt > 25) g.scale = 'minor'
      else if (tilt < 10) g.scale = 'major'
    }
    g.chord = g.deg >= 0 ? chordFor(g.scale, g.deg) : null

    let vol = 0.5
    if (R) {
      const n = fingers(R).slice(1).filter(Boolean).length
      g.style = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3
      vol = 1 - clamp(R[9].y)
    } else g.style = 1
    a.poly.volume.rampTo(-30 + vol * 22, 0.1)

    const want = g.style === 1 && g.chord ? g.chord.notes : null
    const key = want ? want.join() : ''
    if (key !== g.heldKey) {
      if (g.held) a.poly.triggerRelease(g.held)
      if (want) a.poly.triggerAttack(want)
      g.held = want
      g.heldKey = key
    }
    const c = g.chord
    return { ...EMPTY, tracking: true, scale: g.scale, deg: c ? g.deg : -1, roman: c?.roman ?? '', name: c?.name ?? '', quality: c?.quality ?? '', style: g.style, vol }
  }

  const onResults = (r) => {
    const a = audioRef.current
    const cv = canvasRef.current
    if (!a || !cv) return
    const ctx = cv.getContext('2d')
    const { width: w, height: h } = cv
    ctx.drawImage(r.image, 0, 0, w, h)

    const hands = r.multiHandLandmarks || []
    const isG = modeRef.current === 'gesture'
    if (!hands.length) {
      silence()
      publish({ ...EMPTY, scale: a.g.scale })
      return
    }
    const used = isG ? hands : [hands[0]]
    used.forEach((lm) => draw(ctx, lm, w, h, !isG && (a.pinched ? 'on' : 'off')))
    publish(isG ? gesture(a, hands) : theremin(a, hands[0]))
  }

  const start = async () => {
    teardown()
    setError('')
    setStatus('loading')
    try {
      await Tone.start()
      audioRef.current = buildAudio()
      await Promise.all([loadScript(`${HANDS_URL}/hands.js`), loadScript(CAMERA_URL)])

      const hands = new window.Hands({ locateFile: (f) => `${HANDS_URL}/${f}` })
      hands.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 })
      hands.onResults(onResults)
      handsRef.current = hands

      const camera = new window.Camera(videoRef.current, {
        onFrame: () => hands.send({ image: videoRef.current }),
        width: 640,
        height: 480,
      })
      cameraRef.current = camera
      await camera.start()
      audioRef.current.filter.frequency.value = modeRef.current === 'gesture' ? 3000 : 1200
      setStatus('running')
    } catch (e) {
      teardown()
      setHud(EMPTY)
      setStatus('error')
      setError(
        e?.name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera in your browser, then try again.'
        : e?.name === 'NotFoundError' ? 'No camera was found on this device.'
        : e?.message || 'Something went wrong starting the camera.'
      )
    }
  }

  const running = status === 'running'
  const isG = mode === 'gesture'

  return (
    <div className="relative min-h-screen overflow-hidden px-4 py-8 antialiased selection:bg-slate-700 selection:text-white">
      {/* Subtle ambient lighting blobs */}
      <div className="pointer-events-none absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-indigo-950/20 blur-[120px] animate-float-slow" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-[32rem] w-[32rem] rounded-full bg-slate-900/30 blur-[120px] animate-float-reverse" />

      <main className="relative mx-auto max-w-3xl">
        {/* Header Navigation */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 class="text-2xl sm:text-3xl font-extrabold font-display tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-500/45 via-fuchsia-600/40 to-violet-400">
              Gesture Synth
           </h1>
            <p className="text-xs font-medium text-slate-400 mt-0.5">Spatial Computer Music Engine</p>
          </div>
          
          {/* Minimal Frosted Tab Switcher */}
          <div className="flex gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1 backdrop-blur-xl">
            {['gesture', 'theremin'].map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`rounded-full px-4 py-1.5 text-xs font-medium capitalize transition-all duration-200 ${
                  mode === m 
                    ? 'bg-white/15 text-white shadow-sm' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Info Banner */}
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-3.5 text-xs font-normal leading-relaxed text-slate-300 backdrop-blur-xl">
          <span className="font-semibold text-slate-200 mr-1.5 uppercase tracking-wider text-[10px] px-2 py-0.5 rounded-md bg-white/10 border border-white/10">Guide</span>
          {isG
            ? 'Left hand picks chord scale & degree (1–5 fingers, tilt right for minor). Right hand controls style (1=Pad, 2=Arpeggio, 3+=Pulse, fist=Mute) and volume altitude.'
            : 'Move hand across X-axis for notes, Y-axis for brightness/volume. Pinch thumb and index tip together to play notes.'}
        </div>

        {/* Main Viewport Box */}
        <section className="relative mt-5 aspect-[4/3] overflow-hidden rounded-[24px] border border-white/10 bg-[#07070c] shadow-2xl backdrop-blur-2xl">
          <video ref={videoRef} playsInline muted className="pointer-events-none absolute h-px w-px opacity-0" />
          <canvas ref={canvasRef} width={640} height={480} className="h-full w-full -scale-x-100 object-cover opacity-90" />

          {/* Gesture Mode HUD Overlay */}
          {running && isG && (
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4 bg-gradient-to-b from-black/40 via-transparent to-black/60">
              <div className="flex items-start justify-between text-xs">
                <span className="rounded-full border border-white/10 bg-black/40 px-3.5 py-1.5 font-medium tracking-wide text-cyan-200 backdrop-blur-md">
                  Key: <strong className="text-white uppercase">G {hud.scale}</strong>
                </span>
                <div className="w-32 rounded-2xl border border-white/10 bg-black/40 px-3.5 py-2 backdrop-blur-md">
                  <div className="text-[11px] font-medium text-slate-300">{STYLES[hud.style]}</div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-cyan-400 transition-all duration-150" style={{ width: `${hud.vol * 100}%` }} />
                  </div>
                </div>
              </div>

              <div className="text-center">
                <div className="font-display text-7xl font-black tracking-tight text-white drop-shadow-md">
                  {hud.roman || '–'}
                </div>
                <div className="text-xs font-medium text-slate-300 mt-1 tracking-wide">
                  {hud.name ? `${hud.name} ${hud.quality}` : 'Show a left-hand pose'}
                </div>
              </div>

              <div className="flex gap-1.5">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => {
                  const c = chordFor(hud.scale, i)
                  const active = hud.deg === i
                  return (
                    <div 
                      key={i} 
                      className={`flex-1 rounded-xl border px-1 py-2 text-center transition-all backdrop-blur-md ${
                        active 
                          ? 'border-white/30 bg-white/15 text-white shadow-sm' 
                          : 'border-white/5 bg-black/40 text-slate-400'
                      }`}
                    >
                      <div className="text-xs font-bold text-slate-200">{c.name}</div>
                      <div className="text-[10px] font-semibold text-cyan-300">{c.roman}</div>
                      <div className="text-[9px] text-slate-500 mt-0.5">{HINTS[i]}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Theremin Mode HUD Overlay */}
          {running && !isG && (
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-b from-black/30 via-transparent to-black/50">
              <div className="m-4 self-start rounded-full border border-white/10 bg-black/40 px-4 py-1.5 font-mono text-xs text-cyan-200 backdrop-blur-md">
                {hud.tracking ? `${hud.note} · ${hud.freq.toFixed(1)} Hz · x ${hud.x.toFixed(2)} y ${hud.y.toFixed(2)}` : 'Show your hand'}
              </div>
              <div className="flex h-1/3">
                {NOTES.map((n, i) => {
                  const active = hud.lane === i
                  return (
                    <div 
                      key={i} 
                      className={`flex flex-1 items-end justify-center border-l border-white/10 pb-3 text-xs font-semibold transition-colors ${
                        active 
                          ? (hud.playing ? 'bg-white/20 text-white border-white/30' : 'bg-white/10 text-cyan-200') 
                          : 'text-white/30 hover:text-white/50'
                      }`}
                    >
                      {n}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Idle / Loading / Error State View */}
          {!running && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[#05050a]/90 p-6 text-center backdrop-blur-xl">
              {status === 'loading' ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                  <p className="text-sm font-medium text-slate-300">Initializing hand tracker & audio engine…</p>
                </div>
              ) : (
                <div className="max-w-sm space-y-4">
                  {error && (
                    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200 leading-relaxed">
                      {error}
                    </div>
                  )}
                  {/* Clean Minimal Action Button */}
                  <button
                    onClick={start}
                    className="group relative inline-flex items-center justify-center rounded-full border border-white/20 bg-white/10 px-7 py-3 text-xs font-semibold uppercase tracking-wider text-white backdrop-blur-md transition-all duration-200 hover:bg-white/20 hover:border-white/30 active:scale-95"
                  >
                    <span>{status === 'error' ? 'Try Again' : 'Start Audio & Camera'}</span>
                  </button>
                  <p className="text-[11px] text-slate-500">Requires camera permissions. Runs 100% locally in your browser.</p>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
