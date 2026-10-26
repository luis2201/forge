import { join } from 'node:path';
import { app, BrowserWindow, dialog as electronDialog, shell } from 'electron';
import { createServices } from './bootstrap/services.js';
import { registerIpc } from './ipc/register.js';

let mainWindow: BrowserWindow | null = null;
let disposeServices: (() => void) | null = null;
let unsavedChanges = 0;
let closeConfirmed = false;
let closePromptOpen = false;

if (process.env.FORGE_USER_DATA_PATH) app.setPath('userData', process.env.FORGE_USER_DATA_PATH);

async function createWindow(): Promise<void> {
  closeConfirmed = false;
  closePromptOpen = false;
  unsavedChanges = 0;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111318',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: Boolean(process.env.VITE_DEV_SERVER_URL),
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const policy = process.env.VITE_DEV_SERVER_URL
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self' http://localhost:5173 ws://localhost:5173"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'";
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
    });
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('close', (event) => {
    if (closeConfirmed || unsavedChanges === 0 || !mainWindow) return;
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    const window = mainWindow;
    void electronDialog
      .showMessageBox(window, {
        type: 'warning',
        title: 'Cambios sin guardar',
        message: `Hay ${unsavedChanges} archivo${unsavedChanges === 1 ? '' : 's'} sin guardar.`,
        detail: 'Si cierra Forge ahora, estos cambios se perderán.',
        buttons: ['Cerrar sin guardar', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) {
          closeConfirmed = true;
          window.close();
        }
      })
      .finally(() => {
        closePromptOpen = false;
      });
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) await mainWindow.loadURL(developmentUrl);
  else await mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

void app
  .whenReady()
  .then(async () => {
    const services = await createServices(
      app.getPath('userData'),
      () => mainWindow,
      (count) => {
        unsavedChanges = count;
      },
    );
    disposeServices = services.dispose;
    registerIpc(services.commandBus, () => mainWindow);
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('Forge startup failed.', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (closeConfirmed || unsavedChanges === 0 || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  event.preventDefault();
  mainWindow.close();
});

app.on('will-quit', () => {
  disposeServices?.();
  disposeServices = null;
});
