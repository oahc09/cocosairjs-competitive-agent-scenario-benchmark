// tools/gen-chime.mjs — zero-dependency WAV writer.
// assets/audio/chime.wav : 0.5 s, 44100 Hz, 16-bit mono, 880 Hz sine with
// exponential decay and a 4 ms linear attack (click-free). Plain RIFF/WAVE
// header + PCM data, hand-written.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'assets', 'audio', 'chime.wav');

const SAMPLE_RATE = 44100;
const DURATION = 0.5;
const FREQUENCY = 880;
const DECAY_TAU = 0.11; // exponential decay time constant
const ATTACK = 0.004;

const n = Math.round(SAMPLE_RATE * DURATION); // 22050 samples
const pcm = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  const t = i / SAMPLE_RATE;
  const env = Math.exp(-t / DECAY_TAU) * Math.min(1, t / ATTACK);
  const s = Math.sin(2 * Math.PI * FREQUENCY * t) * env;
  const v = Math.max(-1, Math.min(1, s));
  pcm.writeInt16LE(Math.round(v * 32767), i * 2);
}

const fmt = Buffer.alloc(16);
fmt.writeUInt16LE(1, 0); // audioFormat: PCM
fmt.writeUInt16LE(1, 2); // channels: mono
fmt.writeUInt32LE(SAMPLE_RATE, 4);
fmt.writeUInt32LE(SAMPLE_RATE * 1 * 2, 8); // byteRate = sr * channels * bytesPerSample
fmt.writeUInt16LE(2, 12); // blockAlign
fmt.writeUInt16LE(16, 14); // bitsPerSample

const dataLen = pcm.length;
const riffLen = 4 + (8 + 16) + (8 + dataLen);
const wav = Buffer.alloc(8 + riffLen);
wav.write('RIFF', 0, 'ascii');
wav.writeUInt32LE(riffLen, 4);
wav.write('WAVE', 8, 'ascii');
wav.write('fmt ', 12, 'ascii');
wav.writeUInt32LE(16, 16);
fmt.copy(wav, 20);
wav.write('data', 36, 'ascii');
wav.writeUInt32LE(dataLen, 40);
pcm.copy(wav, 44);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, wav);
console.log(
  `[gen-chime] wrote ${OUT} bytes=${wav.length} (${DURATION}s ${SAMPLE_RATE}Hz 16-bit mono ${FREQUENCY}Hz decaying sine)`
);
