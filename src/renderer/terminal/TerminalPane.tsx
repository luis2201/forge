import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ForgeError, ForgeEventMap } from '../../shared/contracts';

interface TerminalPaneProps {
  workspaceId: string;
  theme: 'dark' | 'light';
  onError: (error: ForgeError) => void;
}

export function TerminalPane({ workspaceId, theme, onError }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const themeRef = useRef(theme);
  const [restartKey, setRestartKey] = useState(0);
  const [status, setStatus] = useState('Iniciando…');
  themeRef.current = theme;

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalColors(theme);
  }, [theme]);

  useEffect(() => {
    if (!host.current) return;
    let active = true;
    let terminalId: string | null = null;
    const earlyData: ForgeEventMap['terminal.data'][] = [];
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: terminalColors(themeRef.current),
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    if (host.current.clientWidth && host.current.clientHeight) fit.fit();

    const unsubscribeData = window.forge.events.subscribe('terminal.data', (payload) => {
      if (!terminalId) earlyData.push(payload);
      else if (payload.terminalId === terminalId) terminal.write(payload.data);
    });
    const unsubscribeExit = window.forge.events.subscribe('terminal.exited', (payload) => {
      if (payload.terminalId !== terminalId) return;
      terminalId = null;
      setStatus(`Finalizada (${payload.exitCode})`);
      terminal.writeln(`\r\n\x1b[90m[Proceso finalizado con código ${payload.exitCode}]\x1b[0m`);
    });
    const dataSubscription = terminal.onData((data) => {
      if (terminalId) void window.forge.terminal.write(terminalId, data);
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!host.current?.clientWidth || !host.current.clientHeight) return;
      fit.fit();
      if (terminalId) void window.forge.terminal.resize(terminalId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(host.current);

    void window.forge.terminal.create(workspaceId, terminal.cols, terminal.rows).then((result) => {
      if (!active) {
        if (result.ok) void window.forge.terminal.close(result.value.id);
        return;
      }
      if (!result.ok) {
        setStatus('No disponible');
        onError(result.error);
        return;
      }
      terminalId = result.value.id;
      setStatus(result.value.shell);
      for (const item of earlyData) if (item.terminalId === terminalId) terminal.write(item.data);
      void window.forge.terminal.resize(terminalId, terminal.cols, terminal.rows);
      terminal.focus();
    });

    return () => {
      active = false;
      unsubscribeData();
      unsubscribeExit();
      dataSubscription.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (terminalId) void window.forge.terminal.close(terminalId);
    };
  }, [onError, restartKey, workspaceId]);

  return (
    <div className="terminal-pane">
      <div className="terminal-toolbar">
        <strong>TERMINAL</strong>
        <span>{status}</span>
        <button title="Reiniciar terminal" onClick={() => setRestartKey((value) => value + 1)}>
          ↻
        </button>
      </div>
      <div className="terminal-host" ref={host} />
    </div>
  );
}

function terminalColors(theme: 'dark' | 'light') {
  return theme === 'dark'
    ? { background: '#111318', foreground: '#dfe3ea', cursor: '#f29a38' }
    : { background: '#ffffff', foreground: '#22262d', cursor: '#b75b18' };
}
