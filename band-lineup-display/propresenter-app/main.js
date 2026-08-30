'use strict';

/**
 * Stage Now / Next — Electron kiosk wrapper.
 *
 * Optional. The display itself is just a web page served by server.js, so a studio
 * can simply open the URL in a browser. This wrapper exists for the machine that
 * should *host* the display: it starts the same server in-process and puts the page
 * in a borderless window, while still serving every other screen on the network.
 *
 *   npm run kiosk              → window on the host machine
 *   npm run kiosk -- --kiosk   → true kiosk (no window chrome, always fullscreen)
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { createDisplayServer, DEFAULT_PORT } = require('./server');

/** How many ports to try past the preferred one before giving up. */
const PORT_ATTEMPTS = 5;

let mainWindow = null;
let display = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      display = await startServer();
    } catch (error) {
      dialog.showErrorBox(
        'Stage Now / Next',
        `Could not start the display server.\n\n${error instanceof Error ? error.message : String(error)}`,
      );
      app.quit();
      return;
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    if (display) await display.close().catch(() => {});
  });
}

async function startServer() {
  const preferred = Number.parseInt(process.env.PORT || '', 10) || DEFAULT_PORT;
  let lastError = null;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const candidate = createDisplayServer({
      port: preferred + attempt,
      dataDir: app.getPath('userData'),
    });
    try {
      await candidate.listen();
      return candidate;
    } catch (error) {
      await candidate.close().catch(() => {});
      lastError = error;
      // Another display (or anything else) already holds that port — step to the next one.
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError || new Error('No free port found.');
}

function createWindow() {
  const kiosk = process.argv.includes('--kiosk');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0f0f12',
    autoHideMenuBar: true,
    kiosk,
    fullscreen: kiosk,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  buildMenu();
  mainWindow.loadURL(`http://127.0.0.1:${display.port}/`);

  // Anything that tries to open a new window (there is nothing today) goes to the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const urls = display.status().viewerUrls;
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Display',
      submenu: [
        {
          label: 'Toggle Fullscreen',
          accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11',
          click: () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()),
        },
        { role: 'reload' },
        { type: 'separator' },
        {
          label: 'Copy Address For Other Screens',
          enabled: urls.length > 0,
          click: () => {
            const { clipboard } = require('electron');
            clipboard.writeText(urls[0]);
          },
        },
        {
          label: urls.length ? `Serving ${urls.join('  ·  ')}` : 'No network address detected',
          enabled: false,
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
