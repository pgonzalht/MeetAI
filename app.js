const SR = 16000;
const FRAME = 1600; // 100 ms
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// ---------- settings ----------
const DEFAULTS = { model: 'onnx-community/whisper-small', device: 'auto', me: 'Yo', others: 'Otros', echo: true, micId: '', voices: true };
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

// ---------- who is speaking ----------
// "Yo" is always the microphone. Everything else arrives mixed in the PC audio, so each phrase
// gets a voiceprint and phrases with similar voices are grouped as the same person.
let voiceBook = readJSON('meetai.voices', []); // voices the user named, remembered across meetings
let voiceFailed = false;
const saveVoices = () => {
  try {
    localStorage.setItem('meetai.voices', JSON.stringify(voiceBook));
  } catch {}
};
const voiceActive = () => settings.voices && !voiceFailed;
const personOf = (seg, s = seg.session || current) => (seg.person && s?.people?.find((p) => p.id === seg.person)) || null;
const speakerName = (seg, s) => (seg.src === 'me' ? nameOf('me') : personOf(seg, s)?.name || nameOf('others'));
const speakerKey = (seg) => (seg.src === 'me' ? 'me' : 'o:' + (seg.person || ''));

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
      .map((s) => ({
        ...s,
        people: (s.people || []).map((p) => ({ ...p, c: p.c ? Array.from(p.c, (x) => Math.round(x * 1e4) / 1e4) : null })),
        items: s.items.filter((i) => i.text != null).map(({ audio, session, batch, emb, ...rest }) => rest),
      }))
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
    const batch = inflight;
    inflight = null;
    if (batch?.id === m.id) finishBatch(batch, m);
    pump();
  }
}

// Whisper costs about the same for 2 s of audio as for 28 s, so every phrase that is waiting,
// whoever said it, goes in a single pass with a pause between phrases, and the text is shared
// back to each phrase by its timestamps. Measured on the demo: 3.3x faster, same words.
const GAP_S = 1.2; // long enough for Whisper to start a new timestamped chunk at each phrase
const WINDOW_S = 28; // Whisper reads up to 30 s at a time
let batchCounter = 0;

function pump() {
  if (!engine || inflight) return;
  const waiting = [...queue].sort((a, b) => a.t0 - b.t0);
  if (!waiting.length) return updateStats();
  const gap = Math.round(GAP_S * SR);
  const segs = [];
  let len = 0;
  for (const s of waiting) {
    const add = (segs.length ? gap : 0) + s.audio.length;
    if (segs.length && len + add > WINDOW_S * SR) break;
    segs.push(s);
    len += add;
  }
  const audio = new Float32Array(len);
  const spans = [];
  let off = 0;
  for (const s of segs) {
    audio.set(s.audio, off);
    spans.push([off / SR, (off + s.audio.length) / SR]);
    off += s.audio.length + gap;
    queue.splice(queue.indexOf(s), 1);
    s.status = 'working';
    upsertRow(s);
  }
  inflight = { id: ++batchCounter, segs, spans, audioMs: (len / SR) * 1000 };
  worker.postMessage({ type: 'transcribe', id: inflight.id, audio, timestamps: segs.length > 1 }, [audio.buffer]);
  updateStats();
}

// Each timestamped chunk's words go to the phrases it overlaps, in proportion to the overlap.
function shareText(batch, m) {
  if (batch.segs.length === 1) return [m.text];
  const out = batch.segs.map(() => []);
  const end = batch.spans[batch.spans.length - 1][1];
  const chunks = m.chunks?.length ? m.chunks : [{ timestamp: [0, end], text: m.text }];
  for (const c of chunks) {
    const from = c.timestamp[0] ?? 0;
    const to = c.timestamp[1] ?? end;
    const words = c.text.trim().split(/ +/).filter(Boolean);
    if (!words.length) continue;
    const shares = batch.spans.map(([a, b]) => Math.max(0, Math.min(to, b) - Math.max(from, a)));
    const total = shares.reduce((x, y) => x + y, 0);
    if (!total) {
      // a chunk that falls in a pause belongs to the nearest phrase
      const mid = (from + to) / 2;
      const dist = batch.spans.map(([a, b]) => Math.abs((a + b) / 2 - mid));
      out[dist.indexOf(Math.min(...dist))].push(...words);
      continue;
    }
    const counts = shares.map((sh) => Math.floor((words.length * sh) / total));
    let left = words.length - counts.reduce((x, y) => x + y, 0);
    const largest = shares.map((sh, i) => [sh, i]).sort((x, y) => y[0] - x[0]);
    for (let k = 0; left > 0; k = (k + 1) % largest.length) {
      if (largest[k][0] > 0) {
        counts[largest[k][1]]++;
        left--;
      }
    }
    let k = 0;
    counts.forEach((n, i) => {
      out[i].push(...words.slice(k, k + n));
      k += n;
    });
  }
  return out.map((w) => w.join(' '));
}

function finishBatch(batch, m) {
  procMs += m.ms;
  procAudioMs += batch.audioMs;
  if (m.error) console.error(m.error);
  const texts = m.error ? [] : shareText(batch, m);
  batch.segs.forEach((seg, i) => {
    if (!segById.has(seg.id)) return;
    seg.audio = null;
    seg.status = 'done';
    if (m.error) {
      seg.text = '[no se pudo transcribir este fragmento]';
      seg.error = true;
    } else {
      seg.text = cleanText(texts[i] || '');
    }
    log('result', { src: seg.src, t: fmtTime(seg.t0), dur: Math.round(seg.dur), ms: Math.round(m.ms / batch.segs.length), text: seg.text });
    if (!seg.text) {
      removeSegment(seg);
    } else {
      checkEcho(seg);
      upsertRow(seg);
    }
  });
  save();
  updateStats();
  maybeAutotestDone();
}

// ---------- voiceprints ----------
let voiceWorker = null;

function startVoice() {
  if (!settings.voices || voiceWorker) return;
  voiceFailed = false;
  voiceWorker = new Worker('voice-worker.js', { type: 'module' });
  voiceWorker.onmessage = onVoice;
  voiceWorker.onerror = () => voiceUnavailable();
  voiceWorker.postMessage({ type: 'load' });
  for (const seg of segById.values()) if (seg.src === 'others' && seg.audio && !seg.person) requestVoiceprint(seg);
}
function stopVoice() {
  voiceWorker?.terminate();
  voiceWorker = null;
  pump();
}
// Without voiceprints everyone in the PC audio is simply "Otros", as before.
function voiceUnavailable() {
  voiceFailed = true;
  voiceWorker?.terminate();
  voiceWorker = null;
  pump();
  maybeAutotestDone();
}
function requestVoiceprint(seg) {
  if (!voiceWorker || !seg.audio) return;
  const audio = seg.audio.slice();
  voiceWorker.postMessage({ type: 'embed', id: seg.id, audio }, [audio.buffer]);
}
function onVoice({ data: m }) {
  if (m.type === 'voice-fatal') return voiceUnavailable();
  if (m.type !== 'embedding') return;
  const seg = segById.get(m.id);
  if (!seg) return;
  seg.voiceDone = true;
  if (m.emb && !seg.manual) {
    seg.emb = m.emb;
    assignPerson(seg);
  }
  upsertRow(seg);
  save();
  pump();
  maybeAutotestDone();
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
// Weighted average of two voiceprints, kept at unit length.
function blend(a, wa, b, wb) {
  if (!a) return b ? Float32Array.from(b) : null;
  if (!b) return Float32Array.from(a);
  const out = new Float32Array(a.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] * wa + b[i] * wb;
    n += out[i] * out[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}
function newPerson(s, name, c) {
  s.people ||= [];
  s.personCounter = (s.personCounter || 0) + 1;
  const num = s.personCounter;
  const p = { id: 'p' + num, num, name: name || `Persona ${num}`, named: !!name, c: c ? Float32Array.from(c) : null, n: c ? 1 : 0 };
  s.people.push(p);
  return p;
}

// Thresholds measured with WeSpeaker: the same voice scores about 0.9 on phrases of several
// seconds and 0.6-0.8 on 1-2 s ones; different voices score about 0.3-0.45.
function assignPerson(seg) {
  const s = seg.session;
  s.people ||= [];
  const long = seg.dur >= 2500;
  let best = null;
  let bestSim = -1;
  for (const p of s.people) {
    if (!p.c) continue;
    const sim = dot(seg.emb, p.c);
    if (sim > bestSim) [best, bestSim] = [p, sim];
  }
  // someone known from a single short phrase is only a rough sketch, so a looser match is enough
  if (best && bestSim >= (long ? (best.weak ? 0.5 : 0.6) : 0.45)) return joinPerson(seg, best, true);
  // a voice the user named in an earlier meeting?
  let known = null;
  let knownSim = -1;
  for (const v of voiceBook) {
    if (s.people.some((p) => p.name.toLowerCase() === v.name.toLowerCase())) continue;
    const sim = dot(seg.emb, v.c);
    if (sim > knownSim) [known, knownSim] = [v, sim];
  }
  if (known && knownSim >= 0.65 && seg.dur >= 1500) return joinPerson(seg, newPerson(s, known.name, known.c), true);
  // Too short to be sure. If it sounds a little like someone, it's a guess revisited when new
  // voices appear; if it sounds like nobody (different voices score about 0.3), it's someone new.
  if (!long && best && bestSim >= 0.35) {
    seg.guess = true;
    return joinPerson(seg, best, false);
  }
  const p = newPerson(s, null, seg.emb);
  p.weak = !long;
  joinPerson(seg, p, false);
  revisitGuesses(s);
}
function joinPerson(seg, p, learn) {
  seg.person = p.id;
  if (learn && seg.emb) {
    p.c = blend(p.c, Math.min(p.n, 20), seg.emb, 1);
    p.n++;
    if (seg.dur >= 2500) p.weak = false;
  }
}
// Short phrases placed by guesswork move to whichever voice they match best now.
function revisitGuesses(s) {
  for (const it of s.items) {
    if (!it.guess || it.manual || !it.emb) continue;
    let best = null;
    let bestSim = -1;
    for (const p of s.people) {
      if (!p.c) continue;
      const sim = dot(it.emb, p.c);
      if (sim > bestSim) [best, bestSim] = [p, sim];
    }
    if (best && best.id !== it.person) {
      it.person = best.id;
      upsertRow(it);
    }
  }
}

function rememberVoice(p) {
  if (!p?.named || !p.c) return;
  const v = voiceBook.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
  if (v) {
    v.c = Array.from(blend(v.c, Math.min(v.n, 20), p.c, Math.min(p.n, 20)), (x) => Math.round(x * 1e4) / 1e4);
    v.n = Math.min(v.n + p.n, 50);
  } else {
    voiceBook.push({ name: p.name, c: Array.from(p.c, (x) => Math.round(x * 1e4) / 1e4), n: p.n });
  }
  saveVoices();
  renderVoiceBook();
}
function refreshRows() {
  for (const seg of rowEl.keys()) fillRow(seg);
  updateContinuation();
  save();
}

function renameSpeaker(seg, s, name) {
  name = name.trim();
  if (!name) return;
  if (seg.src === 'me') {
    settings.me = name;
    $('#set-me').value = name;
    saveSettings();
    applyNames();
    return refreshRows();
  }
  let p = personOf(seg, s);
  if (!p) {
    p = newPerson(s, null, seg.emb);
    seg.person = p.id;
  }
  // giving a group the name of another group means they were the same person all along
  const twin = s.people.find((x) => x !== p && x.name.toLowerCase() === name.toLowerCase());
  if (twin) {
    for (const it of s.items) if (it.person === p.id) it.person = twin.id;
    twin.c = blend(twin.c, Math.max(twin.n, 1), p.c, Math.max(p.n, 1));
    twin.n += p.n;
    s.people.splice(s.people.indexOf(p), 1);
    p = twin;
  } else {
    p.name = name;
  }
  p.named = true;
  rememberVoice(p);
  refreshRows();
}

function moveToPerson(seg, s, target) {
  const from = personOf(seg, s);
  seg.person = target.id;
  seg.manual = true;
  // a correction is strong evidence about how this person sounds
  if (seg.emb) {
    target.c = blend(target.c, Math.min(target.n, 20), seg.emb, 3);
    target.n++;
  }
  if (from && from !== target && !s.items.some((i) => i.person === from.id)) s.people.splice(s.people.indexOf(from), 1);
  rememberVoice(target);
  refreshRows();
}

function openSpeakerMenu(seg, anchor) {
  const s = seg.session || current;
  const menu = $('#speaker-menu');
  menu.textContent = '';
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const person = personOf(seg, s);
  const name = speakerName(seg, s);

  menu.append(el('div', { className: 'menu-label', textContent: seg.src === 'me' ? 'Tu nombre' : `Nombre de «${name}» en toda la reunión` }));
  const form = el('form');
  const input = el('input', { type: 'text', maxLength: 30, value: name });
  form.append(input, el('button', { type: 'submit', className: 'small primary', textContent: 'Guardar' }));
  form.onsubmit = (e) => {
    e.preventDefault();
    menu.hidden = true;
    renameSpeaker(seg, s, input.value);
  };
  menu.append(form);

  if (seg.src === 'others') {
    menu.append(el('div', { className: 'menu-label', textContent: 'Esta frase la dijo otra persona:' }));
    const box = el('div', { className: 'menu-people' });
    for (const p of s.people || []) {
      if (p === person) continue;
      const b = el('button', { type: 'button', className: 'small', textContent: p.name });
      b.onclick = () => {
        menu.hidden = true;
        moveToPerson(seg, s, p);
      };
      box.append(b);
    }
    const add = el('button', { type: 'button', className: 'small', textContent: '+ Persona nueva' });
    add.onclick = () => {
      menu.hidden = true;
      moveToPerson(seg, s, newPerson(s, null, null));
    };
    box.append(add);
    menu.append(box);
  }

  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + window.scrollX + 'px';
  menu.style.top = r.bottom + window.scrollY + 6 + 'px';
  input.focus();
  input.select();
}

function renderVoiceBook() {
  const el = $('#voices-count');
  if (el) el.textContent = voiceBook.length ? voiceBook.map((v) => v.name).join(', ') : 'Ninguna todavía.';
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
  if (src === 'others') requestVoiceprint(seg);
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
// MeetAI can't see whether you are muted in Teams, so it has its own mute for your microphone.
let micMuted = false;

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
    if (!recording || (src === 'me' && micMuted)) return;
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
    if (micMuted) setMicMuted(true);
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
  for (const p of current.people || []) rememberVoice(p);
  save();
  $('#btn-stop').disabled = false;
  $('#btn-stop').textContent = '■ Parar';
  setRecordingUI(false);
  maybeAutotestDone();
  setMicMuted(false); // never carry a forgotten mute into the next meeting
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
  meta.addEventListener('click', (e) => {
    if (e.target.classList.contains('who') && seg.text != null) openSpeakerMenu(seg, e.target);
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
  const person = seg.src === 'others' ? personOf(seg) : null;
  row.className = `row ${seg.src} ${person ? 'c' + ((person.num - 1) % 6) : ''} ${status} ${seg.echo ? 'echo' : ''} ${seg.error ? 'errored' : ''}`;
  row.dataset.t0 = seg.t0;
  meta.innerHTML = `<span class="who" title="Cambiar quién habla"></span> <span class="time"></span>`;
  meta.firstChild.textContent = speakerName(seg);
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
    row.classList.toggle('cont', !!prev && speakerKey(prev) === speakerKey(seg) && seg.t0 - (prev.t0 + prev.dur) < 20000);
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

function setMicMuted(on) {
  micMuted = on;
  if (on && recording) {
    recording.segs.me.close(); // what was said before muting is kept
    recording.segs.me.level = 0;
  }
  $('#btn-mute').textContent = on ? '🎤 Activar micro' : '🔇 Silenciar';
  $('#btn-mute').classList.toggle('muted', on);
  $('#card-me').classList.toggle('muted', on);
  if (recording?.kind === 'live') sourceState('me', on ? 'off' : 'on', on ? 'Silenciado: no se transcribe lo que digas' : 'Escuchando');
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
  $('#btn-acta').disabled = on;
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
// Consecutive phrases from the same person within 20 s read as one turn.
function turns(s) {
  const out = [];
  let prev = null;
  for (const it of [...s.items].sort((a, b) => a.t0 - b.t0)) {
    if (it.text == null || it.echo || !it.text.trim()) continue;
    if (prev && speakerKey(prev) === speakerKey(it) && it.t0 - (prev.t0 + prev.dur) < 20000) {
      out[out.length - 1].text += ' ' + it.text.trim();
    } else {
      out.push({ time: fmtTimeFor(s, it.t0), who: speakerName(it, s), text: it.text.trim() });
    }
    prev = it;
  }
  return out;
}
function exportText(s) {
  const d = new Date(s.start);
  const head = `${s.title} — ${d.toLocaleDateString('es-ES')} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` + (s.end ? ` (${fmtDuration(s.end - s.start)})` : '');
  return head + '\n\n' + turns(s).map((t) => `[${t.time}] ${t.who}: ${t.text}`).join('\n\n') + '\n';
}
function stamp(s) {
  const d = new Date(s.start);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}`;
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- minutes (acta) ----------
// Two ways to fill in the minutes: a draft spotted automatically in the transcript, or the
// minutes the company's Copilot writes from instructions prepared here (see acta.js).
function openActa(s) {
  if (!s) return;
  if (!s.items.some((i) => i.text)) return notice('warn', 'Todavía no hay nada transcrito para hacer el acta.');
  if (recording || s.items.some((i) => i.text == null)) return notice('warn', 'Espera a que termine la transcripción para hacer el acta.');
  const dialog = $('#acta-dialog');
  dialog.dataset.session = s.id;
  $('#acta-paste').value = s.acta?.source === 'copilot' ? s.acta.text : '';
  // Copilot's chat box has a size limit; past it, the transcript goes as an attached file
  $('#acta-long').hidden = exportText(s).length < 12000;
  dialog.showModal();
}

async function actaDocx(s, source) {
  try {
    const A = await import('./acta.js');
    const t = turns(s);
    const auto = A.detectActa(t);
    let acta = auto;
    if (source === 'copilot') {
      const pasted = A.parseActa(s.acta.text);
      // whatever Copilot left out is filled with what was detected automatically
      acta = {
        ...pasted,
        acuerdos: pasted.acuerdos.length ? pasted.acuerdos : auto.acuerdos,
        tareas: pasted.tareas.length ? pasted.tareas : auto.tareas,
        proxima: pasted.proxima || auto.proxima,
      };
    }
    const d = new Date(s.start);
    const blob = await A.buildDocx({
      source,
      title: s.title,
      date: d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      start: s.kind === 'live' ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '—',
      duration: s.end ? fmtDuration(s.end - s.start) : '—',
      attendees: [...new Set(t.map((x) => x.who))],
      acta,
      turns: t,
    });
    log('acta', { source, bytes: blob.size, acta });
    if (!params.has('autotest')) downloadBlob(blob, `acta_${stamp(s)}.docx`);
    notice(
      'info',
      source === 'copilot'
        ? 'Acta descargada con el texto de Copilot. Revísala antes de enviarla.'
        : 'Borrador del acta descargado: completa el resumen y revisa temas, acuerdos y tareas, que se han detectado automáticamente.'
    );
  } catch (e) {
    console.error(e);
    log('acta-error', String(e?.message || e));
    notice('error', 'No se pudo crear el acta: ' + (e?.message || e));
  }
}

function flash(button, text) {
  const before = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = before), 2000);
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
let autotestDone = false;
function maybeAutotestDone() {
  if (autotestDone || !params.has('autotest') || recording || !current || !['demo', 'file'].includes(current.kind)) return;
  if (current.items.some((i) => i.text == null)) return;
  if (voiceActive() && current.items.some((i) => i.src === 'others' && !i.voiceDone && !i.person)) return;
  autotestDone = true;
  log('done', { engine, rtf: +(procAudioMs / procMs).toFixed(2), people: (current.people || []).map((p) => p.name), text: exportText(current) });
  if (params.get('acta') === 'copilot') {
    fetch(params.get('paste'))
      .then((r) => r.text())
      .then((text) => {
        current.acta = { text, source: 'copilot', at: Date.now() };
        actaDocx(current, 'copilot');
      });
  } else if (params.has('acta')) {
    actaDocx(current, 'auto');
  }
}

function applyNames() {
  document.querySelectorAll('.name-me').forEach((e) => (e.textContent = nameOf('me')));
  document.querySelectorAll('.name-others').forEach((e) => (e.textContent = nameOf('others')));
}

// ---------- wire up ----------
function init() {
  $('#set-model').value = settings.model;
  $('#set-device').value = settings.device;
  $('#set-me').value = settings.me;
  $('#set-others').value = settings.others;
  $('#set-echo').checked = settings.echo;
  $('#set-voices').checked = settings.voices;
  applyNames();
  renderVoiceBook();

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
  $('#set-voices').onchange = () => {
    settings.voices = $('#set-voices').checked;
    saveSettings();
    if (settings.voices) startVoice();
    else stopVoice();
  };
  $('#btn-forget-voices').onclick = () => {
    if (!voiceBook.length || !confirm('¿Olvidar las voces guardadas? En las próximas reuniones tendrás que volver a poner los nombres.')) return;
    voiceBook = [];
    saveVoices();
    renderVoiceBook();
  };
  $('#btn-acta').onclick = () => openActa(current);
  const actaSession = () => sessions.find((x) => x.id === $('#acta-dialog').dataset.session);
  $('#acta-auto').onclick = () => {
    $('#acta-dialog').close();
    actaDocx(actaSession(), 'auto');
  };
  $('#acta-copy').onclick = async (e) => {
    const A = await import('./acta.js');
    await navigator.clipboard.writeText(A.copilotPrompt(exportText(actaSession())));
    flash(e.currentTarget, '✓ Copiado: pégalo en Copilot');
  };
  $('#acta-copy-short').onclick = async (e) => {
    e.preventDefault();
    const A = await import('./acta.js');
    await navigator.clipboard.writeText(A.copilotInstructions());
    flash(e.currentTarget, '✓ instrucciones copiadas');
  };
  $('#acta-txt').onclick = (e) => {
    e.preventDefault();
    const s = actaSession();
    downloadBlob(new Blob([exportText(s)], { type: 'text/plain;charset=utf-8' }), `reunion_${stamp(s)}.txt`);
  };
  $('#acta-make').onclick = () => {
    const text = $('#acta-paste').value.trim();
    if (!text) return $('#acta-paste').focus();
    const s = actaSession();
    s.acta = { text, source: 'copilot', at: Date.now() };
    save();
    $('#acta-dialog').close();
    actaDocx(s, 'copilot');
  };
  document.addEventListener('mousedown', (e) => {
    const menu = $('#speaker-menu');
    if (!menu.hidden && !menu.contains(e.target) && !e.target.classList.contains('who')) menu.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#speaker-menu').hidden = true;
  });
  $('#mic').onchange = () => {
    settings.micId = $('#mic').value;
    saveSettings();
    if (recording?.kind === 'live') notice('info', 'El micrófono nuevo se usará la próxima vez que pulses Empezar o Continuar.');
  };

  $('#btn-start').onclick = () => startMeeting(false);
  $('#btn-continue').onclick = () => startMeeting(true);
  $('#btn-stop').onclick = stopRecording;
  $('#btn-share').onclick = shareAgain;
  $('#btn-mute').onclick = () => setMicMuted(!micMuted);
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
    downloadBlob(new Blob([exportText(current)], { type: 'text/plain;charset=utf-8' }), `reunion_${stamp(current)}.txt`);
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
  startVoice();

  if (!navigator.mediaDevices?.getDisplayMedia) {
    notice('error', 'Este navegador no permite captar el audio de la reunión. Abre la página en Microsoft Edge o Google Chrome.');
  }
  if (params.get('autotest') === 'demo') {
    const go = () => (engine ? startDemo() : setTimeout(go, 500));
    go();
  }
  // ?autotest=file&src=demo.wav: a file with every voice mixed together, like a Teams recording
  if (params.get('autotest') === 'file') {
    const go = async () => {
      if (!engine) return setTimeout(go, 500);
      const src = params.get('src') || 'demo.wav';
      const blob = await (await fetch(src)).blob();
      transcribeFile(new File([blob], src));
    };
    go();
  }
}

init();
