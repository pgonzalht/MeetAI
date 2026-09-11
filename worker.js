// Transcription engine (Whisper running locally in the browser). Audio never leaves the PC:
// the only downloads are the library and the model files, once, then they are cached.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;
const threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)) : 1;
env.backends.onnx.wasm.numThreads = threads;

const GEN = { language: 'spanish', task: 'transcribe' };
let asr = null;

async function gpuAdapter() {
  try {
    return navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
  } catch {
    return null;
  }
}

// Weight formats to try per engine, best first. Measured on an i7-13xx laptop: the CPU with
// 8-bit weights is as fast as the integrated GPU and more reliable (fp16 on Intel GPUs garbles text).
async function candidates(device) {
  if (device !== 'webgpu') {
    return {
      gpu: '',
      dtypes: [
        { encoder_model: 'q8', decoder_model_merged: 'q8' },
        { encoder_model: 'q8', decoder_model_merged: 'q4' },
      ],
    };
  }
  const adapter = await gpuAdapter();
  if (!adapter) throw new Error('este navegador no tiene WebGPU activado');
  const gpu = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(' ');
  return { gpu, dtypes: [{ encoder_model: 'fp32', decoder_model_merged: 'q4' }] };
}

async function create(model, device) {
  const { gpu, dtypes } = await candidates(device);
  let lastErr;
  for (const dtype of dtypes) {
    try {
      return { p: await build(model, device, dtype), dtype, gpu };
    } catch (err) {
      console.warn(device, dtype, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

async function build(model, device, dtype) {
  const files = {};
  const p = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (e) => {
      if (e.status !== 'progress' || !e.total) return;
      files[e.file] = [e.loaded, e.total];
      let loaded = 0;
      let total = 0;
      for (const [l, t] of Object.values(files)) {
        loaded += l;
        total += t;
      }
      postMessage({ type: 'progress', loaded, total });
    },
  });

  // Warm-up: compiles/allocates everything so the first real sentence isn't slow.
  postMessage({ type: 'status', message: 'Preparando el motor…' });
  await p(new Float32Array(16000), GEN);
  return p;
}

async function handle(m) {
  if (m.type === 'load') {
    const t = performance.now();
    const order = m.device === 'auto' ? ['wasm', 'webgpu'] : [m.device];
    for (const device of order) {
      try {
        const r = await create(m.model, device);
        asr = r.p;
        postMessage({ type: 'ready', device, threads, dtype: r.dtype, gpu: r.gpu, ms: performance.now() - t });
        return;
      } catch (err) {
        console.warn(device, err);
        postMessage({ type: 'warn', device, message: String(err?.message || err) });
      }
    }
    postMessage({ type: 'fatal', message: 'No se pudo cargar el modelo de voz.' });
  } else if (m.type === 'transcribe') {
    const t = performance.now();
    try {
      const out = await asr(m.audio, GEN);
      postMessage({ type: 'result', id: m.id, text: (out.text || '').trim(), ms: performance.now() - t });
    } catch (err) {
      postMessage({ type: 'result', id: m.id, text: '', error: String(err?.message || err), ms: performance.now() - t });
    }
  }
}

// One job at a time, in arrival order.
let chain = Promise.resolve();
self.onmessage = (e) => {
  chain = chain.then(() => handle(e.data));
};
