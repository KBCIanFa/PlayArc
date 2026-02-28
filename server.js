/**
 * PlayArc Backend Server
 * ─────────────────────────────────────────────────────────────
 * Bridges the PlayArc UI to a real Playwright test runner.
 *
 * Stack:  Node.js 18+  |  Express 4  |  ws (WebSocket)
 *         Playwright   |  SQLite (via better-sqlite3)
 *
 * Install:
 *   npm install express ws better-sqlite3 cors @playwright/test
 *   npx playwright install
 *
 * Run:
 *   node server.js
 *
 * The UI connects to:
 *   REST  → http://localhost:4000/api/*
 *   WS    → ws://localhost:4000/ws/runs/:runId
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const WebSocket  = require('ws');
const Database   = require('better-sqlite3');
const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

// ─── Config ────────────────────────────────────────────────────
const PORT         = process.env.PORT || 4000;
const DB_PATH      = process.env.DB_PATH  || './playarc.db';
const TESTS_DIR    = process.env.TESTS_DIR || './generated-tests';
const RESULTS_DIR  = process.env.RESULTS_DIR || './test-results';
const SHOTS_DIR    = process.env.SHOTS_DIR || './screenshots';

// ─── Bootstrap directories ─────────────────────────────────────
[TESTS_DIR, RESULTS_DIR, SHOTS_DIR,
 path.join(TESTS_DIR, 'keywords'),
 path.join(TESTS_DIR, 'helpers')].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Database setup ────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS suites (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    url       TEXT,
    browser   TEXT DEFAULT 'chromium',
    steps     TEXT DEFAULT '[]',
    created   TEXT DEFAULT (datetime('now')),
    updated   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS objects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    page       TEXT,
    sel        TEXT,
    aria       TEXT,
    css        TEXT,
    xpath      TEXT,
    healscore  INTEGER DEFAULT 80,
    uses       INTEGER DEFAULT 0,
    created    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tables (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    desc     TEXT,
    cols     TEXT DEFAULT '[]',
    rows     TEXT DEFAULT '[]',
    created  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id         TEXT PRIMARY KEY,
    suite_id   INTEGER,
    suite_name TEXT,
    status     TEXT DEFAULT 'queued',
    browser    TEXT DEFAULT 'chromium',
    headless   INTEGER DEFAULT 1,
    passed     INTEGER DEFAULT 0,
    failed     INTEGER DEFAULT 0,
    healed     INTEGER DEFAULT 0,
    duration   REAL DEFAULT 0,
    started    TEXT DEFAULT (datetime('now')),
    finished   TEXT,
    FOREIGN KEY(suite_id) REFERENCES suites(id)
  );

  CREATE TABLE IF NOT EXISTS keyword_libs (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    pkg   TEXT NOT NULL,
    desc  TEXT
  );

  CREATE TABLE IF NOT EXISTS keywords (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    lib_id   INTEGER,
    name     TEXT NOT NULL,
    desc     TEXT,
    params   TEXT DEFAULT '[]',
    returns  TEXT DEFAULT 'void',
    tags     TEXT DEFAULT '[]',
    body     TEXT DEFAULT '',
    uses     INTEGER DEFAULT 0,
    FOREIGN KEY(lib_id) REFERENCES keyword_libs(id)
  );

  CREATE TABLE IF NOT EXISTS listeners (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    event    TEXT NOT NULL,
    name     TEXT NOT NULL,
    enabled  INTEGER DEFAULT 1,
    body     TEXT DEFAULT ''
  );
`);

// ─── Express + HTTP + WebSocket setup ──────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use('/screenshots', express.static(SHOTS_DIR));
app.use('/results',     express.static(RESULTS_DIR));

// Track active WebSocket clients per runId
const runClients = new Map(); // runId → Set<WebSocket>

wss.on('connection', (ws, req) => {
  // URL format: ws://host/ws?runId=abc123
  const url    = new URL(req.url, 'http://localhost');
  const runId  = url.searchParams.get('runId');

  if (!runId) { ws.close(1008, 'runId required'); return; }

  if (!runClients.has(runId)) runClients.set(runId, new Set());
  runClients.get(runId).add(ws);

  ws.send(JSON.stringify({ type: 'connected', runId, ts: Date.now() }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'stop') stopRun(runId);
    } catch (_) {}
  });

  ws.on('close', () => {
    runClients.get(runId)?.delete(ws);
  });
});

// Broadcast a log event to all clients watching a run
function broadcast(runId, event) {
  const clients = runClients.get(runId);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ─────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────

// ── Suites ───────────────────────────────────────────────────

// GET /api/suites
// Returns all suites (lightweight — steps omitted)
app.get('/api/suites', (req, res) => {
  const rows = db.prepare('SELECT id, name, browser, created, updated FROM suites').all();
  res.json({ suites: rows });
});

// POST /api/suites
// Body: { name, url, browser, steps[] }
// Returns: { id, name, message }
app.post('/api/suites', (req, res) => {
  const { name, url = '', browser = 'chromium', steps = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const info = db.prepare(
    'INSERT INTO suites (name, url, browser, steps) VALUES (?, ?, ?, ?)'
  ).run(name, url, browser, JSON.stringify(steps));

  res.status(201).json({ id: info.lastInsertRowid, name, message: 'Suite created' });
});

// GET /api/suites/:id
// Returns full suite including steps
app.get('/api/suites/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM suites WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, steps: JSON.parse(row.steps) });
});

// PUT /api/suites/:id
// Body: partial suite fields to update
app.put('/api/suites/:id', (req, res) => {
  const { name, url, browser, steps } = req.body;
  const row = db.prepare('SELECT * FROM suites WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.prepare(`
    UPDATE suites SET
      name    = ?,
      url     = ?,
      browser = ?,
      steps   = ?,
      updated = datetime('now')
    WHERE id = ?
  `).run(
    name    ?? row.name,
    url     ?? row.url,
    browser ?? row.browser,
    steps   ? JSON.stringify(steps) : row.steps,
    req.params.id
  );

  res.json({ id: +req.params.id, updated: true });
});

// DELETE /api/suites/:id
app.delete('/api/suites/:id', (req, res) => {
  db.prepare('DELETE FROM suites WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// ── Run a Suite ───────────────────────────────────────────────

// POST /api/suites/:id/run
// Body: { browser, headless, dataTableId }
// Returns: { runId, status: 'queued', suite }
// Side-effect: generates .spec.ts, spawns playwright, streams WS events
app.post('/api/suites/:id/run', async (req, res) => {
  const row = db.prepare('SELECT * FROM suites WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Suite not found' });

  const steps      = JSON.parse(row.steps);
  const runId      = 'run_' + crypto.randomUUID().slice(0, 8);
  const browser    = req.body.browser    || row.browser || 'chromium';
  const headless   = req.body.headless   !== false;
  const dataTableId = req.body.dataTableId;

  // Fetch data table rows if specified
  let dataRows = null;
  if (dataTableId) {
    const tbl = db.prepare('SELECT * FROM tables WHERE id = ?').get(dataTableId);
    if (tbl) dataRows = { cols: JSON.parse(tbl.cols), rows: JSON.parse(tbl.rows) };
  }

  // Record run in DB
  db.prepare(`
    INSERT INTO runs (id, suite_id, suite_name, status, browser, headless)
    VALUES (?, ?, ?, 'queued', ?, ?)
  `).run(runId, row.id, row.name, browser, headless ? 1 : 0);

  // Respond immediately — actual run is async
  res.status(202).json({ runId, status: 'queued', suite: row.name });

  // Generate and execute asynchronously
  setImmediate(() => executeRun(runId, row, steps, browser, headless, dataRows));
});

// POST /api/runs/:runId/stop
app.post('/api/runs/:runId/stop', (req, res) => {
  stopRun(req.params.runId);
  res.json({ stopped: true });
});

// GET /api/runs/:runId/results
app.get('/api/runs/:runId/results', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  // Load step results from disk if available
  const resultFile = path.join(RESULTS_DIR, `${req.params.runId}.json`);
  const steps = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    : [];

  res.json({ run, steps });
});

// GET /api/runs/:runId/screenshot
app.get('/api/runs/:runId/screenshot', (req, res) => {
  const dir   = path.join(SHOTS_DIR, req.params.runId);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.png')) : [];
  res.json({ screenshots: files.map(f => `/screenshots/${req.params.runId}/${f}`) });
});

// ── Objects ───────────────────────────────────────────────────

app.get('/api/objects', (req, res) => {
  res.json({ objects: db.prepare('SELECT * FROM objects').all() });
});

app.post('/api/objects', (req, res) => {
  const { name, page = '', sel, aria = '', css = '', xpath = '', healscore = 80 } = req.body;
  if (!name || !sel) return res.status(400).json({ error: 'name and sel required' });
  const info = db.prepare(
    'INSERT INTO objects (name, page, sel, aria, css, xpath, healscore) VALUES (?,?,?,?,?,?,?)'
  ).run(name, page, sel, aria, css, xpath, healscore);
  res.status(201).json({ id: info.lastInsertRowid, ...req.body });
});

app.put('/api/objects/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM objects WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const u = { ...row, ...req.body };
  db.prepare(
    'UPDATE objects SET name=?,page=?,sel=?,aria=?,css=?,xpath=?,healscore=?,uses=? WHERE id=?'
  ).run(u.name, u.page, u.sel, u.aria, u.css, u.xpath, u.healscore, u.uses, req.params.id);
  res.json({ updated: true });
});

app.delete('/api/objects/:id', (req, res) => {
  db.prepare('DELETE FROM objects WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// ── Data Tables ───────────────────────────────────────────────

app.get('/api/tables', (req, res) => {
  const rows = db.prepare('SELECT * FROM tables').all();
  res.json({ tables: rows.map(r => ({ ...r, cols: JSON.parse(r.cols), rows: JSON.parse(r.rows) })) });
});

app.post('/api/tables', (req, res) => {
  const { name, desc = '', cols = [], rows = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare(
    'INSERT INTO tables (name, desc, cols, rows) VALUES (?,?,?,?)'
  ).run(name, desc, JSON.stringify(cols), JSON.stringify(rows));
  res.status(201).json({ id: info.lastInsertRowid, name, cols, rows });
});

app.put('/api/tables/:id', (req, res) => {
  const { name, desc, cols, rows } = req.body;
  const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE tables SET name=?,desc=?,cols=?,rows=? WHERE id=?')
    .run(name ?? row.name, desc ?? row.desc,
         cols ? JSON.stringify(cols) : row.cols,
         rows ? JSON.stringify(rows) : row.rows,
         req.params.id);
  res.json({ updated: true });
});

app.delete('/api/tables/:id', (req, res) => {
  db.prepare('DELETE FROM tables WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// ── Self-Heal ─────────────────────────────────────────────────

// POST /api/heal
// Body: { selector, fallback, runId }
// Returns: { healed, newSelector, strategy }
app.post('/api/heal', async (req, res) => {
  const { selector, fallback, runId } = req.body;

  // Healing priority order — mirrors PlayArc's locator fingerprint
  const strategies = [
    { type: 'aria',      pattern: /\[aria-label="([^"]+)"\]/   },
    { type: 'testid',    pattern: /\[data-testid="([^"]+)"\]/  },
    { type: 'role',      pattern: /\[role="([^"]+)"\]/         },
    { type: 'css-class', pattern: /\.[\w-]+/                   },
  ];

  // In real implementation: launch a short-lived Playwright context
  // and probe each fallback selector against the live page.
  // Here we return the provided fallback as the healed result.
  const newSelector = fallback || selector;
  const strategy    = strategies.find(s => s.pattern.test(newSelector))?.type || 'fallback';

  if (runId) {
    broadcast(runId, {
      type: 'heal', ts: Date.now(),
      original: selector, healed: newSelector, strategy,
    });
  }

  res.json({ healed: true, newSelector, strategy });
});

// ── Inspector ─────────────────────────────────────────────────

// POST /api/inspect/validate
// Body: { url } | { selector, url }
// Returns: { valid, score, suggestions }
app.post('/api/inspect/validate', (req, res) => {
  const { selector, url } = req.body;
  if (!selector && !url) return res.status(400).json({ error: 'selector or url required' });

  // Score selector stability
  let score = 50;
  if (selector) {
    if (selector.includes('data-testid')) score = 97;
    else if (selector.startsWith('#'))    score = 88;
    else if (selector.includes('aria-label')) score = 82;
    else if (selector.startsWith('.'))   score = 65;
    else if (selector.startsWith('//'))  score = 60;
  }

  res.json({
    valid: true,
    score,
    suggestions: score < 80 ? ['Add data-testid attribute', 'Use aria-label for interactive elements'] : [],
  });
});

// ─────────────────────────────────────────────────────────────
//  PLAYWRIGHT EXECUTION ENGINE
// ─────────────────────────────────────────────────────────────

const activeRuns = new Map(); // runId → child process

function stopRun(runId) {
  const proc = activeRuns.get(runId);
  if (proc) {
    proc.kill('SIGTERM');
    activeRuns.delete(runId);
    broadcast(runId, { type: 'stopped', ts: Date.now() });
    db.prepare("UPDATE runs SET status='stopped', finished=datetime('now') WHERE id=?").run(runId);
  }
}

async function executeRun(runId, suite, steps, browser, headless, dataRows) {
  broadcast(runId, { type: 'status', status: 'running', ts: Date.now() });
  db.prepare("UPDATE runs SET status='running' WHERE id=?").run(runId);

  const startTime = Date.now();

  try {
    // 1. Write keyword helper files to disk
    await writeKeywordFiles();

    // 2. Write the object repo helper
    await writeObjectRepoHelper();

    // 3. Write test listeners (beforeAll/afterAll/etc)
    await writeListenerFile(runId);

    // 4. Generate .spec.ts for this suite
    const specPath = await generateSpec(suite, steps, browser, runId, dataRows);

    broadcast(runId, {
      type: 'log', level: 'INFO',
      msg: `Generated: ${path.basename(specPath)}`,
      ts: Date.now(),
    });

    // 5. Spawn Playwright
    const args = [
      'playwright', 'test', specPath,
      '--project', browser,
      headless ? '--headed=false' : '--headed',
      '--reporter=json',
      `--output=${path.join(RESULTS_DIR, runId)}`,
    ];

    broadcast(runId, {
      type: 'log', level: 'INFO',
      msg: `Spawning: npx ${args.join(' ')}`,
      ts: Date.now(),
    });

    await new Promise((resolve, reject) => {
      const proc = spawn('npx', args, {
        cwd: process.cwd(),
        env: { ...process.env, PWTEST_RUN_ID: runId },
      });

      activeRuns.set(runId, proc);

      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(line => {
          // Parse Playwright JSON reporter output
          try {
            const event = JSON.parse(line);
            handlePlaywrightEvent(runId, event);
          } catch (_) {
            // Raw stdout line
            broadcast(runId, { type: 'log', level: 'INFO', msg: line.trim(), ts: Date.now() });
          }
        });
      });

      proc.stderr.on('data', (data) => {
        broadcast(runId, {
          type: 'log', level: 'WARN',
          msg: data.toString().trim(),
          ts: Date.now(),
        });
      });

      proc.on('close', (code) => {
        activeRuns.delete(runId);
        if (code === 0) resolve();
        else reject(new Error(`Playwright exited with code ${code}`));
      });

      proc.on('error', reject);
    });

    // 6. Parse results and update DB
    const resultFile = path.join(RESULTS_DIR, runId, 'results.json');
    if (fs.existsSync(resultFile)) {
      const results = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      const { passed, failed } = tallyCounts(results);
      const duration = (Date.now() - startTime) / 1000;

      db.prepare(`
        UPDATE runs SET status=?, passed=?, failed=?, duration=?, finished=datetime('now')
        WHERE id=?
      `).run(failed > 0 ? 'failed' : 'passed', passed, failed, duration, runId);

      broadcast(runId, {
        type: 'complete',
        status: failed > 0 ? 'failed' : 'passed',
        passed, failed, duration,
        ts: Date.now(),
      });
    }

  } catch (err) {
    console.error(`[Run ${runId}] Error:`, err.message);
    db.prepare("UPDATE runs SET status='error', finished=datetime('now') WHERE id=?").run(runId);
    broadcast(runId, {
      type: 'error',
      msg: err.message,
      ts: Date.now(),
    });
  }
}

function handlePlaywrightEvent(runId, event) {
  // Playwright JSON reporter emits: { type: 'begin'|'end'|'testBegin'|'testEnd'|'stepBegin'|'stepEnd' }
  switch (event.type) {
    case 'testBegin':
      broadcast(runId, {
        type: 'log', level: 'STEP',
        msg: `▶ ${event.test?.title || 'Test started'}`,
        ts: Date.now(),
      });
      break;
    case 'stepBegin':
      broadcast(runId, {
        type: 'step', status: 'running',
        title: event.step?.title,
        ts: Date.now(),
      });
      break;
    case 'stepEnd':
      broadcast(runId, {
        type: 'step',
        status: event.step?.error ? 'failed' : 'passed',
        title: event.step?.title,
        duration: event.step?.duration,
        error: event.step?.error?.message,
        ts: Date.now(),
      });
      broadcast(runId, {
        type: 'log',
        level: event.step?.error ? 'FAIL' : 'PASS',
        msg: `${event.step?.error ? '✗' : '✓'} ${event.step?.title} (${event.step?.duration}ms)`,
        ts: Date.now(),
      });
      break;
    case 'testEnd':
      broadcast(runId, {
        type: 'log',
        level: event.test?.status === 'passed' ? 'PASS' : 'FAIL',
        msg: `${event.test?.status === 'passed' ? '✓' : '✗'} ${event.test?.title}`,
        ts: Date.now(),
      });
      break;
  }
}

function tallyCounts(results) {
  let passed = 0, failed = 0;
  (results.suites || []).forEach(suite => {
    (suite.specs || []).forEach(spec => {
      (spec.tests || []).forEach(test => {
        if (test.status === 'passed') passed++;
        else failed++;
      });
    });
  });
  return { passed, failed };
}

// ─────────────────────────────────────────────────────────────
//  CODE GENERATION
// ─────────────────────────────────────────────────────────────

// Generate a .spec.ts file from a suite definition
async function generateSpec(suite, steps, browser, runId, dataRows) {
  const specDir  = path.join(TESTS_DIR, 'specs');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, `${suite.name.replace(/\s+/g, '-')}-${runId}.spec.ts`);

  // Collect unique keyword libraries used
  const keywordLibs = db.prepare('SELECT * FROM keyword_libs').all();
  const keywords    = db.prepare('SELECT * FROM keywords').all();
  const usedLibIds  = [...new Set(
    steps.filter(s => s.action === 'keyword' && s.kwLib).map(s => s.kwLib)
  )];
  const usedLibs = keywordLibs.filter(l => usedLibIds.includes(l.id));

  // Build import block
  const imports = [
    `import { test, expect } from '@playwright/test';`,
    `import { obj } from '../helpers/objectRepo';`,
    ...usedLibs.map(l => `import { ${l.name} } from '../keywords/${l.name}';`),
    ``,
  ];

  // Build data rows injection if data-driven
  const dataBlock = dataRows
    ? `const DATA_ROWS = ${JSON.stringify(dataRows.rows)};\nconst DATA_COLS = ${JSON.stringify(dataRows.cols)};\n`
    : '';

  // Generate test body — wrap in data loop if data-driven
  const wrapData  = dataRows && dataRows.rows.length > 0;
  const outerLoop = wrapData
    ? `for (const _row of DATA_ROWS) {\n  const data = Object.fromEntries(DATA_COLS.map((c,i) => [c, _row[i]]));\n`
    : '';
  const outerClose = wrapData ? `\n}` : '';

  // Generate each step
  const stepLines = steps.map((step, i) => generateStepCode(step, i, keywords, keywordLibs)).join('\n');

  const spec = [
    ...imports,
    dataBlock,
    `test.describe('${suite.name}', () => {`,
    `  test('${suite.name}', async ({ page }) => {`,
    // Instantiate keyword classes
    ...usedLibs.map(l => `    const ${l.name.charAt(0).toLowerCase() + l.name.slice(1)} = new ${l.name}(page);`),
    ``,
    outerLoop ? '    ' + outerLoop.split('\n').join('\n    ') : '',
    stepLines.split('\n').map(l => '    ' + l).join('\n'),
    outerClose ? '    ' + outerClose : '',
    `  });`,
    `});`,
  ].join('\n');

  fs.writeFileSync(specPath, spec, 'utf8');
  return specPath;
}

function generateStepCode(step, index, keywords, keywordLibs) {
  const sel = step.selector ? `'${step.selector}'` : null;
  // Resolve data binding: {{colName}} → data.colName
  const val = step.value
    ? step.value.replace(/\{\{(\w+)\}\}/g, (_, k) => `\${data.${k}}`)
    : '';
  const valExpr = val.includes('${') ? `\`${val}\`` : `'${val}'`;
  const comment = `// Step ${index + 1}: ${step.desc || step.action}`;

  switch (step.action) {
    case 'navigate':
      return `${comment}\nawait page.goto(${valExpr});`;
    case 'click':
      return `${comment}\nawait page.click(${sel});`;
    case 'fill':
      return `${comment}\nawait page.fill(${sel}, ${valExpr});`;
    case 'assert_text':
      return `${comment}\nawait expect(page.locator(${sel})).toContainText(${valExpr});`;
    case 'wait':
      return `${comment}\nawait page.waitForSelector(${sel}, { timeout: ${+step.value || 30000} });`;
    case 'screenshot': {
      const name = step.value || `step-${index + 1}`;
      return `${comment}\nawait page.screenshot({ path: 'screenshots/${name}.png', fullPage: true });`;
    }
    case 'hover':
      return `${comment}\nawait page.hover(${sel});`;
    case 'key':
      return `${comment}\nawait page.keyboard.press('${step.value || 'Enter'}');`;
    case 'select':
      return `${comment}\nawait page.selectOption(${sel}, ${valExpr});`;
    case 'js':
      return `${comment}\nawait page.evaluate(() => { ${step.value} });`;
    case 'keyword': {
      const lib = keywordLibs.find(l => l.id === step.kwLib);
      const kw  = lib ? keywords.find(k => k.id === step.kwId) : null;
      if (!kw || !lib) return `// [keyword step — not resolved]\n// TODO: select keyword for step ${index + 1}`;
      const instanceName = lib.name.charAt(0).toLowerCase() + lib.name.slice(1);
      const args = (step.kwArgs || []).map(a => JSON.stringify(a)).join(', ');
      return `${comment}\nawait ${instanceName}.${kw.name}(${args});`;
    }
    default:
      return `// [unknown action: ${step.action}]`;
  }
}

// Write one TypeScript file per keyword library
async function writeKeywordFiles() {
  const libs     = db.prepare('SELECT * FROM keyword_libs').all();
  const keywords = db.prepare('SELECT * FROM keywords').all();

  for (const lib of libs) {
    const kws = keywords.filter(k => k.lib_id === lib.id);
    const methods = kws.map(kw => {
      const params = JSON.parse(kw.params || '[]').map(p => `${p.name}: ${p.type}`).join(', ');
      return [
        `  /**`,
        `   * ${kw.desc}`,
        `   */`,
        `  async ${kw.name}(${params}): Promise<${kw.returns}> {`,
        ...kw.body.split('\n').map(l => `    ${l}`),
        `  }`,
      ].join('\n');
    }).join('\n\n');

    const ts = [
      `import { Page, expect } from '@playwright/test';`,
      `import { obj } from '../helpers/objectRepo';`,
      ``,
      `/**`,
      ` * ${lib.name}`,
      ` * Package: ${lib.pkg}`,
      ` * ${lib.desc || ''}`,
      ` */`,
      `export class ${lib.name} {`,
      `  constructor(private readonly page: Page) {}`,
      ``,
      methods,
      `}`,
    ].join('\n');

    fs.writeFileSync(path.join(TESTS_DIR, 'keywords', `${lib.name}.ts`), ts, 'utf8');
  }
}

// Write the objectRepo helper — maps "Page/ElementName" to a Playwright locator
async function writeObjectRepoHelper() {
  const objects = db.prepare('SELECT * FROM objects').all();

  const entries = objects.map(o => {
    const key = `${o.page}/${o.name}`.replace(/\s+/g, '');
    return `  '${key}': { sel: ${JSON.stringify(o.sel)}, aria: ${JSON.stringify(o.aria)}, css: ${JSON.stringify(o.css)}, xpath: ${JSON.stringify(o.xpath)} }`;
  }).join(',\n');

  const ts = [
    `import { Page } from '@playwright/test';`,
    ``,
    `const REPO: Record<string, { sel: string; aria: string; css: string; xpath: string }> = {`,
    entries,
    `};`,
    ``,
    `/**`,
    ` * obj('Page/ElementName') — returns a Playwright Locator using the best available selector.`,
    ` * Falls back through: data-testid → aria-label → css → xpath`,
    ` * This mirrors Katalon's findTestObject('Page/elementName') pattern.`,
    ` */`,
    `export function obj(page: Page, key: string) {`,
    `  const entry = REPO[key.replace(/\\s+/g, '')];`,
    `  if (!entry) throw new Error(\`Object not found in repo: \${key}\`);`,
    `  // Healing priority: testid → aria → css → xpath`,
    `  if (entry.sel)   return page.locator(entry.sel);`,
    `  if (entry.aria)  return page.locator(entry.aria);`,
    `  if (entry.css)   return page.locator(entry.css);`,
    `  return page.locator(entry.xpath);`,
    `}`,
  ].join('\n');

  fs.writeFileSync(path.join(TESTS_DIR, 'helpers', 'objectRepo.ts'), ts, 'utf8');
}

// Write a global setup file that implements Test Listeners as Playwright fixtures
async function writeListenerFile(runId) {
  const listeners = db.prepare('SELECT * FROM listeners WHERE enabled=1').all();

  const hooks = {
    beforeAll: listeners.filter(l => l.event === 'beforeSuite').map(l => l.body),
    afterAll:  listeners.filter(l => l.event === 'afterSuite').map(l => l.body),
    beforeEach: listeners.filter(l => l.event === 'beforeStep').map(l => l.body),
    afterEach: listeners.filter(l => l.event === 'afterStep').map(l => l.body),
  };

  const ts = [
    `import { test as base } from '@playwright/test';`,
    ``,
    `// Auto-generated Test Listeners — mirrors Katalon's @BeforeTestSuite / @AfterTestSuite`,
    `export const test = base.extend({`,
    `  page: async ({ page }, use) => {`,
    hooks.beforeEach.length ? `    // beforeStep listeners\n    ${hooks.beforeEach.join('\n    ')}` : '',
    `    await use(page);`,
    hooks.afterEach.length  ? `    // afterStep listeners\n    ${hooks.afterEach.join('\n    ')}` : '',
    `  },`,
    `});`,
    ``,
    `export { expect } from '@playwright/test';`,
  ].join('\n');

  fs.writeFileSync(path.join(TESTS_DIR, 'helpers', 'fixtures.ts'), ts, 'utf8');
}

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  PlayArc Server  →  localhost:${PORT}     ║
║  REST   http://localhost:${PORT}/api      ║
║  WS     ws://localhost:${PORT}/ws         ║
║  DB     ${DB_PATH.padEnd(28)}║
╚════════════════════════════════════════╝
  `);
});
