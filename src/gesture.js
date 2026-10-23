import * as Tone from 'tone'

const KEY = 'G3'
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] }
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii']
const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

export const STYLES = ['Muted', 'Pad', 'Arpeggio', 'Pulse']
export const HINTS = ['1', '2', '3', '4', '5', 'I+P', 'I+M+P']

// [thumb, index, middle, ring, pinky] -> true when extended
export function fingers(lm) {
  const up = (tip, pip) => d(lm[tip], lm[0]) > d(lm[pip], lm[0])
  return [d(lm[4], lm[17]) > d(lm[3], lm[17]), up(8, 6), up(12, 10), up(16, 14), up(20, 18)]
}

// Left-hand pose -> scale degree 0-6, or -1 for none (fist)
export function degreeFor([t, i, m, r, p]) {
  if (i && p && !m && !r) return 5 // index + pinky
  if (i && m && p && !r) return 6 // index + middle + pinky
  const n = i + m + r + p
  if (n === 4 && t) return 4 // all five
  return n === 0 ? -1 : n - 1
}

export function chordFor(scale, deg) {
  const s = SCALES[scale]
  const semi = (k) => s[k % 7] + 12 * Math.floor(k / 7)
  const notes = [0, 2, 4].map((o) => Tone.Frequency(KEY).transpose(semi(deg + o)).toNote())
  const third = semi(deg + 2) - semi(deg)
  const fifth = semi(deg + 4) - semi(deg)
  const roman = third === 4 ? ROMAN[deg].toUpperCase() : fifth === 6 ? ROMAN[deg] + '°' : ROMAN[deg]
  return { notes, roman, name: notes[0].replace(/\d/, ''), quality: third === 4 ? 'Major' : fifth === 6 ? 'Diminished' : 'Minor' }
}
