const SR = 16000;
const FRAME = 1600; // 100 ms
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// ---------- settings ----------
const DEFAULTS = { model: 'onnx-community/whisper-small', device: 'auto', me: 'Yo', others: 'Otros', echo: true, micId: '' };
const settings = { ...DEFAULTS, ...readJSON('meetai.settings', {}) };
if (params.get('model')) settings.model = params.get('model');
if (params.get('device')) settings.device = params.get('device');

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function saveSettings() {
  try {
    localStorage.setItem('meetai.settings', JSON.stringify(settings));
  } catch {}
}
const nameOf = (src) => (src === 'me' ? settings.me : settings.others) || (src === 'me' ? 'Yo' : 'Otros');

// ---------- sessions (saved in this browser) ----------
let sessions = readJSON('meetai.sessions', []);
let current = null;
let saveTimer = 0;

function newSession(kind, title) {
  const s = { id: Date.now().toString(36), kind, title, start: Date.now(), end: null, items: [] };
  sessions.unshift(s);
  current = s;
  save();
  renderHistory();
  renderAll();
  return s;
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const clean = sessions
      .map((s) => ({ ...s, items: s.items.filter((i) => i.text != null).map(({ audio, session, batch, ...rest }) => rest) }))
      .filter((s) => s.items.length || s === current);
    try {
      localStorage.setItem('meetai.sessions', JSON.stringify(clean));
    } catch {
      notice('warn', 'No queda espacio para guardar en el navegador. Descarga y borra reuniones antiguas.');
    }
  }, 400);
}

// ---------- transcription worker ----------
let worker = null;
let engine = null; // { device, threads } once ready
let inflight = null;
const queue = []; // segments waiting for the engine
const segById = new Map();
let procMs = 0;
let procAudioMs = 0;

function startWorker() {
  worker?.terminate();
  engine = null;
  inflight = null;
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => {
    modelStatus('bad', 'No se pudo iniciar el motor');
    notice('error', 'No se pudo descargar el motor de transcripción (cdn.jsdelivr.net). Comprueba la conexión a internet o si la red de la empresa bloquea esa web. ' + (e.message || ''));
  };
  modelStatus('loading', 'Cargando modelo de voz…');
  worker.postMessage({ type: 'load', model: settings.model, device: settings.device });
  // an in-flight segment from a previous worker goes back to the queue
  for (const s of segById.values()) {
    if (s.status !== 'working') continue;
    s.status = 'pending';
    s.batch = null;
    queue.push(s);
  }
}

function onWorker({ data: m }) {
  if (m.type === 'progress') {
    const mb = (n) => Math.round(n / 1048576);
    modelStatus('loading', `Descargando modelo (solo la primera vez): ${mb(m.loaded)} / ${mb(m.total)} MB`, m.loaded / m.total);
  } else if (m.type === 'status') {
    modelStatus('loading', m.message);
  } else if (m.type === 'warn') {
    console.warn('engine', m);
    log('warn', m);
  } else if (m.type === 'fatal') {
    log('fatal', m);
    modelStatus('bad', m.message);
    notice('error', 'No se pudo cargar el modelo de voz. Comprueba la conexión a internet (solo hace falta la primera vez) y recarga la página. Si estás en la red de la empresa, puede que bloquee huggingface.co.');
  } else if (m.type === 'ready') {
    engine = m;
    const where = m.device === 'webgpu' ? 'tarjeta gráfica' : `procesador, ${m.threads} hilo${m.threads > 1 ? 's' : ''}`;
    modelStatus('ready', `Listo · ${modelName()} · ${where}`);
    log('ready', m);
    pump();
  } else if (m.type === 'result') {
    const seg = segById.get(m.id);
    inflight = null;
    if (seg) finishSegment(seg, m);
    pump();
  }
}

function pump() {
  if (!engine || inflight) return;
  let next = null;
  for (const s of queue) if (!next || s.t0 < next.t0) next = s;
  if (!next) return updateStats();
  // Whisper costs about the same for 2 s as for 28 s of audio, so when phrases are waiting,
  // consecutive ones from the same speaker go together. This is how a slow PC catches up.
  const batch = [next];
  let total = next.dur;
  const later = next.session.items.filter((i) => i.t0 > next.t0).sort((a, b) => a.t0 - b.t0);
  for (const s of later) {
    if (s.src !== next.src || !queue.includes(s) || total + GAP_MS + s.dur > 28000) break;
    batch.push(s);
    total += GAP_MS + s.dur;
  }
  const gap = new Float32Array((GAP_MS / 1000) * SR);
  const audio = new Float32Array(batch.reduce((n, s) => n + s.audio.length, 0) + gap.length * (batch.length - 1));
  let off = 0;
  batch.forEach((s, i) => {
    if (i) off += gap.length;
    audio.set(s.audio, off);
    off += s.audio.length;
    queue.splice(queue.indexOf(s), 1);
    s.status = 'working';
    upsertRow(s);
  });
  next.batch = batch.slice(1);
  next.sentMs = (audio.length / SR) * 1000;
  inflight = next;
  worker.postMessage({ type: 'transcribe', id: next.id, audio }, [audio.buffer]);
  updateStats();
}
const GAP_MS = 400;

function finishSegment(seg, m) {
  for (const s of seg.batch || []) {
    seg.dur = s.t0 + s.dur - seg.t0;
    removeSegment(s);
  }
  seg.batch = null;
  procMs += m.ms;
  procAudioMs += seg.sentMs || seg.dur;
  seg.audio = null;
  seg.status = 'done';
  if (m.error) {
    seg.text = '[no se pudo transcribir este fragmento]';
    seg.error = true;
    console.error(m.error);
  } else {
    seg.text = cleanText(m.text);
  }
  log('result', { src: seg.src, t: fmtTime(seg.t0), dur: Math.round(seg.dur), ms: Math.round(m.ms), text: seg.text });
  if (!seg.text) {
    removeSegment(seg);
  } else {
    checkEcho(seg);
    upsertRow(seg);
  }
  save();
  updateStats();
  maybeAutotestDone();
}

// Whisper sometimes "hears" these stock phrases in noise; they never belong to a meeting.
const JUNK = [
  /subt[ií]tul\w*[^.]*amara\.org[.]?/gi,
  /[^.]*amara\.org[.]?/gi,
  /¡?suscr[ií]bete[^.!]*[.!]?/gi,
  /gracias por ver el v[ií]deo[.!]?/gi,
  /[[(](m[uú]sica|aplausos|risas|silencio)[\])]/gi,
  /♪+/g,
];
function cleanText(t) {
  for (const re of JUNK) t = t.replace(re, ' ');
  t = t.replace(/(.{6,80}?)(?:\s*\1){2,}/g, '$1'); // "a a a a" loops
  return t.replace(/\s+/g, ' ').trim().replace(/^[-–—]\s*/, '').replace(/^[.,…\s-]+$/, '');
}

// ---------- echo (speakers leaking into the mic) ----------
function words(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
}
function isEchoPair(mic, other) {
  if (!(mic.t0 < other.t0 + other.dur + 2000 && other.t0 < mic.t0 + mic.dur + 2000)) return false;
  const a = new Set(words(mic.text));
  if (a.size < 3) return false;
  const b = new Set(words(other.text));
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size >= 0.6;
}
function checkEcho(seg) {
  if (!settings.echo) return;
  const done = seg.session.items.filter((i) => i.text != null && !i.error);
  const pairs = seg.src === 'me' ? done.filter((o) => o.src === 'others').map((o) => [seg, o]) : done.filter((m) => m.src === 'me' && !m.echo).map((m) => [m, seg]);
  for (const [mic, other] of pairs) {
    if (!mic.echo && isEchoPair(mic, other)) {
      mic.echo = true;
      upsertRow(mic);
    }
  }
}

// ---------- voice activity: cuts the audio into phrases ----------
class Segmenter {
  constructor(src) {
    this.src = src;
    this.hist = [];
    this.pre = [];
    this.cur = null;
    this.silent = 0;
    this.level = 0;
  }
  threshold() {
    if (this.hist.length < 20) return 0.003;
    const s = [...this.hist].sort((a, b) => a - b);
    const floor = s[Math.floor(s.length * 0.1)];
    return Math.min(0.05, Math.max(0.002, floor * 2.5));
  }
  push(frame, t) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.level = rms;
    const voiced = rms > this.threshold();
    this.hist.push(rms);
    if (this.hist.length > 150) this.hist.shift();

    if (!this.cur) {
      this.pre.push({ frame, t });
      if (this.pre.length > 3) this.pre.shift();
      if (voiced) {
        this.cur = { frames: this.pre.map((p) => p.frame), t0: this.pre[0].t, voiced: 1 };
        this.pre = [];
        this.silent = 0;
        setSpeaking(this.src, true);
      }
      return;
    }
    this.cur.frames.push(frame);
    if (voiced) {
      this.cur.voiced++;
      this.silent = 0;
    } else {
      this.silent++;
    }
    const n = this.cur.frames.length;
    // phrase ends after 0.7 s of silence; long monologues are cut at the first pause after 10 s, never beyond 25 s
    if (this.silent >= 7 || (n >= 100 && this.silent >= 1) || n >= 250) this.close();
  }
  close() {
    const c = this.cur;
    this.cur = null;
    this.silent = 0;
    setSpeaking(this.src, false);
    if (!c || c.voiced < 2) return;
    const audio = new Float32Array(c.frames.length * FRAME);
    c.frames.forEach((f, i) => audio.set(f, i * FRAME));
    let peak = 0;
    for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
    if (peak > 0 && peak < 0.5) {
      const g = Math.min(20, 0.7 / peak);
      for (let i = 0; i < audio.length; i++) audio[i] *= g;
    }
    addSegment(this.src, c.t0, (audio.length / SR) * 1000, audio);
  }
}

let segCounter = 0;
function addSegment(src, t0, dur, audio) {
  const seg = { id: ++segCounter, src, t0, dur, audio, text: null, status: 'pending', session: current };
  segById.set(seg.id, seg);
  current.items.push(seg);
  queue.push(seg);
  upsertRow(seg);
  pump();
  updateStats();
}
function removeSegment(seg) {
  segById.delete(seg.id);
  seg.session.items.splice(seg.session.items.indexOf(seg), 1);
  rowEl.get(seg)?.remove();
  rowEl.delete(seg);
  updateContinuation();
}

// ---------- capture ----------
let ctx = null;
let ctxWallOffset = 0;
let recording = null; // { kind, nodes: [], worklets: [], streams: [], segs: {me, others} }

async function audioContext() {
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext({ sampleRate: SR });
    await ctx.audioWorklet.addModule('audio-processor.js');
  }
  if (ctx.state === 'suspended') await ctx.resume();
  ctxWallOffset = Date.now() - ctx.currentTime * 1000;
  return ctx;
}

function attach(node, src) {
  const seg = recording.segs[src];
  const worklet = new AudioWorkletNode(ctx, 'capture');
  worklet.port.onmessage = ({ data }) => {
    if (!recording) return;
    seg.push(data.frame, ctxWallOffset + (data.tEnd - FRAME / SR) * 1000);
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(worklet).connect(mute).connect(ctx.destination);
  recording.nodes.push(worklet, mute, node);
  recording.worklets.push(worklet);
}

async function startMeeting(continueCurrent) {
  if (recording) return;
  hideNotice();
  // Screen/audio picker must open straight from the click, before any other prompt.
  let display = null;
  try {
    display = await pickSystemAudio();
  } catch (e) {
    console.warn(e);
  }
  await audioContext();
  if (!continueCurrent || !current) newSession('live', 'Reunión');
  current.end = null;
  recording = { kind: 'live', nodes: [], worklets: [], streams: [], segs: { me: new Segmenter('me'), others: new Segmenter('others') } };

  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: settings.micId ? { exact: settings.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    recording.streams.push(mic);
    attach(ctx.createMediaStreamSource(mic), 'me');
    sourceState('me', 'on', 'Escuchando');
    mic.getAudioTracks()[0].addEventListener('ended', () => sourceState('me', 'off', 'Micrófono desconectado'));
    listMics();
  } catch (e) {
    console.warn(e);
    sourceState('me', 'off', 'Sin permiso de micrófono');
    notice('warn', 'No se pudo usar el micrófono: solo se transcribirá a los demás. Revisa el permiso del micrófono (icono a la izquierda de la dirección web).');
  }
  useDisplay(display);
  setRecordingUI(true);
}

async function pickSystemAudio() {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1, width: { max: 640 }, height: { max: 360 } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    windowAudio: 'system',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  });
}

function useDisplay(display) {
  const track = display?.getAudioTracks()[0];
  if (!track) {
    display?.getTracks().forEach((t) => t.stop());
    sourceState('others', 'off', 'No se está captando');
    $('#btn-share').hidden = false;
    notice(
      'warn',
      'No se está captando el audio de los demás. Pulsa «Compartir audio de la reunión», elige «Toda la pantalla» y activa «Compartir también el audio del sistema».',
      [['Compartir audio de la reunión', shareAgain]]
    );
    return;
  }
  recording.streams.push(display);
  attach(ctx.createMediaStreamSource(new MediaStream([track])), 'others');
  sourceState('others', 'on', 'Escuchando');
  $('#btn-share').hidden = true;
  hideNotice();
  track.addEventListener('ended', () => {
    if (!recording) return;
    recording.segs.others.close();
    sourceState('others', 'off', 'Se dejó de compartir');
    $('#btn-share').hidden = false;
    notice('warn', 'Se ha dejado de compartir el audio del PC: ya no se capta a los demás.', [['Volver a compartir', shareAgain]]);
  });
}

async function shareAgain() {
  if (!recording) return;
  try {
    useDisplay(await pickSystemAudio());
  } catch (e) {
    console.warn(e);
  }
}

// Keeps listening a moment after "Parar" and drains the audio still in the pipeline,
// so the last words of whoever was talking aren't cut off.
function stopRecording() {
  if (!recording || recording.stopping) return;
  const rec = recording;
  rec.stopping = true;
  $('#btn-stop').disabled = true;
  $('#btn-stop').textContent = 'Parando…';
  setTimeout(() => {
    rec.worklets.forEach((w) => w.port.postMessage('flush'));
    setTimeout(() => finalizeRecording(rec), 300);
  }, 1200);
}

function finalizeRecording(rec) {
  for (const s of Object.values(rec.segs)) s.close();
  rec.streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
  rec.nodes.forEach((n) => {
    try {
      n.disconnect();
      n.stop?.();
    } catch {}
  });
  recording = null;
  current.end = Date.now();
  save();
  $('#btn-stop').disabled = false;
  $('#btn-stop').textContent = '■ Parar';
  setRecordingUI(false);
  maybeAutotestDone();
  sourceState('me', '', 'Inactivo');
  sourceState('others', '', 'Inactivo');
}

// Demo: plays a recorded two-voice conversation (left channel = me, right = others)
// through exactly the same pipeline as a real meeting.
async function startDemo() {
  if (recording) return;
  hideNotice();
  await audioContext();
  modelStatusNote('Descargando conversación de ejemplo…');
  const buf = await ctx.decodeAudioData(await (await fetch('demo.wav')).arrayBuffer());
  newSession('demo', 'Conversación de ejemplo');
  recording = { kind: 'demo', nodes: [], worklets: [], streams: [], segs: { me: new Segmenter('me'), others: new Segmenter('others') } };
  const player = ctx.createBufferSource();
  player.buffer = buf;
  const split = ctx.createChannelSplitter(2);
  player.connect(split);
  const left = ctx.createGain();
  const right = ctx.createGain();
  split.connect(left, 0);
  split.connect(right, 1);
  attach(left, 'me');
  attach(right, 'others');
  if (!params.has('autotest')) player.connect(ctx.destination);
  recording.nodes.push(player, split);
  player.onended = () => {
    if (recording?.kind === 'demo') stopRecording();
    maybeAutotestDone();
  };
  ctxWallOffset = Date.now() - ctx.currentTime * 1000;
  player.start();
  sourceState('me', 'on', 'Voz de ejemplo (canal izquierdo)');
  sourceState('others', 'on', 'Voz de ejemplo (canal derecho)');
  setRecordingUI(true);
  modelStatusNote('');
}

// Files: decoded and cut into phrases at full speed (no need to wait the real duration).
async function transcribeFile(file) {
  if (recording) return notice('warn', 'Para transcribir un archivo, primero para la reunión en curso.');
  hideNotice();
  await audioContext();
  let buf;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    return notice('error', 'No se pudo leer ese archivo. Prueba con MP3, WAV, M4A, MP4 o WEBM.');
  }
  const s = newSession('file', file.name);
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  const seg = new Segmenter('others');
  for (let i = 0; i + FRAME <= mono.length; i += FRAME) seg.push(mono.slice(i, i + FRAME), s.start + (i / SR) * 1000);
  seg.close();
  s.end = s.start + buf.duration * 1000;
  save();
  notice('info', `Archivo cargado (${fmtDuration(buf.duration * 1000)}). Se está transcribiendo; mira el contador de abajo.`);
}

// ---------- UI ----------
const rowEl = new Map();

function fmtTime(t) {
  if (current?.kind === 'file' || current?.kind === 'demo') return fmtDuration(t - current.start, true);
  return new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDuration(ms, clock) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (clock) return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + ss;
  return h ? `${h} h ${m} min` : m ? `${m} min ${ss} s` : `${s % 60} s`;
}

function renderAll() {
  const box = $('#transcript');
  box.textContent = '';
  rowEl.clear();
  const items = current ? [...current.items].sort((a, b) => a.t0 - b.t0) : [];
  if (!items.length) {
    box.innerHTML = `<div class="empty">Aquí aparecerá la transcripción.<br><ol>
      <li>Pulsa <b>Empezar reunión</b>.</li>
      <li>En la ventana que se abre elige <b>Toda la pantalla</b> y activa <b>Compartir también el audio del sistema</b>.</li>
      <li>Vuelve a Teams. Esta pestaña sigue funcionando en segundo plano.</li></ol>
      <br>¿Sin reunión a mano? Pulsa <b>Probar con una conversación de ejemplo</b>.</div>`;
    return;
  }
  for (const it of items) box.appendChild(makeRow(it));
  updateContinuation();
}

function makeRow(seg) {
  const row = document.createElement('div');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const text = document.createElement('div');
  text.className = 'text';
  text.addEventListener('input', () => {
    seg.text = text.textContent;
    save();
  });
  row.append(meta, text);
  rowEl.set(seg, row);
  fillRow(seg);
  return row;
}

function fillRow(seg) {
  const row = rowEl.get(seg);
  const [meta, text] = row.children;
  const status = seg.text == null ? 'pending' : '';
  row.className = `row ${seg.src} ${status} ${seg.echo ? 'echo' : ''} ${seg.error ? 'errored' : ''}`;
  row.dataset.t0 = seg.t0;
  meta.innerHTML = `<span class="who"></span> <span class="time"></span>`;
  meta.firstChild.textContent = nameOf(seg.src);
  meta.lastChild.textContent = fmtTime(seg.t0);
  if (seg.text == null) {
    text.textContent = seg.status === 'working' ? 'transcribiendo…' : 'en cola…';
    text.contentEditable = 'false';
  } else if (document.activeElement !== text) {
    text.textContent = seg.text;
    text.contentEditable = 'plaintext-only';
  }
}

function upsertRow(seg) {
  if (!current || !current.items.includes(seg)) return;
  const box = $('#transcript');
  if (rowEl.has(seg)) {
    fillRow(seg);
  } else {
    box.querySelector('.empty')?.remove();
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    const row = makeRow(seg);
    let before = null;
    for (const el of box.children) {
      if (Number(el.dataset.t0) > seg.t0) {
        before = el;
        break;
      }
    }
    box.insertBefore(row, before);
    if (nearBottom && recording) window.scrollTo({ top: document.body.scrollHeight });
  }
  updateContinuation();
}

function updateContinuation() {
  let prev = null;
  for (const [seg, row] of [...rowEl].sort((a, b) => a[0].t0 - b[0].t0)) {
    if (seg.echo) continue;
    row.classList.toggle('cont', !!prev && prev.src === seg.src && seg.t0 - (prev.t0 + prev.dur) < 20000);
    prev = seg;
  }
}

function renderHistory() {
  const sel = $('#history');
  sel.textContent = '';
  const list = sessions.filter((s) => s.items.length || s === current);
  if (!list.length) sel.add(new Option('Reuniones: ninguna', ''));
  for (const s of list) {
    const d = new Date(s.start);
    const label = `${d.toLocaleDateString('es-ES')} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} · ${s.title}`;
    sel.add(new Option(label, s.id, false, s === current));
  }
}

function modelName() {
  return $('#set-model').selectedOptions[0]?.textContent.split(' (')[0] || '';
}
function modelStatus(kind, text, progress) {
  $('#model-status').className = 'pill ' + kind;
  $('#model-text').textContent = text;
  const p = $('#model-progress');
  p.hidden = progress == null;
  if (progress != null) p.value = progress;
}
let noteTimer = 0;
function modelStatusNote(text) {
  clearTimeout(noteTimer);
  if (text) notice('info', text);
  else noteTimer = setTimeout(hideNotice, 10);
}

function notice(kind, text, actions = []) {
  const n = $('#notice');
  n.className = 'show ' + kind;
  $('#notice-text').textContent = text;
  const box = $('#notice-actions');
  box.textContent = '';
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = label;
    b.onclick = fn;
    box.appendChild(b);
  }
}
function hideNotice() {
  $('#notice').className = '';
}

function sourceState(src, cls, text) {
  const el = $('#state-' + src);
  el.className = 'state ' + cls;
  el.textContent = text;
}
function setSpeaking(src, on) {
  if (!recording) return;
  const el = $('#state-' + src);
  if (el.classList.contains('on')) el.textContent = on ? 'Hablando…' : 'Escuchando';
}

function setRecordingUI(on) {
  $('#btn-start').hidden = on;
  $('#btn-demo').hidden = on;
  $('#btn-stop').hidden = !on;
  $('#btn-continue').hidden = on || !current || current.kind !== 'live' || !current.items.length;
  if (!on) $('#btn-share').hidden = true;
  $('#history').disabled = on;
  $('#btn-delete').disabled = on;
  $('#set-model').disabled = $('#set-device').disabled = on;
  updateStats();
}

function updateStats() {
  const pend = current ? current.items.filter((i) => i.text == null) : [];
  const pendMs = pend.reduce((a, s) => a + s.dur, 0);
  const parts = [];
  if (recording) parts.push(`<span class="rec-dot"></span>${recording.kind === 'demo' ? 'Reproduciendo ejemplo' : 'Grabando'} · ${fmtDuration(Date.now() - current.start)}`);
  else if (current?.items.length) parts.push(`${current.items.filter((i) => i.text && !i.echo).length} frases`);
  else parts.push('Sin reunión en curso.');
  if (pend.length) parts.push(`pendiente de transcribir: ${fmtDuration(pendMs)}${engine ? '' : ' (esperando al modelo)'}`);
  if (procMs > 0) parts.push(`velocidad ${(procAudioMs / procMs).toFixed(1).replace('.', ',')}× tiempo real`);
  const echoes = current ? current.items.filter((i) => i.echo).length : 0;
  if (echoes) parts.push(`${echoes} eco${echoes > 1 ? 's' : ''} oculto${echoes > 1 ? 's' : ''} (<a id="toggle-echo">${document.body.classList.contains('show-echo') ? 'ocultar' : 'ver'}</a>)`);
  $('#stats').innerHTML = parts.join(' · ');
  window.meetai?.setPending(pend.length);
  $('#toggle-echo')?.addEventListener('click', () => {
    document.body.classList.toggle('show-echo');
    updateStats();
  });
}

function meters() {
  if (recording) {
    for (const src of ['me', 'others']) {
      const lvl = recording.segs[src].level;
      const db = 20 * Math.log10(lvl + 1e-6);
      $('#meter-' + src).style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
    }
  } else {
    $('#meter-me').style.width = $('#meter-others').style.width = '0';
  }
  requestAnimationFrame(meters);
}

async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const sel = $('#mic');
    sel.length = 1;
    for (const d of devs) sel.add(new Option(d.label, d.deviceId, false, d.deviceId === settings.micId));
  } catch {}
}

// ---------- export ----------
function exportText(s) {
  const lines = [];
  let prev = null;
  for (const it of [...s.items].sort((a, b) => a.t0 - b.t0)) {
    if (it.text == null || it.echo || !it.text.trim()) continue;
    if (prev && prev.src === it.src && it.t0 - (prev.t0 + prev.dur) < 20000) {
      lines[lines.length - 1] += ' ' + it.text.trim();
    } else {
      lines.push(`[${fmtTimeFor(s, it.t0)}] ${nameOf(it.src)}: ${it.text.trim()}`);
    }
    prev = it;
  }
  const d = new Date(s.start);
  const head = `${s.title} — ${d.toLocaleDateString('es-ES')} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` + (s.end ? ` (${fmtDuration(s.end - s.start)})` : '');
  return head + '\n\n' + lines.join('\n\n') + '\n';
}
function fmtTimeFor(s, t) {
  const keep = current;
  current = s;
  const r = fmtTime(t);
  current = keep;
  return r;
}

// ---------- autotest hook (?autotest=demo) used to verify the app headlessly ----------
function log(kind, data) {
  if (params.has('autotest')) console.log('MEETAI ' + kind + ' ' + JSON.stringify(data));
}
function maybeAutotestDone() {
  if (!params.has('autotest') || recording || !current || current.kind !== 'demo') return;
  if (current.items.some((i) => i.text == null)) return;
  log('done', { engine, rtf: +(procAudioMs / procMs).toFixed(2), text: exportText(current) });
}

// ---------- wire up ----------
function init() {
  $('#set-model').value = settings.model;
  $('#set-device').value = settings.device;
  $('#set-me').value = settings.me;
  $('#set-others').value = settings.others;
  $('#set-echo').checked = settings.echo;
  const applyNames = () => {
    document.querySelectorAll('.name-me').forEach((e) => (e.textContent = nameOf('me')));
    document.querySelectorAll('.name-others').forEach((e) => (e.textContent = nameOf('others')));
  };
  applyNames();

  $('#set-model').onchange = $('#set-device').onchange = () => {
    settings.model = $('#set-model').value;
    settings.device = $('#set-device').value;
    saveSettings();
    startWorker();
  };
  $('#set-me').oninput = $('#set-others').oninput = () => {
    settings.me = $('#set-me').value.trim();
    settings.others = $('#set-others').value.trim();
    saveSettings();
    applyNames();
    for (const seg of rowEl.keys()) fillRow(seg);
  };
  $('#set-echo').onchange = () => {
    settings.echo = $('#set-echo').checked;
    saveSettings();
  };
  $('#mic').onchange = () => {
    settings.micId = $('#mic').value;
    saveSettings();
    if (recording?.kind === 'live') notice('info', 'El micrófono nuevo se usará la próxima vez que pulses Empezar o Continuar.');
  };

  $('#btn-start').onclick = () => startMeeting(false);
  $('#btn-continue').onclick = () => startMeeting(true);
  $('#btn-stop').onclick = stopRecording;
  $('#btn-share').onclick = shareAgain;
  $('#btn-demo').onclick = startDemo;
  $('#file').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) transcribeFile(f);
  };
  $('#btn-copy').onclick = async () => {
    if (!current?.items.length) return;
    await navigator.clipboard.writeText(exportText(current));
    notice('info', 'Transcripción copiada. Pégala donde quieras (correo, Word, un chat de IA para resumirla…).');
  };
  $('#btn-download').onclick = () => {
    if (!current?.items.length) return;
    const a = document.createElement('a');
    const d = new Date(current.start);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    a.href = URL.createObjectURL(new Blob([exportText(current)], { type: 'text/plain;charset=utf-8' }));
    a.download = `reunion_${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#history').onchange = () => {
    current = sessions.find((s) => s.id === $('#history').value) || current;
    renderAll();
    setRecordingUI(false);
  };
  $('#btn-delete').onclick = () => {
    if (!current || !confirm('¿Borrar esta reunión de este navegador? No se puede deshacer.')) return;
    sessions = sessions.filter((s) => s !== current);
    current = sessions.find((s) => s.items.length) || null;
    save();
    renderHistory();
    renderAll();
    setRecordingUI(false);
  };
  window.addEventListener('beforeunload', (e) => {
    if (recording || (current && current.items.some((i) => i.text == null))) e.preventDefault();
  });
  setInterval(() => recording && updateStats(), 1000);

  current = sessions.find((s) => s.items.length) || null;
  renderHistory();
  renderAll();
  setRecordingUI(false);
  requestAnimationFrame(meters);
  listMics();
  startWorker();

  if (!navigator.mediaDevices?.getDisplayMedia) {
    notice('error', 'Este navegador no permite captar el audio de la reunión. Abre la página en Microsoft Edge o Google Chrome.');
  }
  if (params.get('autotest') === 'demo') {
    const go = () => (engine ? startDemo() : setTimeout(go, 500));
    go();
  }
}

init();
