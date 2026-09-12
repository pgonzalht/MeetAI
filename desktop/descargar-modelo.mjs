// Downloads the voice model into desktop/models so it can travel inside the executable.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const REPO = 'onnx-community/whisper-small';
const BASE = `https://huggingface.co/${REPO}/resolve/main`;
const FILES = [
  'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json',
  'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json', 'normalizer.json', 'vocab.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
];

const dest = path.join('models', ...REPO.split('/'));
await mkdir(path.join(dest, 'onnx'), { recursive: true });
for (const f of FILES) {
  const out = path.join(dest, f);
  try {
    const s = await stat(out);
    if (s.size > 0) { console.log('ya está', f); continue; }
  } catch {}
  process.stdout.write('bajando ' + f + ' … ');
  const res = await fetch(`${BASE}/${f}`);
  if (!res.ok) throw new Error(`${f}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  console.log(Math.round(buf.length / 1048576) + ' MB');
}
console.log('modelo listo en', dest);
