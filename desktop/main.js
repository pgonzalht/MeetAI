// MeetAI desktop. Serves the same app the web version uses, from inside the executable,
// and hands it the PC's audio directly, so there is no "share your screen" dialog.
const { app, BrowserWindow, session, desktopCapturer, shell, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('path');


const AUTOTEST = process.argv.includes('--autotest');
const PROBE = process.argv.includes('--probe');
const ROOT = path.join(__dirname, 'app');
// the voice model travels next to the executable, not inside the app folder
const models = () => (app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, 'models'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.onnx': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};

// A real origin (not file://) is needed for background processing, and these two headers
// unlock multi-threaded transcription. Nothing is exposed outside this PC: the server only
// listens on 127.0.0.1, on a random port, and only serves files from inside the app.
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (!rel || rel === '/') rel = '/index.html';
    let base = ROOT;
    if (rel.startsWith('/models/')) {
      base = models();
      rel = rel.slice('/models'.length);
    }
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) {
      res.writeHead(403).end('No');
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404).end('No encontrado');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

let BASE_URL = '';

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 480,
    backgroundColor: '#14171b',
    title: 'MeetAI',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    show: !AUTOTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(BASE_URL + '/index.html' + (AUTOTEST ? '?autotest=demo' : ''));
  if (PROBE) {
    win.webContents.once('did-finish-load', async () => {
      const fs = require('fs');
      const script = fs.readFileSync(path.join(__dirname, 'probe-script.js'), 'utf8');
      try {
        console.log('PROBE ' + (await win.webContents.executeJavaScript(script)));
      } catch (e) {
        console.log('PROBE-ERR ' + String(e));
      }
      app.quit();
    });
  }

  // links to GitHub etc. open in the real browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (AUTOTEST) {
    win.webContents.on('console-message', (...args) => {
      // Electron changed this signature: newer versions pass one event object
      const first = args[0];
      const message = first && typeof first === 'object' && 'message' in first ? first.message : args[2];
      console.log(String(message));
      if (String(message).includes('MEETAI done') || String(message).includes('MEETAI fatal')) app.quit();
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('FAIL-LOAD', code, desc, url));
    win.webContents.on('render-process-gone', (_e, d) => console.log('RENDER-GONE', JSON.stringify(d)));
    win.webContents.on('preload-error', (_e, p, err) => console.log('PRELOAD-ERROR', p, String(err)));
    win.webContents.on('did-finish-load', async () => {
      console.log('LOADED', win.webContents.getURL());
      setInterval(async () => {
        try {
          const s = await win.webContents.executeJavaScript(
            "JSON.stringify({iso: crossOriginIsolated, st: document.querySelector('#model-text')?.textContent, err: window.__err || null})"
          );
          console.log('STATE', s);
        } catch (e) {
          console.log('STATE-ERR', String(e));
        }
      }, 15000);
    });
    setTimeout(() => app.quit(), 10 * 60 * 1000);
  }

  // Closing with work still queued would lose it, so ask first.
  win.on('close', (e) => {
    if (AUTOTEST) return;
    const pending = win.pendingCount || 0;
    if (!pending) return;
    e.preventDefault();
    const { response } = dialog.showMessageBoxSync
      ? { response: dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: ['Esperar', 'Cerrar igualmente'],
          defaultId: 0,
          title: 'Queda audio por transcribir',
          message: `Todavía quedan ${pending} frases por transcribir. Si cierras ahora, se pierden.`,
        }) }
      : { response: 1 };
    if (response === 1) {
      win.pendingCount = 0;
      win.close();
    }
  });
  return win;
}

app.whenReady().then(async () => {
  BASE_URL = 'http://127.0.0.1:' + (await startServer());
  const ses = session.defaultSession;
  // The app only ever asks for the microphone and the PC audio; both are the whole point of it.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'audioCapture', 'display-capture'].includes(permission)));
  ses.setPermissionCheckHandler(() => true);
  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      callback({ video: sources[0], audio: 'loopback' });
    },
    { useSystemPicker: false }
  );
  const win = createWindow();
  const { ipcMain } = require('electron');
  ipcMain.on('meetai:pending', (_e, n) => (win.pendingCount = n));
});

app.on('window-all-closed', () => app.quit());
