import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { CommandBus } from '../core/commands.js';
import { normalizeError } from '../core/errors.js';

export function registerIpc(
  commandBus: CommandBus,
  getWindow: () => BrowserWindow | null,
): () => void {
  const listener = async (event: IpcMainInvokeEvent, payload: unknown) => {
    const window = getWindow();
    if (
      !window ||
      event.sender.id !== window.webContents.id ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      return { ok: false, error: normalizeError(new Error('Invalid sender')) };
    }
    return commandBus.execute(payload);
  };
  ipcMain.handle('forge:command', listener);
  return () => ipcMain.removeHandler('forge:command');
}
