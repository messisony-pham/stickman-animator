'use strict';
// Builds the sung vocal for "Last Dance of the Sleepwalker" from a real speech voice.
//
// The game's own vocal is a formant synth, which reads as a pad rather than a person.
// This script bakes an actual voice: every syllable of the lyric is spoken by the
// Windows speech engine, then pitched onto its written note (resampled to the note's
// frequency) and stretched to the note's length, and the syllables are placed on the
// 48-bar grid. The result is a normal audio file the game plays with the song.
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
const safeName = (s, i) => 's' + i + '.wav';
const items = uniq.map((text, i) => ({ file: path.join(WORK, safeName(text, i)), text, id: i }));
fs.writeFileSync(path.join(WORK, 'items.json'), JSON.stringify(items, null, 1));

const ps1 = path.join(WORK, 'speak.ps1');
fs.writeFileSync(ps1, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop')
$s.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$items = Get-Content -Raw '${path.join(WORK, 'items.json').split(path.sep).join('/')}' | ConvertFrom-Json
foreach ($it in $items) {
  if (Test-Path $it.file) { continue }
  try {
    $s.SetOutputToWaveFile($it.file, $fmt)
    $s.Speak($it.text)
  } catch {
    Write-Output ("skip " + $it.text + ": " + $_.Exception.Message)
  }
}
$s.SetOutputToNull()
$s.Dispose()
Write-Output 'spoken'
`, 'utf8');
console.log('speaking ' + uniq.length + ' syllables...');
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

function resample(x, ratio) {
  const n = Math.max(1, Math.round(x.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p), f = p - i0;
    const a = x[Math.min(x.length - 1, i0)], b = x[Math.min(x.length - 1, i0 + 1)];
    out[i] = a + (b - a) * f;
  }
  return out;
}

// Resample a syllable onto its note, with the two things that turn a spoken
// syllable into a sung one: a scoop up into the pitch, and vibrato that swells
// in over the first fifth of a held note.
function sing(x, ratio, opts) {
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

// A singer holds the vowel. The spoken clip is short, so when a note lasts longer
// than the word, the loudest vowel inside it is looped with a crossfade until the
// note is filled — instead of leaving the rest of the note silent.
function sustain(x, needLen) {
  if (x.length >= needLen) return x;
  // Find the loudest 150 ms window: that is the vowel, not the closing consonant.
  const segLen = Math.round(SR * 0.15);
  let bestAt = 0, bestE = -1;
  const stride = Math.round(SR * 0.01);
  for (let p = 0; p + segLen <= x.length; p += stride) {
    let e = 0;
    for (let i = 0; i < segLen; i += 3) e += x[p + i] * x[p + i];
    if (e > bestE) { bestE = e; bestAt = p; }
  }
  const loop = x.subarray(bestAt, Math.min(x.length, bestAt + segLen));
  const out = new Float32Array(needLen + loop.length);
  out.set(x);
  const fade = Math.round(SR * 0.035);
  let p = x.length;
  while (p < needLen + loop.length) {
    for (let i = 0; i < loop.length; i++) {
      const w = Math.min(1, Math.min(i, loop.length - 1 - i) / fade);
      if (p + i < out.length) out[p + i] += loop[i] * w;
    }
    p += loop.length - fade;
  }
  return out.subarray(0, needLen + loop.length);
}

// Overlap-add time stretch (SOLA): keeps the pitch, changes the length.
function stretch(x, targetLen) {
  if (x.length === 0) return new Float32Array(Math.max(1, targetLen));
  const frame = Math.max(128, Math.round(SR * 0.04)) | 1;
  const hop = Math.round(frame / 2);
  const tol = Math.round(SR * 0.012);
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
  const out = new Float32Array(Math.max(1, targetLen) + frame);
  const acc = new Float32Array(out.length);
  let inPos = 0, outPos = 0;
  while (outPos < targetLen && inPos < x.length) {
    let best = inPos, bestScore = -Infinity;
    for (let d = -tol; d <= tol; d += 2) {
      const p = inPos + d;
      if (p < 0 || p + frame > x.length) continue;
      let score = 0;
      for (let i = 0; i < frame; i += 4) score += x[p + i] * out[outPos + i];
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (x.length - best < frame) best = Math.max(0, x.length - frame);
    for (let i = 0; i < frame; i++) { out[outPos + i] += x[best + i] * win[i]; acc[outPos + i] += win[i]; }
    inPos += Math.round(hop * (x.length / targetLen));
    outPos += hop;
  }
  const res = new Float32Array(Math.max(1, targetLen));
  for (let i = 0; i < res.length; i++) res[i] = acc[i] > 1e-6 ? out[i] / acc[i] : 0;
  return res;
}

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
const mix = new Float32Array(totalLen);
let placed = 0, skipped = 0;

lines.forEach((line) => {
  for (let i = 0; i < line.syllables.length; i++) {
    const idx = uniq.indexOf(line.syllables[i]);
    const file = items[idx].file;
    if (!fs.existsSync(file)) { skipped++; continue; }
    let { data, rate } = readWav(file);
    data = trim(data);
    if (data.length < 200) { skipped++; continue; }
    // Level every syllable, so a soft word ("lights") sits as high as "The".
    let rms = 0;
    for (let k = 0; k < data.length; k++) rms += data[k] * data[k];
    rms = Math.sqrt(rms / data.length);
    if (rms > 1e-4) {
      const k = Math.min(4.5, 0.12 / rms);
      for (let j = 0; j < data.length; j++) data[j] *= k;
    }
    const f0 = medianF0(data, rate);
    const target = hz(line.notes[i][1] + TRANSPOSE);
    let ratio = f0 > 60 ? target / f0 : 1;
    ratio = Math.max(0.55, Math.min(2.2, ratio));
    // Note length: to the next note of the line, with the last note held.
    const st = line.notes[i][0];
    const nx = i + 1 < line.notes.length ? line.notes[i + 1][0] : 32;
    const durStep = i + 1 < line.notes.length ? nx - st : Math.min(32 - st, 9);
    const dur = Math.max(1, durStep) * STEP * SR;
    // A note that is held gets a full, swelling vibrato; a passing note barely any.
    const held = dur > STEP * SR * 2.4;
    let clip = sing(data, ratio, {
      vibrato: held ? 0.0085 : 0.0032,
      scoop: i === 0 ? -1.6 : -0.4
    });
    clip = sustain(clip, Math.round(dur));
    clip = stretch(clip, Math.round(dur));
    // Soft edges so syllables join instead of clicking.
    const fadeIn = Math.min(clip.length, Math.round(SR * 0.02));
    const fadeOut = Math.min(clip.length, Math.round(SR * 0.06));
    for (let j = 0; j < fadeIn; j++) clip[j] *= j / fadeIn;
    for (let j = 0; j < fadeOut; j++) clip[clip.length - 1 - j] *= j / fadeOut;
    const at = Math.round(((line.bar - FIRST_BAR) * BAR + (st * STEP)) * SR);
    for (let j = 0; j < clip.length && at + j < mix.length; j++) mix[at + j] += clip[j];
    placed++;
  }
});
console.log('placed ' + placed + ' syllables (' + skipped + ' skipped)');

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
    mix[i] = mix[i] + (mix[i] - lp) * 0.35;
  }
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
