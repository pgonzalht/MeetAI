// Assembles desktop/app/ from the shared web files, pointing them at the copies of the
// libraries and the transcription model that travel inside the executable.
import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('..');
const out = path.resolve('app');
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'vendor', 'ort'), { recursive: true });

for (const f of ['audio-processor.js', 'app.js', 'demo.wav', 'icon-192.png', 'icon-512.png']) {
  await cp(path.join(root, f), path.join(out, f));
}

// index.html: no service worker (the app is already local) and desktop wording
let html = await readFile(path.join(root, 'index.html'), 'utf8');
html = html.replace(/<script>\s*\/\/ Enables multi-threaded[\s\S]*?<\/script>/, '');
html = html.replace(/<link rel="manifest"[^>]*>/, '');
html = html.replace('<body>', '<body class="desktop">');
await writeFile(path.join(out, 'index.html'), html);

async function patch(file, edit) {
  let code = await readFile(path.join(root, file), 'utf8');
  code = code.replace(/^const LIB = .*\/\* BUILD:LIB \*\/$/m, "const LIB = './vendor/transformers.min.js'; /* BUILD:LIB */");
  await writeFile(path.join(out, file), edit(code));
}

// transcription: the bundled model, never cached a second time
await patch('worker.js', (code) =>
  code.replace(
    'env.allowLocalModels = false;',
    ['env.allowLocalModels = true;', "env.localModelPath = '/models/';", "env.backends.onnx.wasm.wasmPaths = '/vendor/ort/';", 'env.useBrowserCache = false;'].join('\n')
  )
);
// voiceprints: the model downloads on first use and then stays cached
for (const f of ['voice-worker.js']) {
  await patch(f, (code) => code.replace('env.allowLocalModels = false;', "env.allowLocalModels = false;\nenv.backends.onnx.wasm.wasmPaths = '/vendor/ort/';"));
}
await patch('acta.js', (code) => code.replace(/^const DOCX = .*\/\* BUILD:DOCX \*\/$/m, "const DOCX = './vendor/docx.mjs'; /* BUILD:DOCX */"));

await cp('node_modules/@huggingface/transformers/dist/transformers.min.js', path.join(out, 'vendor', 'transformers.min.js'));
await cp('node_modules/docx/dist/index.mjs', path.join(out, 'vendor', 'docx.mjs'));
for (const f of await readdir('node_modules/onnxruntime-web/dist')) {
  if (f.startsWith('ort-wasm')) await cp(path.join('node_modules/onnxruntime-web/dist', f), path.join(out, 'vendor', 'ort', f));
}
console.log('app/ listo');
