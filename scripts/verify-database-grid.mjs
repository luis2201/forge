import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const outputDirectory = resolve('test-results', 'database-grid-renderer');
await mkdir(outputDirectory, { recursive: true });

const server = await createServer({
  configFile: resolve('vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string')
  throw new Error('Vite no publicó un puerto de prueba.');
const origin = `http://127.0.0.1:${address.port}`;
const harnessUrl = `${origin}/@fs/${resolve('tests', 'renderer', 'database-grid-harness.tsx').replaceAll('\\', '/')}`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 850 } });
page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => console.error(`[renderer:error] ${error.message}`));

try {
  await page.goto(`${origin}/styles.css`);
  await page.evaluate(() => {
    const structure = {
      schema: 'main',
      name: 'customers',
      type: 'table',
      columns: [
        {
          name: 'id',
          dataType: 'INTEGER',
          nullable: true,
          primaryKey: true,
          defaultValue: null,
          generated: false,
          autoIncrement: true,
        },
        {
          name: 'name',
          dataType: 'VARCHAR(80)',
          nullable: false,
          primaryKey: false,
          defaultValue: null,
          generated: false,
          autoIncrement: false,
        },
        {
          name: 'active',
          dataType: 'BOOLEAN',
          nullable: false,
          primaryKey: false,
          defaultValue: '1',
          generated: false,
          autoIncrement: false,
        },
        {
          name: 'rating',
          dataType: 'DECIMAL(5, 2)',
          nullable: true,
          primaryKey: false,
          defaultValue: null,
          generated: false,
          autoIncrement: false,
        },
        {
          name: 'joined_on',
          dataType: 'DATE',
          nullable: true,
          primaryKey: false,
          defaultValue: null,
          generated: false,
          autoIncrement: false,
        },
      ],
      foreignKeys: [],
    };
    let rows = [
      [1, 'Ada', 1, 4.9, '2026-01-10'],
      [2, 'Linus', 0, null, null],
    ];
    const rowResult = () => ({
      kind: 'rows',
      columns: structure.columns.map((column) => ({
        name: column.name,
        dataType: column.dataType,
      })),
      rows,
      rowCount: rows.length,
      affectedRows: 0,
      durationMs: 2,
      truncated: false,
      command: 'SELECT',
    });
    const ok = (value) => ({ ok: true, value });
    window.forge = {
      database: {
        structure: async () => ok(structure),
        tableData: async (_workspaceId, _connectionId, _schema, _table, offset, limit) =>
          ok({ structure, result: rowResult(), offset, limit }),
        mutateRow: async (_workspaceId, _connectionId, _schema, _table, mutation) => {
          if (mutation.kind === 'insert') {
            const nextId = Math.max(0, ...rows.map((row) => Number(row[0]))) + 1;
            rows = [
              ...rows,
              structure.columns.map((column) => {
                if (column.name === 'id') return nextId;
                if (column.name in mutation.values) return mutation.values[column.name];
                if (column.name === 'active') return 1;
                return null;
              }),
            ];
          } else {
            const rowIndex = rows.findIndex((row) => row[0] === mutation.key.id);
            if (mutation.kind === 'delete') rows = rows.filter((_row, index) => index !== rowIndex);
            else if (rowIndex >= 0) {
              rows = rows.map((row, index) =>
                index === rowIndex
                  ? structure.columns.map((column, columnIndex) =>
                      column.name in mutation.values
                        ? mutation.values[column.name]
                        : row[columnIndex],
                    )
                  : row,
              );
            }
          }
          return ok({
            kind: 'mutation',
            columns: [],
            rows: [],
            rowCount: 1,
            affectedRows: 1,
            durationMs: 1,
            truncated: false,
            command: mutation.kind.toUpperCase(),
          });
        },
        history: async () => ok([]),
        exportResult: async () => ok(null),
        previewImport: async () => ok(null),
        applyImport: async () => ok(null),
        clearHistory: async () => ok(null),
        query: async () => ok(rowResult()),
      },
    };
  });

  await page.setContent(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <link rel="stylesheet" href="${origin}/styles.css" />
        <style>html, body, #root { width: 100%; height: 100%; margin: 0; }</style>
      </head>
      <body>
        <div id="root"></div>
        <script type="module">
          import RefreshRuntime from '${origin}/@react-refresh';
          RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$ = () => {};
          window.$RefreshSig$ = () => (type) => type;
          window.__vite_plugin_react_preamble_installed__ = true;
        </script>
        <script type="module" src="${harnessUrl}"></script>
      </body>
    </html>
  `);

  await expect(page.getByRole('button', { name: 'Añadir fila' })).toBeVisible();
  await page.getByRole('button', { name: 'Añadir fila' }).click();
  const draft = page.locator('.database-draft-row');
  await expect(draft.getByText('Automático')).toBeVisible();
  await expect(draft.getByLabel('name de fila nueva', { exact: true })).toHaveAttribute(
    'maxlength',
    '80',
  );
  await draft.getByLabel('name de fila nueva', { exact: true }).fill('Barbara');
  await draft.getByRole('button', { name: 'Usar valor para active de fila nueva' }).click();
  await draft.getByLabel('active de fila nueva', { exact: true }).selectOption('false');
  await draft.getByRole('button', { name: 'Usar valor para rating de fila nueva' }).click();
  await expect(draft.getByLabel('rating de fila nueva', { exact: true })).toHaveAttribute(
    'type',
    'number',
  );
  await draft.getByLabel('rating de fila nueva', { exact: true }).fill('4.75');
  await draft.getByRole('button', { name: 'Usar valor para joined_on de fila nueva' }).click();
  await expect(draft.getByLabel('joined_on de fila nueva', { exact: true })).toHaveAttribute(
    'type',
    'date',
  );
  await draft.getByLabel('joined_on de fila nueva', { exact: true }).fill('2026-08-23');
  await page.screenshot({ path: resolve(outputDirectory, 'inline-insert.png') });
  await draft.getByRole('button', { name: 'Guardar fila' }).click();
  await expect(page.locator('.database-grid')).toContainText('Barbara');

  const barbaraRow = page.locator('.database-grid tbody tr').filter({ hasText: 'Barbara' });
  await barbaraRow.getByRole('button', { name: /Editar fila/ }).click();
  const editDraft = page.locator('.database-draft-row');
  await editDraft.getByLabel(/name de fila/, { exact: true }).fill('Barbara Liskov');
  await editDraft.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(page.locator('.database-grid')).toContainText('Barbara Liskov');

  const linusRow = page.locator('.database-grid tbody tr').filter({ hasText: 'Linus' });
  await linusRow.getByRole('button', { name: /Eliminar fila/ }).click();
  await expect(page.locator('.database-grid')).not.toContainText('Linus');
  await expect.poll(() => page.evaluate(() => window.__rendererError ?? null)).toBeNull();
  await page.screenshot({ path: resolve(outputDirectory, 'inline-crud-complete.png') });
} finally {
  await browser.close();
  await server.close();
}

console.log(`Database grid renderer verified: ${outputDirectory}`);
