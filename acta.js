// Meeting minutes as a Word document, filled in one of two ways:
// - a draft spotted automatically in the transcript (topics, agreements, tasks, dates), all local;
// - minutes written by the company's Copilot from instructions prepared here and pasted back.
const DOCX = 'https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.mjs'; /* BUILD:DOCX */

export const COPILOT_URL = 'https://m365.cloud.microsoft/chat';

const INSTRUCTIONS = `Actúa como secretario de reuniones de empresa. Con la transcripción de la reunión, redacta el acta en español de España.
Usa solo información de la transcripción: no inventes nombres, cifras ni fechas.
Responde únicamente con estos cinco apartados, con estos títulos exactos y en este orden:

## Resumen
(un párrafo de 3 a 5 frases)

## Temas tratados
(lista con guiones: un punto por tema, con lo esencial)

## Acuerdos
(lista con guiones: una decisión por punto)

## Tareas
(una línea por tarea con el formato: - Responsable: tarea (fecha límite))

## Próxima reunión
(fecha y hora si se acordaron; si no, «No se fijó»)`;

export const copilotPrompt = (transcript) => `${INSTRUCTIONS}

TRANSCRIPCIÓN:
${transcript}`;

export const copilotInstructions = () => `${INSTRUCTIONS}

La transcripción de la reunión va en el archivo adjunto.`;

// ---------- text helpers ----------
const ACCENTS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
const fold = (s) => s.toLowerCase().normalize('NFD').replace(ACCENTS, '');
const countWords = (s) => s.split(/\s+/).filter(Boolean).length;
const sentences = (text) =>
  text
    .split(/(?<=[.!?…])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
function tidy(s) {
  s = s.replace(/^[¿¡"«\s,.;:-]+|[?!"»\s,;:-]+$/g, '').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Regexes run on the folded text (lowercase, no accents); this maps a match back to the
// original wording, which lines up character by character for normal (precomposed) text.
const original = (orig, folded, index, length) => (folded.length === orig.length ? orig.slice(index, index + length) : folded.slice(index, index + length));

// ---------- automatic draft ----------
const MONTH = '(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';
const DAYNUM =
  '(?:[0-9]{1,2}|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintidos|veintitres|veinticuatro|veinticinco|veintiseis|veintisiete|veintiocho|veintinueve|treinta|treinta y uno)';
const WEEKDAY = '(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)';
const WHEN = new RegExp(
  [
    'hoy mismo',
    'hoy',
    'manana',
    'esta semana',
    'la semana que viene',
    'la proxima semana',
    'este mes',
    `antes del? (?:${DAYNUM} de ${MONTH}|${WEEKDAY}|${DAYNUM}|fin de mes|finales de ${MONTH})`,
    `el ${WEEKDAY}(?: ${DAYNUM})?`,
    `el (?:dia )?${DAYNUM} de ${MONTH}`,
    `(?:a|para) finales de ${MONTH}`,
    `la (?:primera|segunda) quincena de ${MONTH}`,
  ].join('|')
);
const RECAP = /(resumo|resumiendo|repaso|repasamos) lo que (hemos acordado|acordamos|hemos decidido)/;
const ORDINAL = /^(y por ultimo|por ultimo|primero|segundo|tercero|cuarto|quinto|sexto|septimo|octavo|noveno|decimo)[,:]\s*/;
const AGREED = /(queda(n)? (aprobad|acordad|decidid)|se (aprueba|acuerda|decide)n?\b|hemos (acordado|decidido|aprobado)|acordamos|decidimos|aprobamos|quedamos (en|asi|que)\b|de acuerdo en que)/;
const AGENDA = /(hoy (repasamos|vamos a ver|revisamos|tratamos|vemos)|orden del dia es|(ultimo|siguiente|otro) tema|pasamos a(l)?)[:\s]+(.+)$/;
const NEXT_MEETING = /proxima reunion/;
const ASKED = /(te encargas|te ocupas|puedes encargarte|puedes ocuparte)( tu)? de (.+)$/;
const SELF = /\b(me encargo|me ocupo|lo hago yo|yo (preparo|mando|envio|hablo|llamo|reviso|pido|confirmo|redacto|escribo|actualizo|miro|busco)|se lo (pido|confirmo|mando|envio|digo)|le (llamo|escribo|pregunto))\b/;
// second-person orders ("Luis, habla con…") and the infinitive the task list uses
const ORDERS = {
  habla: 'Hablar', hablas: 'Hablar', pide: 'Pedir', pides: 'Pedir', pidele: 'Pedirle', pideselo: 'Pedírselo', prepara: 'Preparar', preparas: 'Preparar',
  confirma: 'Confirmar', confirmas: 'Confirmar', confirmale: 'Confirmarle', manda: 'Mandar', mandas: 'Mandar', envia: 'Enviar', envias: 'Enviar',
  llama: 'Llamar', llamas: 'Llamar', revisa: 'Revisar', revisas: 'Revisar', encargate: 'Encargarse', ocupate: 'Ocuparse', intenta: 'Intentar', busca: 'Buscar',
};
const PROMISES = {
  preparo: 'Preparar', mando: 'Mandar', envio: 'Enviar', hablo: 'Hablar', llamo: 'Llamar', reviso: 'Revisar', pido: 'Pedir', confirmo: 'Confirmar',
  redacto: 'Redactar', escribo: 'Escribir', actualizo: 'Actualizar', miro: 'Mirar', busco: 'Buscar', paso: 'Pasar', organizo: 'Organizar', convoco: 'Convocar',
};
const PROMISE_AT = new RegExp(`(?:^|[ ,])(?:yo |y yo )?(?:te |os |le |les )?(${Object.keys(PROMISES).join('|')})(?= )`);
// "tú hablas con el proveedor": an order to whoever is listening, without their name
const YOU_AT = new RegExp(`(?:^|[ ,])t[uú] (${Object.keys(ORDERS).join('|')})(?= )`);
const ORDER_AT = new RegExp(`\\b(${Object.keys(ORDERS).join('|')})\\b`);
// where a task description stops: "…de formación y si no hay hueco…", "…de bajas y la vemos…"
const TASK_END = /\s+(y si\b|pero\b|porque\b|y (la|lo|las|los|nos|os|me|te) \w+|y os cuento|para que\b)/;

function dateIn(text) {
  const f = fold(text);
  const m = f.match(WHEN);
  return m ? original(text, f, m.index, m[0].length) : '';
}

function cutTask(text) {
  const end = fold(text).search(TASK_END);
  let task = end > 0 ? text.slice(0, end) : text;
  const date = fold(task).match(WHEN);
  if (date) task = task.slice(0, date.index) + task.slice(date.index + date[0].length);
  return tidy(task.replace(/  +/g, ' ')).replace(/[.]+$/, '');
}

function taskFrom(clause, verbIndex) {
  const f = fold(clause);
  let rest = clause.slice(verbIndex);
  const fr = f.slice(verbIndex);
  const verb = fr.match(ORDER_AT)[1];
  rest = ORDERS[verb] + rest.slice(verb.length).replace(/^ +t[uú](?= |$)/i, '');
  const end = fold(rest).search(TASK_END);
  return tidy(end > 0 ? rest.slice(0, end) : rest).replace(/[.]+$/, '');
}

export function detectActa(turns) {
  const temas = [];
  const acuerdos = [];
  const tareas = [];
  let proxima = '';
  let speaker = '';

  const addTopic = (t) => {
    t = tidy(t).replace(/[.]+$/, '');
    const ft = fold(t);
    if (countWords(t) < 2 || temas.some((x) => fold(x).includes(ft) || ft.includes(fold(x)))) return;
    temas.push(t);
  };
  const addAgreement = (t) => {
    t = tidy(t);
    if (countWords(t) >= 4 && !acuerdos.some((a) => fold(a) === fold(t))) acuerdos.push(t);
  };
  const addTask = (who, what, when, turnIndex) => {
    if (countWords(what) < 2 || tareas.some((t) => fold(t.what) === fold(what))) return;
    tareas.push({ who, what, when, turnIndex, by: speaker });
  };

  turns.forEach((turn, i) => {
    let recap = false;
    speaker = turn.who;
    // a reply to a task someone else gave in the last few turns only adds its date ("Se lo pido hoy")
    const pending = tareas.filter((t) => t.turnIndex >= i - 3 && t.turnIndex < i && t.who === turn.who && t.by !== turn.who);
    for (const t of pending) if (!t.when) t.when = dateIn(turn.text);

    for (const sent of sentences(turn.text)) {
      const f = fold(sent);
      if (RECAP.test(f)) {
        recap = true;
        continue;
      }
      const ord = f.match(ORDINAL);
      if (recap && ord) {
        addAgreement(sent.slice(ord[0].length));
        continue;
      }
      if (AGREED.test(f)) addAgreement(sent);

      const agenda = f.match(AGENDA);
      if (agenda) {
        const list = original(sent, f, f.length - agenda[5].length, agenda[5].length);
        for (const t of list.split(/,\s*|\s+y\s+/)) addTopic(t);
      }
      if (!proxima && NEXT_MEETING.test(f) && WHEN.test(f)) proxima = tidy(sent);

      // "quedamos así, tú hablas con el proveedor esta semana y yo preparo un correo…"
      if (!pending.length) {
        for (const clause of sent.split(/, | y (?=yo |t[uú] )/)) {
          const fc = fold(clause);
          const promise = fc.match(PROMISE_AT);
          const you = fc.match(YOU_AT);
          if (promise && countWords(clause) >= 3) {
            const at = fc.indexOf(promise[1], promise.index);
            addTask(turn.who, cutTask(PROMISES[promise[1]] + clause.slice(at + promise[1].length)), dateIn(clause), i);
          } else if (you) {
            const at = fc.indexOf(you[1], you.index);
            addTask('', cutTask(ORDERS[you[1]] + clause.slice(at + you[1].length)), dateIn(clause), i);
          } else if (SELF.test(fc) && countWords(clause) >= 5) {
            addTask(turn.who, tidy(clause).replace(/[.]+$/, ''), dateIn(clause), i);
          }
        }
      }

      // "Luis, pídeselo a Javier, y Carmen, cuando tengas el informe, preparas la propuesta…"
      for (const clause of sent.split(/,\s+y\s+|;\s*/)) {
        const named = clause.match(/^\s*(?:y\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+),\s*/);
        if (!named) continue;
        const who = named[1];
        const body = clause.slice(named[0].length);
        const fb = fold(body);
        const asked = fb.match(ASKED);
        if (asked) {
          const what = original(body, fb, fb.length - asked[3].length, asked[3].length);
          const answer = turns[i + 1];
          addTask(who, tidy(what).replace(/[.]+$/, ''), dateIn(body) || (answer?.who === who ? dateIn(answer.text) : ''), i);
          continue;
        }
        const verb = fb.match(ORDER_AT);
        if (verb) addTask(who, taskFrom(body, verb.index), dateIn(body), i);
      }
    }
  });

  return { resumen: '', temas, acuerdos, tareas: tareas.map(({ who, what, when }) => ({ who, what, when })), proxima };
}

// ---------- reading Copilot's answer ----------
const SECTIONS = [
  ['resumen', /^resumen/],
  ['temas', /^temas/],
  ['acuerdos', /^(acuerdos|decisiones)/],
  ['tareas', /^(tareas|acciones|pendientes|proximos pasos)/],
  ['proxima', /^proxima/],
];
const stripMarks = (s) => s.replace(/\*\*|__/g, '').trim();

function taskLine(line) {
  if (line.trim().startsWith('|')) {
    const cells = line.split('|').map((c) => stripMarks(c)).filter(Boolean);
    if (!cells.length || /^[-: ]+$/.test(cells.join('')) || /responsable/.test(fold(cells[0]))) return null;
    return { who: cells[0] || '', what: cells[1] || '', when: cells[2] || '' };
  }
  const text = stripMarks(line.replace(/^\s*(?:[-*•]|[0-9]+[.)])\s*/, ''));
  if (!text) return null;
  const m = text.match(/^([^:]{1,60}):\s*(.+)$/);
  const who = m ? m[1].trim() : '';
  let what = m ? m[2].trim() : text;
  let when = '';
  const d = what.match(/\(([^()]*)\)\s*\.?$/);
  if (d) {
    what = what.slice(0, d.index).trim();
    when = /sin fecha|no se (dijo|fij|indic|mencion)/.test(fold(d[1])) ? '' : d[1].trim();
  }
  return { who, what, when };
}

export function parseActa(text) {
  const blocks = {};
  let key = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const bare = line.replace(/^[#*\s0-9.)]+/, '').replace(/[*:\s]+$/, '').trim();
    const looksLikeHeading = /^(#|\*\*|[0-9]+[.)]\s|[A-ZÁÉÍÓÚÑ])/.test(line) && bare && countWords(bare) <= 4;
    const hit = looksLikeHeading ? SECTIONS.find(([, re]) => re.test(fold(bare))) : null;
    if (hit) {
      key = hit[0];
      blocks[key] = [];
    } else if (key) {
      blocks[key].push(raw);
    }
  }
  const lines = (k) => (blocks[k] || []).map((l) => l.trim()).filter(Boolean);
  const list = (k) => lines(k).map((l) => stripMarks(l.replace(/^(?:[-*•]|[0-9]+[.)])\s*/, ''))).filter(Boolean);
  const para = (k) => stripMarks(lines(k).map((l) => l.replace(/^[-*•]\s*/, '')).join(' '));
  if (!Object.keys(blocks).length) return { resumen: stripMarks(text), temas: [], acuerdos: [], tareas: [], proxima: '' };
  return {
    resumen: para('resumen'),
    temas: list('temas'),
    acuerdos: list('acuerdos'),
    tareas: lines('tareas').map(taskLine).filter((t) => t && t.what),
    proxima: para('proxima'),
  };
}

// ---------- the Word document ----------
export async function buildDocx({ source, title, date, start, duration, attendees, acta, turns }) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, Footer, PageNumber } = await import(DOCX);
  const BLUE = '1F3864';
  const GREY = '595959';
  const SHADE = 'D9E2F3';
  const draft = source !== 'copilot';
  const TODO = '(Pendiente de completar)';

  const cell = (text, { bold = false, fill = null, width = null } = {}) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
      shading: fill ? { fill, type: 'clear', color: 'auto' } : undefined,
      width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
      margins: { top: 60, bottom: 60, left: 110, right: 110 },
    });
  const heading = (text, pageBreakBefore = false) => new Paragraph({ text, heading: HeadingLevel.HEADING_1, pageBreakBefore, spacing: { before: 320, after: 120 } });
  const para = (text, muted = false) => new Paragraph({ children: [new TextRun({ text, italics: muted, color: muted ? GREY : undefined })], spacing: { after: 120 } });
  const list = (items, empty) => (items.length ? items.map((t) => new Paragraph({ text: t, bullet: { level: 0 }, spacing: { after: 60 } })) : [para(empty, true)]);
  const table = (rows) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });

  const details = table(
    [
      ['Fecha', date],
      ['Hora de inicio', start],
      ['Duración', duration],
      ['Asistentes', attendees.join(', ') || '—'],
    ].map(([k, v]) => new TableRow({ children: [cell(k, { bold: true, fill: SHADE, width: 28 }), cell(v, { width: 72 })] }))
  );

  const tasks = acta.tareas.length
    ? table([
        new TableRow({
          tableHeader: true,
          children: [cell('Responsable', { bold: true, fill: SHADE, width: 25 }), cell('Tarea', { bold: true, fill: SHADE, width: 55 }), cell('Fecha límite', { bold: true, fill: SHADE, width: 20 })],
        }),
        ...acta.tareas.map((t) => new TableRow({ children: [cell(t.who || '—', { width: 25 }), cell(t.what, { width: 55 }), cell(t.when || '—', { width: 20 })] })),
      ])
    : para(draft ? 'No se detectaron tareas. ' + TODO : 'No se asignaron tareas.', true);

  const note = draft
    ? 'Borrador generado automáticamente por MeetAI: completa el resumen y revisa temas, acuerdos y tareas, que se han detectado por frases clave de la transcripción.'
    : 'Acta redactada con Copilot a partir de la transcripción de MeetAI. Revísala antes de distribuirla.';

  const doc = new Document({
    creator: 'MeetAI',
    title: 'Acta de reunión',
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 40, bold: true, color: BLUE } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, color: BLUE } },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], size: 18, color: GREY })] })],
          }),
        },
        children: [
          new Paragraph({ text: 'ACTA DE REUNIÓN', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { after: 80 } }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: title, color: GREY, size: 24 })] }),
          details,
          new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: note, italics: true, size: 18, color: GREY })] }),
          heading('1. Resumen'),
          acta.resumen ? para(acta.resumen) : para(TODO, true),
          heading('2. Temas tratados'),
          ...list(acta.temas, draft ? TODO : 'No se identificaron temas.'),
          heading('3. Acuerdos'),
          ...list(acta.acuerdos, draft ? 'No se detectaron acuerdos. ' + TODO : 'No se tomaron acuerdos.'),
          heading('4. Tareas y responsables'),
          tasks,
          heading('5. Próxima reunión'),
          para(acta.proxima || 'No se fijó.', !acta.proxima),
          heading('Anexo: transcripción completa', true),
          ...turns.map(
            (t) =>
              new Paragraph({
                spacing: { after: 100 },
                children: [new TextRun({ text: `[${t.time}] `, color: GREY, size: 18 }), new TextRun({ text: `${t.who}: `, bold: true }), new TextRun(t.text)],
              })
          ),
        ],
      },
    ],
  });
  return Packer.toBlob(doc);
}
