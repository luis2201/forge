import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { basename } from 'node:path';
import * as pty from 'node-pty';
import type { ForgeEventMap, TerminalSession } from '../../shared/contracts.js';
import { AppError } from './errors.js';
import type { WorkspaceRepository } from './repositories.js';

interface ManagedTerminal {
  process: pty.IPty;
  workspaceId: string;
}

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly emitData: (payload: ForgeEventMap['terminal.data']) => void,
    private readonly emitExit: (payload: ForgeEventMap['terminal.exited']) => void,
  ) {}

  create(workspaceId: string, cols: number, rows: number): TerminalSession {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace)
      throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
    const shell = platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    const args = platform() === 'win32' ? ['-NoLogo'] : [];
    const terminalId = randomUUID();
    let processHandle: pty.IPty;
    try {
      processHandle = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: workspace.rootPath,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch {
      throw new AppError('TERMINAL_START_FAILED', 'No fue posible iniciar la terminal local.', [
        'Verifique que PowerShell esté disponible.',
      ]);
    }
    this.sessions.set(terminalId, { process: processHandle, workspaceId });
    processHandle.onData((data) => this.emitData({ terminalId, data }));
    processHandle.onExit(({ exitCode }) => {
      this.sessions.delete(terminalId);
      this.emitExit({ terminalId, exitCode });
    });
    return { id: terminalId, shell: basename(shell), cwd: workspace.rootPath };
  }

  write(terminalId: string, data: string): void {
    const session = this.get(terminalId);
    session.process.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.get(terminalId);
    session.process.resize(cols, rows);
  }

  close(terminalId: string): void {
    const session = this.get(terminalId);
    this.sessions.delete(terminalId);
    session.process.kill();
  }

  closeWorkspace(workspaceId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.workspaceId === workspaceId) this.close(id);
    }
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private get(terminalId: string): ManagedTerminal {
    const session = this.sessions.get(terminalId);
    if (!session) throw new AppError('TERMINAL_NOT_FOUND', 'La sesión de terminal ya terminó.');
    return session;
  }
}
