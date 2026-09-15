# MeetAI · Transcriptor de reuniones

Transcribe en tiempo real las reuniones de Teams (o de cualquier otra aplicación): **lo que dices tú** (micrófono) y **lo que dicen los demás** (el audio que suena en tu PC), en español de España.

- **Gratis, sin cuentas y sin instalar nada.** Es una página web que se abre en Edge o Chrome.
- **Privado.** El reconocimiento de voz (Whisper) funciona dentro de tu navegador. El audio y las transcripciones no salen de tu PC. Solo se descarga el modelo de voz la primera vez.
- **No depende de Teams.** No usa ninguna API ni necesita permisos en la reunión.

Hay dos formas de usarlo:

- **En el navegador:** https://pgonzalht.github.io/MeetAI/ — no hay que instalar nada; tras la primera visita funciona sin internet.
- **Como aplicación de Windows:** un ejecutable con todo dentro (navegador, motor y modelo de voz). No necesita internet ni permisos de administrador, y **no pide compartir pantalla**: coge el audio del PC directamente.

## Cómo se usa

1. Abre la página en **Edge** o **Chrome** antes de la reunión y espera a que ponga **Listo**. La primera vez descarga el modelo de voz, unos cientos de MB. Después se queda guardado.
2. Pulsa **Empezar reunión**.
3. En la ventana de compartir, elige **Toda la pantalla** y activa **Compartir también el audio del sistema**. Esto solo sirve para que la página oiga lo que suena en tu PC; no se comparte con nadie.
4. Da permiso al micrófono.
5. Vuelve a Teams. La pestaña puede quedarse en segundo plano.
6. Durante la reunión puedes pulsar **⏸ Pausar** (deja de transcribir sin cortar nada; **▶ Reanudar** sigue sin volver a compartir pantalla), **🔇 Silenciar** en la tarjeta «Yo» si te silencias en Teams, o **🧹 Pantalla en blanco** para empezar de cero: lo anterior queda guardado en «Reuniones».
7. Al terminar, pulsa **Parar** y usa **Copiar**, **Descargar .txt** o **📝 Acta (Word)**.

Las reuniones quedan guardadas en ese navegador (desplegable de abajo). El texto se puede corregir haciendo clic encima.

## Probar sin reunión

- **Probar con una conversación de ejemplo**: reproduce un diálogo con dos voces (una hace de "Yo" y otra de "Otros") por el mismo camino que una reunión real.
- **Prueba real**: pulsa *Empezar reunión*, pon un vídeo o un pódcast en español y habla a la vez. El vídeo hace de "los demás".
- **Transcribir un archivo**: sirve para grabaciones de Teams, notas de voz, vídeos, etc.

## Quién habla

- Tu micrófono es siempre **Yo**. A los demás, la aplicación los separa por la voz: *Persona 1*, *Persona 2*…
- Pulsa sobre el nombre de una frase para ponerle nombre («Pepe»): cambia en todas sus frases y se recuerda para las próximas reuniones.
- Si una frase está mal asignada, pulsa su nombre y elige quién la dijo. Si a una misma persona la ha partido en dos, pon el mismo nombre a las dos y se unen.
- La huella de voz se calcula en el navegador con WeSpeaker (25 MB). Acierta bien con frases de más de 2-3 segundos; con frases muy cortas, voces parecidas o gente hablando a la vez puede equivocarse.

## Acta de la reunión

Al terminar, **📝 Acta (Word)** ofrece dos caminos:

- **Borrador automático**: al momento y sin salir del PC. Datos de la reunión, asistentes, temas, acuerdos y tareas detectados por frases clave («quedamos en», «te encargas tú de…», «antes del jueves»…) y la transcripción completa como anexo. El resumen lo completas tú.
- **Con Copilot**: la aplicación copia la transcripción con las instrucciones; la pegas en el Copilot de tu empresa, copias su respuesta y la pegas de vuelta. Sale el Word redactado. Ese texto pasa por Microsoft con tu cuenta del trabajo.

Se probó a redactar el acta con una IA pequeña dentro del navegador (Qwen3 0,6B, Gemma 3 1B), pero en un portátil sin tarjeta gráfica o no cargaba o tardaba 12 minutos y no redactaba de verdad; por eso se descartó.

## Si algo falla

| Problema | Solución |
|---|---|
| No aparece nada de "Otros" | Al compartir no se activó el audio del sistema. Pulsa *Compartir audio de la reunión* y activa la casilla de audio. |
| Te silencias en Teams y sigue transcribiendo lo que dices | MeetAI no puede saber si estás silenciado en Teams. Pulsa **🔇 Silenciar** en la tarjeta «Yo» mientras lo estés; se quita solo al terminar la reunión. |
| Oyes Teams por unos cascos y no se capta | Pon esos cascos como salida predeterminada de Windows. |
| El texto sale en gris | Es provisional: lo escribe al momento el modelo rápido y el preciso lo reescribe en cuanto el PC tiene hueco (pasa a color normal). En *Ajustes → Velocidad y precisión* puedes usar solo uno de los dos; durante una reunión se cambia poniéndola en **⏸ Pausa**. |
| "No se pudo cargar el modelo" | La red de la empresa puede estar bloqueando `huggingface.co` o `cdn.jsdelivr.net`. |

## La aplicación de escritorio (Windows)

Se genera desde la carpeta `desktop/`:

```
cd desktop
npm install
node descargar-modelo.mjs   # baja el modelo de voz a desktop/models (una vez)
npm run dist
```

En `desktop/dist/` quedan dos cosas:

- `MeetAI-Instalador-1.0.0.exe`: instala para el usuario actual (sin administrador) y crea el acceso directo.
- `MeetAI-1.0.0-win.zip`: versión portable; se descomprime y se ejecuta `MeetAI.exe`.

Requisitos del PC de destino: **Windows 10/11 de 64 bits**. Nada más: ni Node.js, ni Python, ni internet.

Al no estar firmado digitalmente, Windows puede mostrar el aviso de SmartScreen ("Windows ha protegido tu PC"): hay que pulsar *Más información → Ejecutar de todas formas*. Algunas empresas bloquean directamente los ejecutables sin firma.

## Cómo funciona

- Hay **dos entradas separadas**: el micrófono (*Yo*) y el audio del sistema compartido con `getDisplayMedia` (*Otros*). Por eso sabe quién habla sin tener que adivinarlo.
- Un **detector de voz** corta el audio en frases (en las pausas, o como máximo cada 25 s) y ninguna frase se descarta: si el PC va lento, se ponen en cola.
- Por defecto hay **dos pasadas**: Whisper *base* escribe cada frase en unos segundos y Whisper *small* la reescribe cuando el procesador está libre (medido: 4 s de retraso frente a 15-35 s usando solo el preciso con conversación continua). Las frases que esperan se juntan en una sola pasada y el texto se reparte por marcas de tiempo.
- Las frases se transcriben con **Whisper** ([Transformers.js](https://github.com/huggingface/transformers.js)), usando la tarjeta gráfica (WebGPU) o el procesador (WebAssembly multihilo).
- Si usas altavoces, el micrófono oye también a los demás. La opción *Quitar eco* oculta esas frases duplicadas.
