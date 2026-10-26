import { _electron as electron, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return result.stdout;
}

function launchForge(userData: string) {
  const launchEnvironment = { ...process.env };
  delete launchEnvironment.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.FORGE_EXECUTABLE;
  return executablePath
    ? electron.launch({
        executablePath: resolve(executablePath),
        env: { ...launchEnvironment, FORGE_USER_DATA_PATH: userData, NODE_ENV: 'test' },
        timeout: 20_000,
      })
    : electron.launch({
        args: [resolve('.')],
        env: { ...launchEnvironment, FORGE_USER_DATA_PATH: userData, NODE_ENV: 'test' },
        timeout: 20_000,
      });
}

async function closeForge(application: Awaited<ReturnType<typeof launchForge>>): Promise<void> {
  const closed = await Promise.race([
    application
      .close()
      .then(() => true)
      .catch(() => false),
    new Promise<false>((resolveClose) => setTimeout(() => resolveClose(false), 3_000)),
  ]);
  if (!closed) application.process().kill();
}

async function removeTemporaryPath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function within<T>(promise: Promise<T>, label: string | (() => string)): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout at ${typeof label === 'function' ? label() : label}`)),
        8_000,
      ),
    ),
  ]);
}

test('starts securely and renders the real empty state', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-'));
  const application = await launchForge(userData);
  let stderr = '';
  application.process().stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const page = await within(application.firstWindow(), () => `firstWindow: ${stderr}`).catch(
      async (error: unknown) => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        throw new Error(`${error instanceof Error ? error.message : 'Window failed'}\n${stderr}`);
      },
    );
    await expect(page.getByRole('heading', { name: 'Forge' })).toBeVisible();
    await expect(page.getByText('Aún no hay workspaces recientes.')).toBeVisible();
    const surface = await page.evaluate(() => ({
      hasForge: typeof window.forge === 'object',
      hasRequire: 'require' in window,
      hasProcess: 'process' in window,
      apiKeys: Object.keys(window.forge).sort(),
    }));
    expect(surface).toEqual({
      hasForge: true,
      hasRequire: false,
      hasProcess: false,
      apiKeys: [
        'application',
        'database',
        'events',
        'file',
        'git',
        'github',
        'layout',
        'recommendations',
        'search',
        'terminal',
        'workspace',
      ],
    });
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
  }
});

test('edits, saves, detects external changes, searches and runs a real terminal command', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-data-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-e2e-project-'));
  await mkdir(join(project, 'src'));
  await writeFile(join(project, 'src', 'index.ts'), 'export const initial = true;\n', 'utf8');
  seedWorkspace(userData, project, 'phase-two-workspace');
  const application = await launchForge(userData);
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /phase-two-workspace/ }).click();
    await page.getByRole('button', { name: /^▸ src$/ }).click();
    await page.getByRole('button', { name: /index\.ts/ }).click();
    await expect(page.locator('.monaco-editor')).toBeVisible();
    await expect(page.locator('.view-lines')).toContainText('initial');

    await page.locator('.monaco-editor').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('export const savedByForge = true;');
    await expect(page.locator('.view-lines')).toContainText('savedByForge');
    await page.keyboard.press('Control+S');
    await expect
      .poll(async () => readFile(join(project, 'src', 'index.ts'), 'utf8'))
      .toContain('savedByForge');

    await page.keyboard.insertText('\n// unsaved local');
    await writeFile(join(project, 'src', 'index.ts'), 'export const externalValue = 42;\n', 'utf8');
    await expect(page.getByText('El archivo cambió fuera de Forge.')).toBeVisible();
    await page.getByRole('button', { name: 'Recargar' }).click();
    await page.getByRole('button', { name: 'Descartar y recargar' }).click();

    await page.getByTitle('Nuevo archivo').click();
    await page.getByLabel('Nombre del archivo').fill('created.ts');
    await page.getByRole('button', { name: 'Crear' }).click();
    await expect.poll(async () => readFile(join(project, 'src', 'created.ts'), 'utf8')).toBe('');

    await page.getByTitle('Buscar').click();
    await page.getByLabel('Buscar en archivos').fill('externalValue');
    await page.getByLabel('Buscar en archivos').press('Enter');
    await expect(page.getByRole('button', { name: /src\/index\.ts/ })).toBeVisible();

    await expect(page.locator('.terminal-toolbar')).toContainText('powershell.exe');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText('Set-Content -Path "terminal-proof.txt" -Value "ok"');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => readFile(join(project, 'terminal-proof.txt'), 'utf8').catch(() => ''))
      .toContain('ok');

    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText(
      '$ForgeSessionMarker = "preserved"; Set-Content -Path "variable-ready.txt" -Value "ready"',
    );
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => readFile(join(project, 'variable-ready.txt'), 'utf8').catch(() => ''))
      .toContain('ready');
    await page.getByRole('button', { name: 'Ocultar panel' }).click();
    await page.getByRole('button', { name: 'Mostrar terminal' }).click();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText(
      'Set-Content -Path "session-proof.txt" -Value $ForgeSessionMarker',
    );
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => readFile(join(project, 'session-proof.txt'), 'utf8').catch(() => ''))
      .toContain('preserved');
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
    await removeTemporaryPath(project);
  }
});

test('uses SQLite as a daily database workbench with encrypted profiles and data tools', async () => {
  test.setTimeout(90_000);
  const testInfo = test.info();
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-database-data-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-e2e-database-project-'));
  const sqlitePath = join(project, 'app.sqlite');
  const exportPath = join(project, 'customers-export.csv');
  const importPath = join(project, 'customers-import.csv');
  const target = new DatabaseSync(sqlitePath);
  target.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT 1,
      rating DECIMAL(5, 2)
    );
    INSERT INTO customers(name, active) VALUES ('Ada', 1), ('Linus', 0);
  `);
  target.close();
  await writeFile(importPath, 'name,active\nGrace,1\nMargaret,1\n', 'utf8');
  const workspaceId = seedWorkspace(userData, project, 'database-workspace');
  const application = await launchForge(userData);
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /database-workspace/ }).click();
    await page.getByRole('button', { name: 'Bases de datos' }).click();
    await page.getByRole('button', { name: 'Agregar conexión' }).click();
    const connectionDialog = page.locator('.database-connection-dialog');
    await connectionDialog.getByLabel('Nombre').fill('SQLite de la aplicación');
    await connectionDialog.getByLabel(/Ruta SQLite/).fill('app.sqlite');
    await connectionDialog.getByRole('button', { name: 'Probar' }).click();
    await expect(connectionDialog.getByText('Conexión verificada.')).toBeVisible();
    await connectionDialog.getByRole('button', { name: 'Guardar' }).click();

    await expect(page.getByRole('button', { name: /customers.*tabla/ })).toBeVisible();
    await page.getByRole('button', { name: /customers.*tabla/ }).click();
    await expect(page.locator('.database-grid')).toContainText('Ada');
    await expect(page.locator('.database-grid')).toContainText('Linus');

    await page.getByRole('button', { name: 'Añadir fila' }).click();
    const newRow = page.locator('.database-draft-row');
    await newRow.getByLabel('name de fila nueva', { exact: true }).fill('Barbara');
    await newRow.getByRole('button', { name: 'Usar valor para active de fila nueva' }).click();
    await newRow.getByLabel('active de fila nueva', { exact: true }).selectOption('false');
    await newRow.getByRole('button', { name: 'Usar valor para rating de fila nueva' }).click();
    await newRow.getByLabel('rating de fila nueva', { exact: true }).fill('4.75');
    await newRow.getByRole('button', { name: 'Guardar fila' }).click();
    await expect(page.locator('.database-grid')).toContainText('Barbara');

    const barbaraRow = page.locator('.database-grid tbody tr').filter({ hasText: 'Barbara' });
    await barbaraRow.getByRole('button', { name: /Editar fila/ }).click();
    const editRow = page.locator('.database-draft-row');
    await editRow.getByLabel(/name de fila/, { exact: true }).fill('Barbara Liskov');
    await editRow.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.locator('.database-grid')).toContainText('Barbara Liskov');

    const linusRow = page.locator('.database-grid tbody tr').filter({ hasText: 'Linus' });
    await linusRow.getByRole('button', { name: /Eliminar fila/ }).click();
    await page.locator('.confirm-dialog').getByRole('button', { name: 'Eliminar fila' }).click();
    await expect(page.locator('.database-grid')).not.toContainText('Linus');

    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [selectedPath] });
    }, importPath);
    await page.getByRole('button', { name: 'Importar' }).click();
    const importDialog = page.locator('.database-import-dialog');
    await expect(importDialog).toContainText('2 filas hacia main.customers');
    await importDialog.getByRole('button', { name: 'Importar 2 filas' }).click();
    await expect(page.locator('.database-grid')).toContainText('Margaret');
    const fontSizes = await page
      .locator(
        '.database-connection, .database-catalog, .database-workbench-header, .database-tabs, .database-toolbar, .database-grid, .statusbar',
      )
      .evaluateAll((elements) =>
        elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      );
    expect(fontSizes.length).toBeGreaterThan(5);
    expect(Math.min(...fontSizes)).toBeGreaterThanOrEqual(11);
    const visualPath = testInfo.outputPath('database-workbench.png');
    await page.screenshot({ path: visualPath });
    await testInfo.attach('database-workbench', {
      path: visualPath,
      contentType: 'image/png',
    });

    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: selectedPath });
    }, exportPath);
    await page.getByRole('button', { name: 'CSV', exact: true }).click();
    await expect
      .poll(() => readFile(exportPath, 'utf8').catch(() => ''))
      .toContain('Barbara Liskov');

    await page.getByRole('button', { name: 'Consulta SQL' }).click();
    await expect(page.locator('.sql-editor .monaco-editor')).toBeVisible();
    await page.locator('.sql-editor .view-lines').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('SELECT name, active FROM customers ORDER BY id;');
    await page.getByRole('button', { name: /Ejecutar/ }).click();
    await expect(page.locator('.database-query-view .database-grid')).toContainText('Grace');
    await page.getByRole('button', { name: 'Historial SQL' }).click();
    await expect(page.locator('.database-history-list')).toContainText(
      'SELECT name, active FROM customers ORDER BY id;',
    );

    const saved = await page.evaluate(
      (id) =>
        window.forge.database.saveConnection(
          id,
          null,
          {
            name: 'Servidor cifrado',
            engine: 'mysql',
            environment: 'DEVELOPMENT',
            host: 'localhost',
            port: 3306,
            database: 'forge',
            username: 'forge',
            sslMode: 'disabled',
            sqlitePath: '',
          },
          'e2e-secret-value',
        ),
      workspaceId,
    );
    expect(saved.ok).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('e2e-secret-value');
    const metadata = new DatabaseSync(join(userData, 'forge.db'));
    const encrypted = metadata
      .prepare(
        `SELECT s.encrypted_value
         FROM secret_values s JOIN database_connections c ON c.secret_ref=s.ref
         WHERE c.name='Servidor cifrado'`,
      )
      .get() as { encrypted_value: Uint8Array };
    metadata.close();
    expect(Buffer.from(encrypted.encrypted_value).toString('utf8')).not.toContain(
      'e2e-secret-value',
    );
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
    await removeTemporaryPath(project);
  }
});

test('keeps backend services alive when quitting with dirty files is cancelled', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-quit-'));
  const application = await launchForge(userData);
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
    });
    const dirtyResult = await page.evaluate(() => window.forge.application.setDirtyState(1));
    expect(dirtyResult.ok).toBe(true);

    await application.evaluate(({ app }) => app.quit());
    await expect(page.getByRole('heading', { name: 'Forge' })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.forge.application.getSettings()))
      .toMatchObject({ ok: true });

    await page.evaluate(() => window.forge.application.setDirtyState(0));
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
  }
});

test('manages a real Git workflow from the desktop UI', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-git-data-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-e2e-git-project-'));
  await git(project, 'init', '-b', 'main');
  await git(project, 'config', 'user.name', 'Forge E2E');
  await git(project, 'config', 'user.email', 'forge-e2e@example.test');
  await git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(join(project, 'app.ts'), 'export const value = 1;\n', 'utf8');
  await git(project, 'add', 'app.ts');
  await git(project, 'commit', '-m', 'initial commit');
  await git(project, 'remote', 'add', 'origin', 'https://github.com/forge-tests/e2e.git');
  await writeFile(join(project, 'app.ts'), 'export const value = 2;\n', 'utf8');
  seedWorkspace(userData, project, 'phase-three-workspace');

  const application = await launchForge(userData);
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /phase-three-workspace/ }).click();
    await page.getByRole('button', { name: 'Control de código fuente' }).click();

    await expect(page.locator('.git-summary strong')).toHaveText('main');
    await expect(page.getByText('GitHub · forge-tests/e2e')).toBeVisible();
    await page.locator('.git-file-name', { hasText: 'app.ts' }).click();
    await expect(page.locator('.git-diff')).toContainText('+export const value = 2;');

    await page.getByLabel('Preparar app.ts').click();
    await expect(page.getByLabel('Quitar app.ts del área de preparación')).toBeVisible();
    await page.getByLabel('Mensaje del commit').fill('update from Forge UI');
    await page.getByRole('button', { name: 'Confirmar cambios' }).click();
    await expect
      .poll(async () => (await git(project, 'log', '-1', '--pretty=%s')).trim())
      .toBe('update from Forge UI');

    await page.getByRole('button', { name: 'Ramas' }).click();
    await page.getByLabel('Nombre de nueva rama').fill('feature/ui-flow');
    await page.getByRole('button', { name: 'Crear y cambiar' }).click();
    await expect
      .poll(async () => (await git(project, 'branch', '--show-current')).trim())
      .toBe('feature/ui-flow');

    await page.getByRole('button', { name: 'Historial' }).click();
    const commit = page.getByRole('button', { name: /update from Forge UI/ });
    await expect(commit).toBeVisible();
    await commit.click();
    await expect(page.locator('.git-diff')).toContainText('commit');
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
    await removeTemporaryPath(project);
  }
});

test('initializes Git in the UI and synchronizes terminal and external operations', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-init-data-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-e2e-init-project-'));
  const remote = await mkdtemp(join(tmpdir(), 'forge-e2e-init-remote-'));
  await removeTemporaryPath(remote);
  await git(tmpdir(), 'init', '--bare', '--initial-branch=main', remote);
  await writeFile(join(project, 'app.ts'), 'export const initialized = true;\n', 'utf8');
  seedWorkspace(userData, project, 'git-init-workspace');

  const application = await launchForge(userData);
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /git-init-workspace/ }).click();
    await page.getByRole('button', { name: 'Control de código fuente' }).click();
    await expect(page.getByText('No hay un repositorio Git')).toBeVisible();
    await expect(page.getByText('git init -b main')).toBeVisible();
    await page.getByRole('button', { name: 'Inicializar repositorio' }).click();
    await expect
      .poll(() => git(project, 'branch', '--show-current').catch(() => ''))
      .toContain('main');
    await expect(page.locator('.git-summary strong')).toHaveText('main');

    await git(project, 'config', 'user.name', '');
    await git(project, 'config', 'user.email', '');
    await page.getByTitle('Actualizar Git').click();
    await expect(page.getByText('Falta la identidad Git', { exact: true }).first()).toBeVisible();
    await page.getByLabel('Preparar app.ts').click();
    await page.getByLabel('Mensaje del commit').fill('bloqueado sin identidad');
    await expect(page.getByRole('button', { name: 'Confirmar cambios' })).toBeDisabled();
    await page.getByLabel('Nombre del autor Git').fill('Forge UI');
    await page.getByLabel('Correo del autor Git').fill('forge-ui@example.test');
    await page.getByRole('button', { name: 'Guardar identidad' }).click();
    await expect
      .poll(() =>
        git(project, 'config', '--local', '--get', 'user.email').then((value) => value.trim()),
      )
      .toBe('forge-ui@example.test');
    await expect(page.getByText('Forge UI <forge-ui@example.test>')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar cambios' })).toBeEnabled();

    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText('git add app.ts; git commit -m "terminal commit"');
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        git(project, 'log', '-1', '--pretty=%s')
          .then((value) => value.trim())
          .catch(() => ''),
      )
      .toBe('terminal commit');
    await page.getByRole('button', { name: 'Historial' }).click();
    await expect(page.getByRole('button', { name: /terminal commit/ })).toBeVisible();

    await git(project, 'switch', '-c', 'external-sync');
    await expect(page.locator('.git-summary strong')).toHaveText('external-sync');

    await page.getByLabel('URL del remoto origin').fill(remote);
    await page.getByRole('button', { name: 'Configurar origin' }).click();
    await expect
      .poll(() =>
        git(project, 'remote', 'get-url', 'origin')
          .then((value) => value.trim())
          .catch(() => ''),
      )
      .toBe(remote);
    await expect(page.locator('.git-notice code')).toContainText('git remote add origin');
    await expect(page.getByRole('button', { name: 'Push' })).toBeEnabled();
    await page.getByRole('button', { name: 'Push' }).click();
    await expect
      .poll(
        () =>
          git(project, 'rev-parse', '--abbrev-ref', '@{upstream}')
            .then((value) => value.trim())
            .catch(() => ''),
        { timeout: 20_000 },
      )
      .toBe('origin/external-sync');
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
    await removeTemporaryPath(project);
    await removeTemporaryPath(remote);
  }
});

test('resolves a real divergent synchronization through the visual assistant', async () => {
  test.setTimeout(120_000);
  const testInfo = test.info();
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-sync-data-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-e2e-sync-project-'));
  const remote = await mkdtemp(join(tmpdir(), 'forge-e2e-sync-remote-'));
  const peer = await mkdtemp(join(tmpdir(), 'forge-e2e-sync-peer-'));
  await removeTemporaryPath(remote);
  await removeTemporaryPath(peer);
  await git(tmpdir(), 'init', '--bare', '--initial-branch=main', remote);
  await git(project, 'init', '-b', 'main');
  await git(project, 'config', 'user.name', 'Forge Sync');
  await git(project, 'config', 'user.email', 'forge-sync@example.test');
  await git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(join(project, 'README.md'), '# Base\n', 'utf8');
  await git(project, 'add', 'README.md');
  await git(project, 'commit', '-m', 'base compartida');
  await git(project, 'remote', 'add', 'origin', remote);
  await git(project, 'push', '--set-upstream', 'origin', 'main');
  await git(tmpdir(), 'clone', remote, peer);
  await git(peer, 'config', 'user.name', 'Remote Peer');
  await git(peer, 'config', 'user.email', 'remote-peer@example.test');
  await git(peer, 'config', 'core.autocrlf', 'false');
  await writeFile(join(project, 'local.ts'), 'export const local = true;\n', 'utf8');
  await git(project, 'add', 'local.ts');
  await git(project, 'commit', '-m', 'commit exclusivo local');
  await writeFile(join(peer, 'remote.ts'), 'export const remote = true;\n', 'utf8');
  await git(peer, 'add', 'remote.ts');
  await git(peer, 'commit', '-m', 'commit exclusivo remoto');
  await git(peer, 'push');
  seedWorkspace(userData, project, 'divergent-workspace');

  const application = await launchForge(userData);
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /divergent-workspace/ }).click();
    await page.getByRole('button', { name: 'Control de código fuente' }).click();
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByText('Historial local y remoto divergente')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Resolver sincronización' }).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Push' })).toBeDisabled();
    await expect(
      page.getByLabel('Recomendaciones Git').getByText('Las ramas han divergido'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Resolver sincronización' }).first().click();
    const assistant = page.getByLabel('Resolver sincronización Git');
    await expect(assistant.getByText('Resolver sincronización Git', { exact: true })).toBeVisible();
    await expect(page.locator('.sync-summary')).toContainText('↑1');
    await expect(page.locator('.sync-summary')).toContainText('↓1');
    await expect(page.getByRole('radio', { name: /Merge/ })).toBeChecked();
    await assistant.getByRole('button', { name: 'Comparar cambios' }).click();
    await expect(assistant.getByText('commit exclusivo local')).toBeVisible();
    await expect(assistant.getByText('commit exclusivo remoto')).toBeVisible();
    await expect(page.locator('.sync-side-local')).toContainText('local.ts');
    await expect(page.locator('.sync-side-remoto')).toContainText('remote.ts');

    const fontSizes = await page
      .locator(
        '.git-summary, .git-sync-actions button, .recommendation, .sync-assistant, .tab, .statusbar, .terminal-toolbar',
      )
      .evaluateAll((elements) =>
        elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      );
    expect(fontSizes.length).toBeGreaterThan(5);
    expect(Math.min(...fontSizes)).toBeGreaterThanOrEqual(11);

    const visualPath = testInfo.outputPath('sync-assistant.png');
    await page.screenshot({ path: visualPath });
    await testInfo.attach('asistente-sincronizacion', {
      path: visualPath,
      contentType: 'image/png',
    });

    await page.getByRole('button', { name: 'Inspeccionar diff' }).first().click();
    await expect(page.locator('.sync-diff-preview')).toContainText('local.ts');
    await page.getByRole('button', { name: 'Cerrar comparación' }).click();
    await page.getByRole('button', { name: 'Integrar mediante Merge' }).click();
    await expect(page.getByRole('heading', { name: 'Integrar mediante Merge' })).toBeVisible();
    await page.getByRole('button', { name: 'Ejecutar Merge' }).click();
    await expect(page.getByText('✓ Integración verificada')).toBeVisible();
    await expect(page.locator('.sync-result')).toContainText('Remoto: ↓0');
    await page.getByRole('button', { name: 'Push final' }).click();
    await expect(page.getByText('✓ Sincronizado')).toBeVisible();
    await expect(page.locator('.sync-result')).toContainText('Local: ↑0');
    await expect(page.locator('.sync-result')).toContainText('Remoto: ↓0');
    await expect
      .poll(async () =>
        (await git(project, 'rev-list', '--left-right', '--count', 'HEAD...origin/main')).trim(),
      )
      .toMatch(/^0\s+0$/);
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
    await removeTemporaryPath(project);
    await removeTemporaryPath(peer);
    await removeTemporaryPath(remote);
  }
});

test('resolves a real merge conflict visually and marks the result explicitly', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-conflict-data-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-e2e-conflict-project-'));
  await git(project, 'init', '-b', 'main');
  await git(project, 'config', 'user.name', 'Forge Conflict');
  await git(project, 'config', 'user.email', 'conflict@example.test');
  await writeFile(join(project, 'conflict.txt'), 'base\n', 'utf8');
  await git(project, 'add', 'conflict.txt');
  await git(project, 'commit', '-m', 'base');
  await git(project, 'switch', '-c', 'feature');
  await writeFile(join(project, 'conflict.txt'), 'remote choice\n', 'utf8');
  await git(project, 'commit', '-am', 'feature choice');
  await git(project, 'switch', 'main');
  await writeFile(join(project, 'conflict.txt'), 'local choice\n', 'utf8');
  await git(project, 'commit', '-am', 'local choice');
  await execute('git', ['merge', 'feature'], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
  }).catch(() => undefined);
  seedWorkspace(userData, project, 'conflict-workspace');

  const application = await launchForge(userData);
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /conflict-workspace/ }).click();
    await page.getByRole('button', { name: 'Control de código fuente' }).click();
    await expect(
      page.getByLabel('Recomendaciones Git').getByText('Conflictos pendientes'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Resolver', exact: true }).click();
    await expect(page.getByText('Resolución visual de conflicto')).toBeVisible();
    await expect(page.getByText('LOCAL', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('REMOTO', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Aceptar ambos' }).click();
    await page.getByRole('button', { name: 'Marcar como resuelto' }).click();

    await expect
      .poll(async () => (await git(project, 'status', '--porcelain')).includes('UU conflict.txt'))
      .toBe(false);
    expect(await readFile(join(project, 'conflict.txt'), 'utf8')).toContain('local choice');
    expect(await readFile(join(project, 'conflict.txt'), 'utf8')).toContain('remote choice');
    await expect(page.getByText('Resolución visual de conflicto')).not.toBeVisible();
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
    await removeTemporaryPath(project);
  }
});

test('requires explicit confirmation before committing a sensitive filename', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'forge-e2e-sensitive-data-'));
  const project = await mkdtemp(join(tmpdir(), 'forge-e2e-sensitive-project-'));
  await git(project, 'init', '-b', 'main');
  await git(project, 'config', 'user.name', 'Forge Sensitive');
  await git(project, 'config', 'user.email', 'sensitive@example.test');
  await writeFile(join(project, '.env'), 'EXAMPLE=value\n', 'utf8');
  await git(project, 'add', '.env');
  seedWorkspace(userData, project, 'sensitive-workspace');

  const application = await launchForge(userData);
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /sensitive-workspace/ }).click();
    await page.getByRole('button', { name: 'Control de código fuente' }).click();
    await expect(page.getByText('Posibles archivos sensibles preparados')).toBeVisible();
    await page.getByLabel('Mensaje del commit').fill('explicit sensitive commit');
    await page.getByRole('button', { name: 'Confirmar cambios' }).click();
    await expect(
      page.getByRole('heading', { name: 'Confirmar archivos potencialmente sensibles' }),
    ).toBeVisible();
    await expect(page.locator('.confirm-dialog')).toContainText('.env coincide con .env');
    await page.getByRole('button', { name: 'Crear commit de todos modos' }).click();
    await expect
      .poll(() =>
        git(project, 'log', '-1', '--pretty=%s')
          .then((value) => value.trim())
          .catch(() => ''),
      )
      .toBe('explicit sensitive commit');
  } finally {
    await closeForge(application);
    await removeTemporaryPath(userData);
    await removeTemporaryPath(project);
  }
});

function seedWorkspace(userData: string, rootPath: string, name: string): string {
  const database = new DatabaseSync(join(userData, 'forge.db'));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_opened_at INTEGER, is_archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE workspace_roots (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE, canonical_path TEXT NOT NULL UNIQUE COLLATE NOCASE, display_path TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE workspace_settings (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, schema_version INTEGER NOT NULL, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE application_settings (key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE workspace_layouts (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, schema_version INTEGER NOT NULL, layout_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  const id = randomUUID();
  const now = Date.now();
  database
    .prepare('INSERT INTO schema_migrations VALUES(1, ?, ?, ?)')
    .run('phase-1-core', now, 'phase-1-core-v1');
  database
    .prepare(
      'INSERT INTO workspaces(id,name,created_at,updated_at,last_opened_at) VALUES(?,?,?,?,?)',
    )
    .run(id, name, now, now, now);
  database
    .prepare('INSERT INTO workspace_roots VALUES(?,?,?,?,?)')
    .run(randomUUID(), id, rootPath, rootPath, now);
  database
    .prepare('INSERT INTO workspace_settings VALUES(?,1,?,?)')
    .run(id, JSON.stringify({ environment: 'LOCAL' }), now);
  database.close();
  return id;
}
