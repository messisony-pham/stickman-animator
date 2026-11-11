'use strict';
// Builds the sung vocal for "Last Dance of the Sleepwalker" from a real speech voice.
//
// The game's own vocal is a formant synth, which reads as a pad rather than a person.
// This script bakes an actual voice: every syllable of the lyric is spoken by the
// Windows speech engine, then rebuilt onto its written note by TD-PSOLA, one pitch
// period at a time. Raising the pitch that way leaves the vowel's formants where the
// voice put them, so the singer stays warm instead of turning thin the way plain
// resampling makes it; the vowel is then held to fill its note, while the consonants
// keep their own single, natural articulation. The syllables are placed on the 48-bar
// grid and given a hall to sing in. The result is a normal audio file the game plays
// with the song.
//
//   node scripts/make_last_dance_vocal.cjs
//
// Writes public/last-dance-vocal.mp3 (and a .wav next to it for inspection).
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '_vox');
const OUT = path.join(ROOT, 'public');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const SR = 22050;
const BPM = 126;
const STEP = 60 / BPM / 2;          // one 16th
const BAR = STEP * 16;
const FIRST_BAR = 4;                // the vocal starts after the four-bar intro
const LAST_BAR = 36;                // and ends before the outro
const TRANSPOSE = -17;              // sit the melody in a natural, low singing register

// ------------------------------------------------------------------ the score
// Read the lyric table out of the game itself, so the recording can never drift
// from the notes the song is written on.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scoreSrc = (/var NOVA_PH_A[\s\S]*?var NOVA_PH_LAST = \[.*?\];/.exec(html) || [''])[0];
const linesBlock = (/var NOVA_LYRICS = \[[\s\S]*?\n    \];/.exec(html) || [''])[0];
if (!scoreSrc || !linesBlock) throw new Error('could not find the vocal score in index.html');

const P = {};
new Function('P', scoreSrc +
  ';P.A=NOVA_PH_A;P.B=NOVA_PH_B;P.C=NOVA_PH_C;P.D=NOVA_PH_D;P.CHOR=NOVA_PH_CHOR;' +
  'P.HOOK=NOVA_PH_HOOK;P.E=NOVA_PH_E;P.F=NOVA_PH_F;P.G=NOVA_PH_G;P.BR1=NOVA_PH_BR1;' +
  'P.BR2=NOVA_PH_BR2;P.FIN=NOVA_PH_FIN;P.LAST=NOVA_PH_LAST;')(P);

const lines = [];
const lineRe = /\{ bar: (\d+), +text: [^\n]*,\n        s: \[([^\]]*)\], n: NOVA_PH_(\w+) \}/g;
let m;
while ((m = lineRe.exec(linesBlock))) {
  const s = m[2].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const n = P[m[3]];
  if (!n || n.length !== s.length) throw new Error('score mismatch at bar ' + m[1]);
  lines.push({ bar: +m[1], syllables: s, notes: n });
}
if (!lines.length) throw new Error('no lyric lines parsed');
console.log('score: ' + lines.length + ' lines, ' +
  lines.reduce((a, l) => a + l.syllables.length, 0) + ' syllables');

// ------------------------------------------------------------------ speaking
// One utterance per unique syllable, from the Windows speech engine.
const uniq = [...new Set(lines.flatMap((l) => l.syllables))];
// Two natural takes per syllable: a quick one for short notes and a slow one whose
// vowel is already long, for the notes that are held. Nothing is stretched by DSP —
// a time-stretched consonant is exactly what makes the words stutter.
const safeName = (i, slow) => 's' + i + (slow ? '_slow' : '') + '.wav';
const items = uniq.map((text, i) => ({
  file: path.join(WORK, safeName(i, false)),
  slow: path.join(WORK, safeName(i, true)),
  text, id: i
}));
fs.writeFileSync(path.join(WORK, 'items.json'), JSON.stringify(items, null, 1));

const ps1 = path.join(WORK, 'speak.ps1');
fs.writeFileSync(ps1, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop')
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$items = Get-Content -Raw '${path.join(WORK, 'items.json').split(path.sep).join('/')}' | ConvertFrom-Json
foreach ($it in $items) {
  foreach ($take in @(@{ file = $it.file; rate = 3 }, @{ file = $it.slow; rate = -3 })) {
    if (Test-Path $take.file) { continue }
    try {
      $s.Rate = $take.rate
      $s.SetOutputToWaveFile($take.file, $fmt)
      $s.Speak($it.text)
    } catch {
      Write-Output ("skip " + $it.text + ": " + $_.Exception.Message)
    }
  }
}
$s.SetOutputToNull()
$s.Dispose()
Write-Output 'spoken'
`, 'utf8');
console.log('speaking ' + uniq.length + ' syllables, quick and slow takes...');
cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'inherit' });

// ------------------------------------------------------------------ wav i/o
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav: ' + file);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + size);
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('bad wav: ' + file);
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('unsupported wav format: ' + file);
  const n = Math.floor(data.length / 2 / fmt.channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = data.readInt16LE(i * fmt.channels * 2) / 32768;
    const r = fmt.channels > 1 ? data.readInt16LE((i * fmt.channels + 1) * 2) / 32768 : l;
    out[i] = (l + r) / 2;
  }
  return { data: out, rate: fmt.rate };
}

// Plain resampling, kept only as the fallback for a syllable with no voiced part
// ("sh", a plosive): nothing there to sing, so it is simply moved to the note.
function resample(x, ratio, opts) {
  const out = new Float32Array(Math.ceil(x.length / ratio) + 4);
  let pos = 0, i = 0;
  while (pos < x.length - 1 && i < out.length) {
    const t = i / SR;
    let m = 1;
    if (opts.vibrato) {
      const env = Math.min(1, Math.max(0, (t - 0.05) / 0.16));
      m *= 1 + opts.vibrato * env * Math.sin(2 * Math.PI * 5.15 * t + 0.7);
    }
    if (opts.scoop && t < 0.075) { const k = 1 - t / 0.075; m *= Math.pow(2, (opts.scoop * k) / 12); }
    const ip = Math.floor(pos), f = pos - ip;
    const a = x[ip] || 0, b = x[Math.min(x.length - 1, ip + 1)] || a;
    out[i] = a + (b - a) * f;
    pos += ratio * m;
    i++;
  }
  return out.subarray(0, i);
}

// ------------------------------------------------------------------ the singer
// A spoken syllable has to become a sung note. Resampling it up to the note is what
// makes a machine singer sound thin: the formants — the resonances that make a vowel
// a vowel — are dragged up with the pitch, so the voice turns bright and papery. These
// functions instead rebuild the vowel one pitch period at a time (TD-PSOLA): the
// periods are re-spaced to the note's frequency while each period itself is copied
// untouched, so the pitch moves and the vowel's own timbre stays put. Consonants are
// never rebuilt — they keep their single natural articulation.
function pitchTrack(x, rate) {
  const hop = Math.max(1, Math.round(rate * 0.01));
  const win = Math.round(rate * 0.035);
  const lo = Math.round(rate / 450), hi = Math.round(rate / 75);
  const frames = [];
  for (let p = 0; p + win + hi < x.length; p += hop) {
    let e = 0;
    for (let i = 0; i < win; i += 2) e += x[p + i] * x[p + i];
    e = Math.sqrt(e / (win / 2));
    let best = 0, bestLag = 0;
    for (let lag = lo; lag <= hi; lag++) {
      let s = 0, n1 = 0, n2 = 0;
      for (let i = 0; i < win; i += 4) {
        const a = x[p + i], b = x[p + i + lag];
        s += a * b; n1 += a * a; n2 += b * b;
      }
      const r = n1 > 1e-9 && n2 > 1e-9 ? s / Math.sqrt(n1 * n2) : 0;
      if (r > best) { best = r; bestLag = lag; }
    }
    frames.push({ t: p, e, r: best, period: bestLag });
  }
  return frames;
}

// The vowel: the longest stretch of the syllable that is clearly voiced.
function voicedNucleus(x, rate) {
  const frames = pitchTrack(x, rate);
  if (!frames.length) return null;
  let maxE = 0;
  for (const f of frames) maxE = Math.max(maxE, f.e);
  const on = frames.map((f) => f.r > 0.42 && f.e > 0.1 * maxE);
  let bestA = -1, bestB = -1, a = -1, gap = 0;
  for (let i = 0; i < on.length; i++) {
    if (on[i]) {
      if (a < 0) a = i;
      gap = 0;
      if (bestA < 0 || i - a > bestB - bestA) { bestA = a; bestB = i; }
    } else if (a >= 0 && ++gap > 2) { a = -1; gap = 0; }
  }
  if (bestA < 0) return null;
  const win = Math.round(rate * 0.035);
  const start = frames[bestA].t;
  const end = Math.min(x.length, frames[bestB].t + win);
  // A period for the region: the median over its voiced frames.
  const periods = frames.slice(bestA, bestB + 1).filter((f) => f.period).map((f) => f.period).sort((p, q) => p - q);
  if (!periods.length) return null;
  const period = periods[periods.length >> 1];
  if (end - start < period * 2.5) return null;
  return { start, end, period };
}

// Rebuild the vowel onto the note. outLen is the note's length, so a held note is a
// sustained vowel (never a repeated consonant) and a short note is simply sung faster.
function singNote(x, rate, targetF0, outLen, opts) {
  const nucleus = voicedNucleus(x, rate);
  if (!nucleus) {
    const f0 = medianF0(x, rate);
    const ratio = f0 > 60 ? Math.max(0.55, Math.min(2.2, targetF0 / f0)) : 1;
    const bare = resample(x, ratio, opts);
    return bare.length > outLen ? cropWithFade(bare, outLen) : bare;
  }
  const { start, end, period } = nucleus;
  // Analysis marks: one per pitch period, nudged to the local peak of the waveform so
  // every grain starts at the same point of the glottal cycle.
  const marks = [];
  for (let p = start + Math.round(period / 2); p < end - Math.round(period / 2); p += period) {
    const reach = Math.round(period / 4);
    let bestP = p, bestV = -1;
    for (let q = Math.max(1, p - reach); q <= Math.min(x.length - 2, p + reach); q++) {
      const v = Math.abs(x[q]);
      if (v > bestV) { bestV = v; bestP = q; }
    }
    marks.push(bestP);
  }
  if (marks.length < 3) {
    const f0 = medianF0(x, rate);
    const ratio = f0 > 60 ? Math.max(0.55, Math.min(2.2, targetF0 / f0)) : 1;
    const bare = resample(x, ratio, opts);
    return bare.length > outLen ? cropWithFade(bare, outLen) : bare;
  }
  const P1 = rate / targetF0;
  const onsetLen = start;
  const codaLen = x.length - end;
  const vowelOut = Math.max(P1 * 2, outLen - onsetLen - codaLen);
  const total = Math.ceil(onsetLen + vowelOut + codaLen) + Math.round(period * 2);
  const out = new Float32Array(total);
  const norm = new Float32Array(total);
  // The consonant of the attack, exactly as the voice said it.
  for (let i = 0; i < onsetLen; i++) out[i] += x[i];
  // The vowel: synthesis periods on the note, sampling analysis periods from the voice.
  const span = end - start;
  let t = 0;
  while (t < vowelOut) {
    const sec = t / rate;
    let P = P1;
    if (opts.vibrato) {
      const env = Math.min(1, Math.max(0, (sec - 0.05) / 0.16));
      P *= 1 + opts.vibrato * env * Math.sin(2 * Math.PI * 5.15 * sec + 0.7);
    }
    // A singer does not snap onto a high note: they scoop up into it.
    if (opts.scoop && sec < 0.075) P *= Math.pow(2, (opts.scoop * (1 - sec / 0.075)) / 12);
    const at = start + (vowelOut > 0 ? (t / vowelOut) * span : 0);
    let m = marks[0];
    for (let k = 0; k < marks.length; k++) { if (Math.abs(marks[k] - at) < Math.abs(m - at)) m = marks[k]; }
    const half = Math.round(period);
    const base = onsetLen + Math.round(t);
    // A held note blooms: it is taken a whisper under and swells into the middle, which
    // is how a singer shapes a long line instead of striking every note the same.
    const bloom = 0.94 + 0.06 * Math.sin(Math.PI * Math.min(1, Math.max(0, t / vowelOut)));
    for (let k = -half; k <= half; k++) {
      const oi = base + k;
      if (oi < 0 || oi >= total) continue;
      const si = m + k;
      const v = (si >= start - period && si < end + period) ? (x[si] || 0) : 0;
      const w = 0.5 - 0.5 * Math.cos((Math.PI * (k + half)) / half);
      out[oi] += v * w * bloom;
      norm[oi] += w;
    }
    t += P;
  }
  // Overlap-add weighting: keep the level even, but never amplify a quiet grain.
  for (let i = 0; i < total; i++) if (norm[i] > 0.35) out[i] /= norm[i];
  // The coda ("-ts", "-n", "-s") closes the word, in place, once.
  const codaAt = Math.round(onsetLen + vowelOut);
  for (let i = 0; i < codaLen && codaAt + i < total; i++) out[codaAt + i] += x[end + i];
  const n = Math.min(total, Math.ceil(onsetLen + vowelOut + codaLen));
  const cut = out.subarray(0, n);
  for (let i = 0; i < cut.length; i++) if (!Number.isFinite(cut[i])) cut[i] = 0;
  return cut;
}

// A word that lasts longer than its note: crop it, keeping the attack and the vowel.
// Cropping never repeats a consonant, so the word is heard once, cleanly.
function cropWithFade(x, len) {
  const out = new Float32Array(len);
  const n = Math.min(len, x.length);
  out.set(x.subarray(0, n));
  // A short release only: a long fade eats the word when the note is short.
  const fade = Math.min(n, Math.round(SR * 0.025));
  for (let j = 0; j < fade; j++) out[n - 1 - j] *= j / fade;
  return out;
}

// Cut the silence the speech engine leaves around every word.
function trim(x) {
  const th = 0.012;
  let a = 0, b = x.length - 1;
  while (a < x.length && Math.abs(x[a]) < th) a++;
  while (b > a && Math.abs(x[b]) < th) b--;
  a = Math.max(0, a - Math.round(SR * 0.006));
  b = Math.min(x.length - 1, b + Math.round(SR * 0.01));
  return x.subarray(a, b + 1);
}

// Median f0 of a clip, by autocorrelation over its voiced frames.
function medianF0(x, rate) {
  const frame = Math.round(rate * 0.04);
  const lags = [];
  for (let p = 0; p + frame < x.length; p += Math.round(frame / 2)) {
    let best = 0, bestLag = 0;
    for (let lag = Math.round(rate / 500); lag <= Math.round(rate / 70); lag++) {
      let s = 0;
      for (let i = 0; i < frame; i += 3) s += x[p + i] * x[p + i + lag];
      if (s > best) { best = s; bestLag = lag; }
    }
    if (bestLag) lags.push(rate / bestLag);
  }
  if (!lags.length) return 0;
  lags.sort((a, b) => a - b);
  return lags[Math.floor(lags.length / 2)];
}

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// ------------------------------------------------------------------ singing
const totalLen = Math.round((LAST_BAR - FIRST_BAR) * BAR * SR);
let mix = new Float32Array(totalLen);
let placed = 0, skipped = 0;

lines.forEach((line) => {
  for (let i = 0; i < line.syllables.length; i++) {
    const idx = uniq.indexOf(line.syllables[i]);
    // Note length: to the next note of the line, with the last note held.
    const st = line.notes[i][0];
    const nx = i + 1 < line.notes.length ? line.notes[i + 1][0] : 32;
    const durStep = i + 1 < line.notes.length ? nx - st : Math.min(32 - st, 9);
    const dur = Math.max(1, durStep) * STEP * SR;
    // Choose the take that fits the note: the quick voice for a passing note, the slow
    // one — whose vowel is already long — for a note that is held. Never stretch.
    const takes = [items[idx].file, items[idx].slow]
      .filter((f) => fs.existsSync(f))
      .map((f) => {
        const w = readWav(f);
        return { data: trim(w.data), rate: w.rate };
      })
      .filter((t) => t.data.length >= 200);
    if (!takes.length) { skipped++; continue; }
    const pick = takes.reduce((a, b) =>
      (Math.abs(b.data.length - dur) < Math.abs(a.data.length - dur) ? b : a));
    const data = pick.data;
    const rate = pick.rate;
    // Level every syllable, so a soft word ("lights") sits as high as "The".
    let rms = 0;
    for (let k = 0; k < data.length; k++) rms += data[k] * data[k];
    rms = Math.sqrt(rms / data.length);
    if (rms > 1e-4) {
      const k = Math.min(4.5, 0.12 / rms);
      for (let j = 0; j < data.length; j++) data[j] *= k;
    }
    const target = hz(line.notes[i][1] + TRANSPOSE);
    // A note that is held gets a full, swelling vibrato; a passing note barely any.
    const held = dur > STEP * SR * 2.4;
    // The word is rebuilt onto the note: its pitch rises, its vowel keeps its own
    // resonance, and a held note is a sustained vowel rather than a stretched consonant.
    let clip = singNote(data, rate, target, dur, {
      vibrato: held ? 0.0095 : 0.003,
      scoop: i === 0 ? -1.0 : -0.25
    });
    // Let the word run a little past its note (that is legato), but never into the next
    // syllable's attack. Only a cropped tail is cut — the attack is always original.
    const cap = Math.round(dur * 1.15);
    if (clip.length > cap) clip = cropWithFade(clip, cap);
    // Soft edges so syllables join instead of clicking.
    const fadeIn = Math.min(clip.length, Math.round(SR * 0.012));
    const fadeOut = Math.min(clip.length, Math.round(SR * 0.05));
    for (let j = 0; j < fadeIn; j++) clip[j] *= j / fadeIn;
    for (let j = 0; j < fadeOut; j++) clip[clip.length - 1 - j] *= j / fadeOut;
    const at = Math.round(((line.bar - FIRST_BAR) * BAR + (st * STEP)) * SR);
    for (let j = 0; j < clip.length && at + j < mix.length; j++) mix[at + j] += clip[j];
    placed++;
  }
});
console.log('placed ' + placed + ' syllables (' + skipped + ' skipped)');

// A quiet breath before the first word of every line: the sound of a person about to
// sing, which is most of what separates a sung line from recited words.
(function breaths() {
  for (const line of lines) {
    const at = Math.round((line.bar - FIRST_BAR) * BAR * SR);
    const len = Math.round(SR * 0.17);
    const from = at - len;
    if (from < 0) continue;
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.sin((Math.PI * i) / len);
      const n = (Math.random() * 2 - 1) * env * env * 0.02;
      lp = lp * 0.86 + n * 0.14;
      mix[from + i] += (n - lp) * 0.9;
    }
  }
})();

// Never let a bad sample poison the file: anything non-finite becomes silence.
for (let i = 0; i < mix.length; i++) if (!Number.isFinite(mix[i])) mix[i] = 0;

// Normalise, then a touch of presence so it cuts through the band.
let peak = 0;
for (let i = 0; i < mix.length; i++) peak = Math.max(peak, Math.abs(mix[i]));
const gain = peak > 0 ? 0.85 / peak : 1;
for (let i = 0; i < mix.length; i++) mix[i] *= gain;
// Presence: a gentle lift through 2-4 kHz so the words cut through the band
// without having to play the voice over it.
(function presence() {
  let lp = 0;
  const a = Math.exp((-2 * Math.PI * 1800) / SR);
  for (let i = 0; i < mix.length; i++) {
    lp = a * lp + (1 - a) * mix[i];
    mix[i] = mix[i] + (mix[i] - lp) * 0.26;
  }
})();
// Warmth: a little weight under 250 Hz gives the voice a chest instead of leaving it
// bright and papery — the difference between a person and a loudspeaker.
(function warmth() {
  let lp = 0;
  const a = Math.exp((-2 * Math.PI * 240) / SR);
  for (let i = 0; i < mix.length; i++) {
    lp = a * lp + (1 - a) * mix[i];
    mix[i] += lp * 0.32;
  }
})();
// A small hall, so the voice sits in the room with the band instead of being pressed
// against the listener's ear. Four comb filters and two allpasses: short, cheap, and
// enough to give a held note an afterglow.
(function hall() {
  const tail = Math.round(SR * 1.8);
  const dry = mix;
  const wet = new Float32Array(dry.length + tail);
  const combs = [0.0297, 0.0331, 0.0371, 0.0411].map((s) => {
    const d = Math.round(s * SR);
    return { d, buf: new Float32Array(d), i: 0, lp: 0 };
  });
  const aps = [0.005, 0.0017].map((s) => {
    const d = Math.round(s * SR);
    return { d, buf: new Float32Array(d), i: 0 };
  });
  for (let n = 0; n < wet.length; n++) {
    const input = n < dry.length ? dry[n] : 0;
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * 0.75 + c.lp * 0.25;
      c.buf[c.i] = input + c.lp * 0.86;
      c.i = (c.i + 1) % c.d;
      acc += y;
    }
    acc *= 0.25;
    for (const a of aps) {
      const y = a.buf[a.i];
      const outv = y - acc;
      a.buf[a.i] = acc + y * 0.5;
      a.i = (a.i + 1) % a.d;
      acc = outv;
    }
    wet[n] = (n < dry.length ? dry[n] : 0) + acc * 0.3;
  }
  mix = wet;
})();

// The shelf can lift the peak, so tame the file to a safe ceiling just below full scale.
let peak2 = 0;
for (let i = 0; i < mix.length; i++) peak2 = Math.max(peak2, Math.abs(mix[i]));
if (peak2 > 0.9) { const k = 0.9 / peak2; for (let i = 0; i < mix.length; i++) mix[i] *= k; }

// ------------------------------------------------------------------ output
function writeWav(file, data) {
  const n = data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
const wavPath = path.join(WORK, 'last-dance-vocal.wav');
writeWav(wavPath, mix);
console.log('wrote ' + wavPath + ' (' + (fs.statSync(wavPath).size / 1024 / 1024).toFixed(2) + ' MB)');

// MP3 so the page does not have to carry a 5 MB wav.
try {
  // lamejs expects these on the global object when it runs under Node.
  global.MPEGMode = require('lamejs/src/js/MPEGMode.js');
  global.Lame = require('lamejs/src/js/Lame.js');
  global.BitStream = require('lamejs/src/js/BitStream.js');
  const lamejs = require('lamejs');
  const Mp3Encoder = lamejs.Mp3Encoder;
  const enc = new Mp3Encoder(1, SR, 64);
  const pcm = new Int16Array(mix.length);
  for (let i = 0; i < mix.length; i++) pcm[i] = Math.max(-32767, Math.min(32767, Math.round(mix[i] * 32767)));
  const chunks = [];
  const block = 1152;
  for (let i = 0; i < pcm.length; i += block) {
    const b = enc.encodeBuffer(pcm.subarray(i, Math.min(pcm.length, i + block)));
    if (b.length) chunks.push(Buffer.from(b));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  const mp3Path = path.join(OUT, 'last-dance-vocal.mp3');
  fs.writeFileSync(mp3Path, Buffer.concat(chunks));
  console.log('wrote ' + mp3Path + ' (' + (fs.statSync(mp3Path).size / 1024).toFixed(0) + ' KB)');
} catch (e) {
  console.log('mp3 encode unavailable (' + e.message + ') — the wav is the deliverable');
}
