import { useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import { chordFor, degreeFor, fingers, HINTS, STYLES } from './gesture.js'

// MediaPipe's browser builds load from the CDN at runtime (the npm packages
// don't bundle cleanly with Vite). Versions are pinned.
const HANDS_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240'
const CAMERA_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js'

const NOTES = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5'] // theremin scale
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
  const [mode, setMode] = useState('gesture') // gesture | theremin
  const [status, setStatus] = useState('idle') // idle | loading | running | error
  const [error, setError] = useState('')
  const [hud, setHud] = useState(EMPTY)

  const publish = (obj) => {
    const t = performance.now()
    if (t - hudT.current > 100) { // ~10 UI updates/sec keeps rendering light
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

  useEffect(() => teardown, []) // stop camera, MediaPipe and audio on unmount

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
    const x = clamp(1 - lm[8].x) // video is mirrored, so flip x
    const y = clamp(lm[8].y)
    const lane = Math.min(NOTES.length - 1, Math.floor(x * NOTES.length))
    const note = NOTES[lane]
    const ratio = dist(lm[4], lm[8]) / dist(lm[0], lm[9]) // normalised by palm size
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
    // Mirrored view: the hand with the larger raw x is on the screen's left.
    const sorted = [...hands].sort((p, q) => q[0].x - p[0].x)
    const L = hands.length === 2 ? sorted[0] : sorted[0][0].x > 0.5 ? sorted[0] : null
    const R = hands.length === 2 ? sorted[1] : sorted[0][0].x > 0.5 ? null : sorted[0]

    const raw = L ? degreeFor(fingers(L)) : -1
    if (raw === g.cand) g.n++
    else { g.cand = raw; g.n = 1 }
    if (g.n >= 3) g.deg = raw // pose must hold for 3 frames, avoids flicker

    if (L) {
      const tilt = -Math.atan2(L[9].x - L[0].x, L[0].y - L[9].y) * (180 / Math.PI) // + = leaning screen-right
      if (tilt > 25) g.scale = 'minor'
      else if (tilt < 10) g.scale = 'major'
    }
    g.chord = g.deg >= 0 ? chordFor(g.scale, g.deg) : null

    let vol = 0.5
    if (R) {
      const n = fingers(R).slice(1).filter(Boolean).length
      g.style = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3
      vol = 1 - clamp(R[9].y)
    } else g.style = 1 // one-handed play defaults to pad
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
      await Tone.start() // must run inside the click handler
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
    <div className="relative min-h-screen overflow-hidden px-4 py-6">
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-fuchsia-600/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-cyan-500/25 blur-3xl" />

      <main className="relative mx-auto max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <h1 className="bg-gradient-to-r from-cyan-300 via-fuchsia-400 to-violet-400 bg-clip-text text-3xl font-bold text-transparent">
            Hand Synth
          </h1>
          <div className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1 text-sm backdrop-blur-xl">
            {['gesture', 'theremin'].map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`rounded-full px-4 py-1.5 capitalize transition ${mode === m ? 'bg-gradient-to-r from-cyan-400 to-fuchsia-500 text-slate-950' : 'text-slate-300'}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm text-slate-300 backdrop-blur-xl">
          {isG
            ? 'Left hand picks the chord: hold up 1–5 fingers, index + pinky, or index + middle + pinky. Tilt it right for minor, upright for major. Right hand sets the style (1 finger pad, 2 arpeggio, 3+ pulse, fist mute) and its height sets the volume.'
            : 'Move your hand left and right to change notes. Raise it for a brighter, louder sound. Pinch your thumb and index finger to play, and open them to release.'}
        </div>

        <section className="relative mt-4 aspect-[4/3] overflow-hidden rounded-3xl border border-white/10 bg-black/40 shadow-[0_0_60px_-15px_rgba(217,70,239,0.5)]">
          <video ref={videoRef} playsInline muted className="pointer-events-none absolute h-px w-px opacity-0" />
          <canvas ref={canvasRef} width={640} height={480} className="h-full w-full -scale-x-100 object-cover" />

          {running && isG && (
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
              <div className="flex items-start justify-between text-xs">
                <span className="rounded-full bg-black/50 px-3 py-1">G {hud.scale}</span>
                <div className="w-28 rounded-xl bg-black/50 px-3 py-1.5">
                  <div>{STYLES[hud.style]}</div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/15">
                    <div className="h-full bg-gradient-to-r from-cyan-400 to-fuchsia-500" style={{ width: `${hud.vol * 100}%` }} />
                  </div>
                </div>
              </div>
              <div className="text-center">
                <div className="text-7xl font-bold text-cyan-300 drop-shadow-[0_0_20px_rgba(34,211,238,0.8)]">{hud.roman || '–'}</div>
                <div className="text-sm text-white/80">{hud.name ? `${hud.name} ${hud.quality}` : 'Show a left-hand pose'}</div>
              </div>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => {
                  const c = chordFor(hud.scale, i)
                  return (
                    <div key={i} className={`flex-1 rounded-lg border px-1 py-1.5 text-center ${hud.deg === i ? 'border-fuchsia-400 bg-fuchsia-500/30 text-white' : 'border-white/10 bg-black/50 text-slate-300'}`}>
                      <div className="text-sm font-semibold">{c.name}</div>
                      <div className="text-[10px]">{c.roman}</div>
                      <div className="text-[9px] text-slate-400">{HINTS[i]}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {running && !isG && (
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
              <div className="m-3 self-start rounded-full bg-black/50 px-3 py-1 font-mono text-xs">
                {hud.tracking ? `${hud.note} · ${hud.freq.toFixed(1)} Hz · x ${hud.x.toFixed(2)} y ${hud.y.toFixed(2)}` : 'Show your hand'}
              </div>
              <div className="flex h-1/3">
                {NOTES.map((n, i) => (
                  <div key={i} className={`flex flex-1 items-end justify-center border-l border-white/10 pb-2 text-xs ${hud.lane === i ? (hud.playing ? 'bg-fuchsia-500/30 text-white' : 'bg-cyan-400/15 text-cyan-200') : 'text-white/40'}`}>
                    {n}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!running && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/40 p-6 text-center">
              {status === 'loading' ? (
                <p className="text-slate-300">Loading hand tracking and starting the camera…</p>
              ) : (
                <>
                  {error && <p className="max-w-sm text-sm text-rose-300">{error}</p>}
                  <button
                    onClick={start}
                    className="rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-8 py-3 font-semibold text-slate-950 shadow-[0_0_30px_rgba(217,70,239,0.6)] transition hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                  >
                    {status === 'error' ? 'Try again' : 'Start audio and camera'}
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
