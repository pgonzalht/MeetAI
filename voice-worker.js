// Voiceprints: turns a phrase into 256 numbers that describe the voice, so phrases from the
// same person can be grouped. Runs apart from transcription so it never slows it down.
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js'; /* BUILD:LIB */
const MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

// Listen first: a message arriving while the library loads would otherwise be lost.
const waiting = [];
let accept = (m) => waiting.push(m);
self.onmessage = (e) => accept(e.data);

let AutoProcessor, AutoModel, env;
try {
  ({ AutoProcessor, AutoModel, env } = await import(LIB));
} catch (err) {
  postMessage({ type: 'voice-fatal', message: String((err && err.message) || err) });
  throw err;
}
/* BUILD:CONFIG */

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? 2 : 1;

let proc = null;
let model = null;

async function handle(m) {
  if (m.type === 'load') {
    try {
      proc = await AutoProcessor.from_pretrained(MODEL);
      model = await AutoModel.from_pretrained(MODEL, { dtype: 'fp32', device: 'wasm' });
      postMessage({ type: 'voice-ready' });
    } catch (err) {
      postMessage({ type: 'voice-fatal', message: String((err && err.message) || err) });
    }
  } else if (m.type === 'embed') {
    if (!model) return postMessage({ type: 'embedding', id: m.id, emb: null });
    const t0 = performance.now();
    try {
      const out = await model(await proc(m.audio));
      const v = out.last_hidden_state.data;
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
      norm = Math.sqrt(norm) || 1;
      const emb = new Float32Array(v.length);
      for (let i = 0; i < v.length; i++) emb[i] = v[i] / norm;
      postMessage({ type: 'embedding', id: m.id, emb, ms: performance.now() - t0 }, [emb.buffer]);
    } catch (err) {
      postMessage({ type: 'embedding', id: m.id, emb: null, error: String((err && err.message) || err) });
    }
  }
}

let chain = Promise.resolve();
accept = (m) => {
  chain = chain.then(() => handle(m));
};
for (const m of waiting.splice(0)) accept(m);
