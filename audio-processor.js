// Runs on the audio thread: collects 100 ms mono frames (16 kHz) and hands them to the page.
const FRAME = 1600;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAME);
    this.n = 0;
    // on stop, hand over the partial last frame (rest is silence) so no audio is lost
    this.port.onmessage = (e) => {
      if (e.data !== 'flush' || !this.n) return;
      this.port.postMessage({ frame: this.buf, tEnd: currentTime }, [this.buf.buffer]);
      this.buf = new Float32Array(FRAME);
      this.n = 0;
    };
  }

  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const a = chans[0];
      const b = chans[1];
      for (let i = 0; i < a.length; i++) {
        this.buf[this.n++] = b ? (a[i] + b[i]) * 0.5 : a[i];
        if (this.n === FRAME) {
          // currentTime + offset = audio-clock time at the end of this frame
          this.port.postMessage({ frame: this.buf, tEnd: currentTime + (i + 1) / sampleRate }, [this.buf.buffer]);
          this.buf = new Float32Array(FRAME);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
