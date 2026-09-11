# MeetAI · Transcriptor de reuniones

Transcribe en tiempo real las reuniones de Teams (o de cualquier otra aplicación): **lo que dices tú** (micrófono) y **lo que dicen los demás** (el audio que suena en tu PC), en español de España.

- **Gratis, sin cuentas y sin instalar nada.** Es una página web que se abre en Edge o Chrome.
- **Privado.** El reconocimiento de voz (Whisper) funciona dentro de tu navegador. El audio y las transcripciones no salen de tu PC. Solo se descarga el modelo de voz la primera vez.
- **No depende de Teams.** No usa ninguna API ni necesita permisos en la reunión.

👉 **Abrir la aplicación:** https://pgonzalht.github.io/MeetAI/

## Cómo se usa

1. Abre la página en **Edge** o **Chrome** antes de la reunión y espera a que ponga **Listo**. La primera vez descarga el modelo de voz, unos cientos de MB. Después se queda guardado.
2. Pulsa **Empezar reunión**.
3. En la ventana de compartir, elige **Toda la pantalla** y activa **Compartir también el audio del sistema**. Esto solo sirve para que la página oiga lo que suena en tu PC; no se comparte con nadie.
4. Da permiso al micrófono.
5. Vuelve a Teams. La pestaña puede quedarse en segundo plano.
6. Al terminar, pulsa **Parar** y usa **Copiar** o **Descargar .txt**.

Las reuniones quedan guardadas en ese navegador (desplegable de abajo). El texto se puede corregir haciendo clic encima.

## Probar sin reunión

- **Probar con una conversación de ejemplo**: reproduce un diálogo con dos voces (una hace de "Yo" y otra de "Otros") por el mismo camino que una reunión real.
- **Prueba real**: pulsa *Empezar reunión*, pon un vídeo o un pódcast en español y habla a la vez. El vídeo hace de "los demás".
- **Transcribir un archivo**: sirve para grabaciones de Teams, notas de voz, vídeos, etc.

## Si algo falla

| Problema | Solución |
|---|---|
| No aparece nada de "Otros" | Al compartir no se activó el audio del sistema. Pulsa *Compartir audio de la reunión* y activa la casilla de audio. |
| Oyes Teams por unos cascos y no se capta | Pon esos cascos como salida predeterminada de Windows. |
| El contador "pendiente" crece sin parar | El PC no da abasto. No se pierde nada, pero puedes elegir un modelo más rápido en *Ajustes*. |
| "No se pudo cargar el modelo" | La red de la empresa puede estar bloqueando `huggingface.co` o `cdn.jsdelivr.net`. |

## Cómo funciona

- Hay **dos entradas separadas**: el micrófono (*Yo*) y el audio del sistema compartido con `getDisplayMedia` (*Otros*). Por eso sabe quién habla sin tener que adivinarlo.
- Un **detector de voz** corta el audio en frases (en las pausas, o como máximo cada 25 s) y ninguna frase se descarta: si el PC va lento, se ponen en cola.
- Las frases se transcriben con **Whisper** ([Transformers.js](https://github.com/huggingface/transformers.js)), usando la tarjeta gráfica (WebGPU) o el procesador (WebAssembly multihilo).
- Si usas altavoces, el micrófono oye también a los demás. La opción *Quitar eco* oculta esas frases duplicadas.
