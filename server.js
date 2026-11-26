'use strict';
require('dotenv').config();

const express   = require('express');
const { Pool }  = require('pg');
const cors      = require('cors');
const crypto    = require('crypto');
const path      = require('path');
const fs        = require('fs');
const XLSX      = require('xlsx');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { saveExpenseImage, getDriveMode, deleteExpenseImage } = require('./googleDriveService');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Vercel / reverse-proxy X-Forwarded-For header so express-rate-limit works accurately
app.set('trust proxy', 1);

// ─── SEC-002 FIX: Fail fast if required env vars are missing ────────────────
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[FATAL] Missing required environment variable: ${name}`);
    console.error(`        Set it in your .env file or Vercel environment settings.`);
    process.exit(1);
  }
  return v;
}

const OWNER_USERNAME     = process.env.OWNER_USERNAME     || 'owner';
const OWNER_PASSWORD     = process.env.OWNER_PASSWORD_HASH || requireEnv('OWNER_PASSWORD');
const ASSISTANT_USERNAME = process.env.ASSISTANT_USERNAME || 'assistant';
const ASSISTANT_PASSWORD = process.env.ASSISTANT_PASSWORD_HASH || requireEnv('ASSISTANT_PASSWORD');
const TOKEN_SECRET       = requireEnv('TOKEN_SECRET');
const TOKEN_EXPIRES_IN   = '48h';

// ─── Password Verification (bcrypt + timingSafeEqual fallback) ──────────────
function isBcryptHash(val) {
  return typeof val === 'string' && /^\$2[aby]\$\d{2}\$/.test(val);
}

function timingSafeTextEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

async function verifyPassword(inputPassword, storedPasswordOrHash) {
  if (isBcryptHash(storedPasswordOrHash)) {
    return bcrypt.compare(inputPassword, storedPasswordOrHash);
  }
  return timingSafeTextEqual(inputPassword, storedPasswordOrHash);
}

// ─── DB Pool (PostgreSQL / Supabase) ─────────────────────────────────────────
function buildSslConfig() {
  const caCertEnv = process.env.SUPABASE_CA_CERT;
  const caCertPath = path.join(__dirname, 'supabase-ca.crt');
  if (caCertEnv) {
    return { rejectUnauthorized: true, ca: caCertEnv.replace(/\\n/g, '\n') };
  }
  if (fs.existsSync(caCertPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caCertPath, 'utf8') };
  }
  if (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true') {
    return { rejectUnauthorized: true };
  }
  console.warn('[SECURITY WARN] DB SSL rejectUnauthorized is false. Set SUPABASE_CA_CERT or place supabase-ca.crt in root to pin the Supabase CA certificate.');
  return { rejectUnauthorized: false };
}

const connectionString = process.env.DATABASE_URL;
const poolConfig = {
  max: parseInt(process.env.DB_POOL_MAX || (process.env.VERCEL ? '2' : '5'), 10),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
};
const pool = connectionString
  ? new Pool({ connectionString, ssl: buildSslConfig(), ...poolConfig })
  : new Pool({
      host    : process.env.DB_HOST     || 'localhost',
      user    : process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'postgres',
      port    : parseInt(process.env.DB_PORT || '5432', 10),
      ssl     : process.env.DB_SSL === 'true' ? buildSslConfig() : undefined,
      ...poolConfig
    });

// ─── SEC-008 FIX: Sanitised DB error handler ─────────────────────────────────
function handleDbError(res, err) {
  console.error('[DB ERROR]', err.message);
  return res.status(500).json({ error: 'An internal error occurred. Please try again.' });
}

// ─── Input Validation Helpers ────────────────────────────────────────────────
function parseAmount(val) {
  const n = parseFloat(val);
  if (!Number.isFinite(n) || n <= 0 || n > 99999999) return null;
  return Math.round(n * 100) / 100;
}

function validateText(val, maxLen, fieldName, { required = false } = {}) {
  if (val == null || String(val).trim() === '') {
    if (required) return { error: `${fieldName} is required` };
    return { value: null };
  }
  const trimmed = String(val).trim();
  if (trimmed.length > maxLen) {
    return { error: `${fieldName} must be at most ${maxLen} characters` };
  }
  return { value: trimmed };
}

function isValidReceiptUrl(url) {
  if (url === null || url === undefined || url === '') return true;
  if (typeof url !== 'string') return false;
  if (url.length > 1000) return false;
  if (url.startsWith('/uploads/') && !url.includes('..')) return true;
  if (/^https:\/\/(drive|docs)\.google\.com\//.test(url)) return true;
  return false;
}

function parsePagination(query) {
  if (query.limit === undefined && query.offset === undefined) return null;
  const rawLimit = parseInt(query.limit ?? '50', 10);
  const rawOffset = parseInt(query.offset ?? '0', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  return { limit, offset };
}

// ─── Audit Log Helper ────────────────────────────────────────────────────────
async function logAudit(db, { actor, role, action, targetTable, targetId, details = null }) {
  try {
    await db.query(
      'INSERT INTO audit_log (actor, role, action, target_table, target_id, details) VALUES ($1, $2, $3, $4, $5, $6)',
      [actor || 'unknown', role || 'unknown', action, targetTable, String(targetId), details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.warn('[AUDIT LOG NOTE]:', err.message);
  }
}

// ─── SEC-007 FIX: Security headers via Helmet (strict scriptSrc, no unsafe-inline) ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc    : ["'self'"],
      scriptSrc     : ["'self'"],
      styleSrc      : ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc       : ["'self'", "https://fonts.gstatic.com"],
      imgSrc        : ["'self'", "data:", "blob:", "https://img.icons8.com", "https://drive.google.com", "https://*.googleusercontent.com"],
      connectSrc    : ["'self'"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ─── SEC-004 FIX: Restrict CORS to allowed origins ───────────────────────────
const rawAllowedOrigins = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = rawAllowedOrigins
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true); // dev fallback
    const normalized = origin.replace(/\/+$/, '');
    if (allowedOrigins.includes(normalized)) return cb(null, true);
    const err = new Error(`CORS: origin ${origin} not allowed`);
    err.status = 403;
    cb(err);
  },
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// ─── SEC-006 FIX: Serve only the public/ subdirectory ────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ─── Serve Homepage ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const p = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send('index.html not found');
});

// ─── Serve PWA Static Files ───────────────────────────────────────────────────
const manifestData = require('./public/manifest.json');

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json(manifestData);
});

const swScript = `// SR Builders Service Worker
const CACHE_NAME = 'srbuilders-v3';
const ASSETS_TO_CACHE = ['/', '/index.html', '/app.js', '/sw-register.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
  ));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/api/')) { event.respondWith(fetch(event.request)); return; }
  // Stale-while-revalidate for static assets (instant repeat loads + background refresh)
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request).then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            cache.put(event.request, response.clone());
          }
          return response;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    )
  );
});`;

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(swScript);
});

let icon192 = null, icon512 = null;
try { const p = path.join(__dirname, 'public', 'icon-192.png'); if (fs.existsSync(p)) icon192 = fs.readFileSync(p); } catch (e) {}
try { const p = path.join(__dirname, 'public', 'icon-512.png'); if (fs.existsSync(p)) icon512 = fs.readFileSync(p); } catch (e) {}

app.get('/icon-192.png', (req, res) => {
  if (icon192) { res.setHeader('Content-Type', 'image/png'); return res.send(icon192); }
  res.redirect('https://img.icons8.com/color/192/construction.png');
});
app.get('/icon-512.png', (req, res) => {
  if (icon512) { res.setHeader('Content-Type', 'image/png'); return res.send(icon512); }
  res.redirect('https://img.icons8.com/color/512/construction.png');
});

// ─── Token helpers (jsonwebtoken HS256) ───────────────────────────────────────
function makeToken(role, username) {
  return jwt.sign({ role, username }, TOKEN_SECRET, {
    algorithm: 'HS256',
    expiresIn: TOKEN_EXPIRES_IN
  });
}

function parseToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, TOKEN_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing authentication token' });
  const data = parseToken(authHeader.slice(7));
  if (!data) return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  req.role = data.role;
  req.username = data.username;
  next();
}

function ownerOnly(req, res, next) {
  verifyToken(req, res, () => {
    if (req.role !== 'owner') return res.status(403).json({ error: 'Owner/Executive access required' });
    next();
  });
}

function anyRole(req, res, next) { verifyToken(req, res, next); }

// ─── Single Startup / Deploy-Time DB Schema Initializer ──────────────────────
let schemaPromise = null;
function initDatabaseSchema({ force = false } = {}) {
  if (!force && process.env.SKIP_RUNTIME_SCHEMA === 'true') {
    return Promise.resolve();
  }
  if (!force && schemaPromise) return schemaPromise;
  const run = (async () => {
    try {
      await pool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_url TEXT');
      await pool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS added_by TEXT');
      await pool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL');

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_expenses_site_active
          ON expenses (site_id, expense_date, id)
          WHERE deleted_at IS NULL
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_expenses_dedup
          ON expenses (site_id, expense_date, created_at)
          WHERE deleted_at IS NULL
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_advances_site_date
          ON advance_payments (site_id, payment_date, id)
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id SERIAL PRIMARY KEY,
          actor TEXT NOT NULL,
          role VARCHAR(20) NOT NULL,
          action VARCHAR(30) NOT NULL,
          target_table VARCHAR(40) NOT NULL,
          target_id TEXT NOT NULL,
          details JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await pool.query('CREATE SEQUENCE IF NOT EXISTS site_id_seq START WITH 1');
      await pool.query(`
        SELECT setval(
          'site_id_seq',
          GREATEST(
            COALESCE((SELECT MAX(CAST(SUBSTRING(site_id, 2) AS INTEGER)) FROM sites WHERE site_id ~ '^S[0-9]+$'), 0),
            (SELECT last_value FROM site_id_seq)
          )
        )
      `);

      await pool.query(`
        CREATE OR REPLACE VIEW v_expense_ledger WITH (security_invoker = true) AS
        SELECT 
          e.id,
          e.site_id,
          s.site_name,
          e.expense_date,
          e.description,
          e.amount,
          SUM(e.amount) OVER (PARTITION BY e.site_id ORDER BY e.expense_date, e.id) AS cumulative_expense,
          e.receipt_url,
          e.added_by
        FROM expenses e
        JOIN sites s ON e.site_id = s.site_id
        WHERE e.deleted_at IS NULL
      `);

      await pool.query(`
        CREATE OR REPLACE VIEW v_sites_summary WITH (security_invoker = true) AS
        SELECT 
          s.site_id,
          s.site_name,
          s.client_name,
          s.status,
          COALESCE(adv.total_advance, 0) AS total_advance,
          COALESCE(exp.total_expenses, 0) AS total_expenses,
          COALESCE(adv.total_advance, 0) - COALESCE(exp.total_expenses, 0) AS difference
        FROM sites s
        LEFT JOIN (
          SELECT site_id, SUM(amount) AS total_advance 
          FROM advance_payments 
          GROUP BY site_id
        ) adv ON s.site_id = adv.site_id
        LEFT JOIN (
          SELECT site_id, SUM(amount) AS total_expenses 
          FROM expenses 
          WHERE deleted_at IS NULL
          GROUP BY site_id
        ) exp ON s.site_id = exp.site_id
      `);

      console.log('[DB] Schema verified (columns, indexes, views, audit_log, site_id_seq ready)');
    } catch (err) {
      schemaPromise = null; // allow retry if transient DB error
      if (force) throw err;
      console.warn('[DB SCHEMA NOTE]:', err.message);
    }
  })();
  if (!force) schemaPromise = run;
  return run;
}

// Run schema check once per cold-start only on DB-backed routes (never blocks /login, /health, /drive/status)
app.use('/api', async (req, res, next) => {
  if (req.path === '/login' || req.path === '/health' || req.path === '/drive/status') {
    return next();
  }
  await initDatabaseSchema();
  next();
});

// ─── Auto site_id helper (PostgreSQL sequence — race-safe) ──────────────────
async function nextSiteId(client) {
  const res = await client.query("SELECT nextval('site_id_seq') AS seq");
  return 'S' + String(res.rows[0].seq).padStart(3, '0');
}

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// ─── SEC-003 FIX: Rate-limit the login endpoint ───────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

// POST /api/login
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Please enter User ID and Password' });

    const u = String(username).trim().toLowerCase();
    const p = String(password).trim();

    if (timingSafeTextEqual(u, OWNER_USERNAME.toLowerCase()) && await verifyPassword(p, OWNER_PASSWORD))
      return res.json({ role: 'owner', username: OWNER_USERNAME, token: makeToken('owner', OWNER_USERNAME) });

    if (timingSafeTextEqual(u, ASSISTANT_USERNAME.toLowerCase()) && await verifyPassword(p, ASSISTANT_PASSWORD))
      return res.json({ role: 'assistant', username: ASSISTANT_USERNAME, token: makeToken('assistant', ASSISTANT_USERNAME) });

    return res.status(401).json({ error: 'Incorrect User ID or Password' });
  } catch (err) {
    handleDbError(res, err);
  }
});

// GET /api/sites
app.get('/api/sites', anyRole, async (req, res) => {
  try { res.json((await pool.query('SELECT site_id, site_name FROM sites ORDER BY site_id')).rows); }
  catch (err) { handleDbError(res, err); }
});

// GET /api/sites/summary
app.get('/api/sites/summary', ownerOnly, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM v_sites_summary ORDER BY site_id')).rows); }
  catch (err) { handleDbError(res, err); }
});

// POST /api/sites
app.post('/api/sites', ownerOnly, async (req, res) => {
  const siteCheck = validateText(req.body.site_name, 100, 'site_name', { required: true });
  if (siteCheck.error) return res.status(400).json({ error: siteCheck.error });
  const clientCheck = validateText(req.body.client_name, 100, 'client_name');
  if (clientCheck.error) return res.status(400).json({ error: clientCheck.error });

  const { start_date } = req.body;
  const client = await pool.connect();
  try {
    const site_id = await nextSiteId(client);
    await client.query(
      'INSERT INTO sites (site_id, site_name, client_name, start_date) VALUES ($1, $2, $3, $4)',
      [site_id, siteCheck.value, clientCheck.value, start_date || null]
    );
    await logAudit(client, {
      actor: req.username, role: req.role, action: 'CREATE',
      targetTable: 'sites', targetId: site_id,
      details: { site_name: siteCheck.value }
    });
    res.status(201).json({ site_id, site_name: siteCheck.value, client_name: clientCheck.value, start_date: start_date || null });
  } catch (err) { handleDbError(res, err); } finally { client.release(); }
});

// PUT /api/sites/:id/status
app.put('/api/sites/:id/status', ownerOnly, async (req, res) => {
  const { status } = req.body;
  if (!['active', 'completed', 'on-hold'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  try {
    const r = await pool.query('UPDATE sites SET status=$1 WHERE site_id=$2', [status, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Site not found' });
    await logAudit(pool, {
      actor: req.username, role: req.role, action: 'UPDATE_STATUS',
      targetTable: 'sites', targetId: req.params.id, details: { status }
    });
    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// PUT /api/sites/:id
app.put('/api/sites/:id', ownerOnly, async (req, res) => {
  const siteCheck = validateText(req.body.site_name, 100, 'Site name', { required: true });
  if (siteCheck.error) return res.status(400).json({ error: siteCheck.error });
  const clientCheck = validateText(req.body.client_name, 100, 'Client name');
  if (clientCheck.error) return res.status(400).json({ error: clientCheck.error });

  const { status, start_date } = req.body;
  if (status && !['active', 'completed', 'on-hold'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  try {
    const r = await pool.query(
      'UPDATE sites SET site_name=$1, client_name=$2, status=$3, start_date=$4 WHERE site_id=$5',
      [siteCheck.value, clientCheck.value, status || 'active', start_date || null, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Site not found' });
    await logAudit(pool, {
      actor: req.username, role: req.role, action: 'UPDATE',
      targetTable: 'sites', targetId: req.params.id, details: { site_name: siteCheck.value }
    });
    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// DELETE /api/sites/:id (wrapped in BEGIN/COMMIT transaction)
app.delete('/api/sites/:id', ownerOnly, async (req, res) => {
  const client = await pool.connect();
  let receiptUrls = [];
  try {
    await client.query('BEGIN');
    const expRes = await client.query('SELECT receipt_url FROM expenses WHERE site_id=$1 AND receipt_url IS NOT NULL', [req.params.id]);
    receiptUrls = expRes.rows.map(r => r.receipt_url).filter(Boolean);

    await client.query('DELETE FROM expenses WHERE site_id=$1', [req.params.id]);
    await client.query('DELETE FROM advance_payments WHERE site_id=$1', [req.params.id]);
    const delSite = await client.query('DELETE FROM sites WHERE site_id=$1', [req.params.id]);
    if (delSite.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Site not found' });
    }

    await logAudit(client, {
      actor: req.username, role: req.role, action: 'DELETE',
      targetTable: 'sites', targetId: req.params.id
    });
    await client.query('COMMIT');

    // Delete Drive/local images only after DB transaction commits
    receiptUrls.forEach(url => {
      deleteExpenseImage(url).catch(e => console.warn('[DRIVE DELETE NOTE]:', e.message));
    });

    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleDbError(res, err);
  } finally {
    client.release();
  }
});

// GET /api/sites/:id/expenses (supports optional ?limit=&offset=)
app.get('/api/sites/:id/expenses', anyRole, async (req, res) => {
  try {
    const page = parsePagination(req.query);
    let sql = `
      SELECT 
        e.id,
        e.site_id,
        s.site_name,
        e.expense_date,
        e.description,
        e.amount,
        e.receipt_url,
        e.added_by,
        SUM(e.amount) OVER (PARTITION BY e.site_id ORDER BY e.expense_date, e.id) AS cumulative_expense
      FROM expenses e
      JOIN sites s ON e.site_id = s.site_id
      WHERE e.site_id = $1 AND e.deleted_at IS NULL
      ORDER BY e.expense_date, e.id
    `;
    const params = [req.params.id];
    if (page) {
      sql += ' LIMIT $2 OFFSET $3';
      params.push(page.limit, page.offset);
    }
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) { handleDbError(res, err); }
});

// POST /api/sites/:id/expenses
app.post('/api/sites/:id/expenses', anyRole, async (req, res) => {
  const { expense_date, amount, image, receipt_url } = req.body;
  const descCheck = validateText(req.body.description, 255, 'description', { required: true });
  if (!expense_date || descCheck.error || amount == null)
    return res.status(400).json({ error: descCheck.error || 'expense_date, description and amount are required' });

  const validAmount = parseAmount(amount);
  if (validAmount === null) return res.status(400).json({ error: 'Amount must be a positive number up to 99,999,999' });

  if (!isValidReceiptUrl(receipt_url))
    return res.status(400).json({ error: 'Invalid receipt_url' });

  try {
    // DB-backed deduplication across serverless instances (blocks identical rapid clicks within 4s)
    const dupCheck = await pool.query(
      `SELECT id, receipt_url FROM expenses
       WHERE site_id=$1 AND expense_date=$2 AND description=$3 AND amount=$4
         AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '4 seconds'
       ORDER BY id DESC LIMIT 1`,
      [req.params.id, expense_date, descCheck.value, validAmount]
    );
    if (dupCheck.rowCount > 0) {
      console.log(`[DEDUP] Duplicate click blocked for expense on site ${req.params.id}`);
      return res.status(200).json(dupCheck.rows[0]);
    }

    let finalReceiptUrl = receipt_url || null;

    if (image && image.data) {
      try {
        const siteRes = await pool.query('SELECT site_name FROM sites WHERE site_id=$1', [req.params.id]);
        const siteName = siteRes.rows[0] ? siteRes.rows[0].site_name : req.params.id;
        const uploadRes = await saveExpenseImage({
          siteId: req.params.id,
          siteName: siteName,
          description: descCheck.value,
          expenseDate: expense_date,
          imageBase64: image.data,
          mimeType: image.type || 'image/jpeg'
        });
        if (uploadRes && uploadRes.viewUrl) {
          finalReceiptUrl = uploadRes.viewUrl;
          console.log('[EXPENSE SAVED] Receipt URL:', finalReceiptUrl);
        }
      } catch (imgErr) {
        console.error('[IMAGE UPLOAD ERROR]:', imgErr.message);
      }
    }

    const r = await pool.query(
      'INSERT INTO expenses (site_id, expense_date, description, amount, receipt_url, added_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, receipt_url',
      [req.params.id, expense_date, descCheck.value, validAmount, finalReceiptUrl, req.username]
    );
    await logAudit(pool, {
      actor: req.username, role: req.role, action: 'CREATE',
      targetTable: 'expenses', targetId: r.rows[0].id,
      details: { site_id: req.params.id, amount: validAmount }
    });
    res.status(201).json({ id: r.rows[0].id, receipt_url: r.rows[0].receipt_url });
  } catch (err) { handleDbError(res, err); }
});

// PUT /api/expenses/:id
app.put('/api/expenses/:id', anyRole, async (req, res) => {
  const { expense_date, amount, image, receipt_url } = req.body;
  const descCheck = validateText(req.body.description, 255, 'description', { required: true });
  if (!expense_date || descCheck.error || amount == null)
    return res.status(400).json({ error: descCheck.error || 'expense_date, description and amount are required' });

  const validAmount = parseAmount(amount);
  if (validAmount === null) return res.status(400).json({ error: 'Amount must be a positive number up to 99,999,999' });

  if (receipt_url !== undefined && !isValidReceiptUrl(receipt_url))
    return res.status(400).json({ error: 'Invalid receipt_url' });

  try {
    const check = await pool.query('SELECT id, site_id, receipt_url, added_by FROM expenses WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (check.rowCount === 0) return res.status(404).json({ error: 'Expense not found' });
    const existing = check.rows[0];

    if (req.role !== 'owner' && existing.added_by !== req.username) {
      return res.status(403).json({ error: 'You can only edit your own expense entries' });
    }

    let finalReceiptUrl = receipt_url !== undefined ? (receipt_url || null) : existing.receipt_url;

    if (image && image.data) {
      try {
        const siteRes = await pool.query('SELECT site_name FROM sites WHERE site_id=$1', [existing.site_id]);
        const siteName = siteRes.rows[0] ? siteRes.rows[0].site_name : existing.site_id;
        const uploadRes = await saveExpenseImage({
          siteId: existing.site_id,
          siteName: siteName,
          description: descCheck.value,
          expenseDate: expense_date,
          imageBase64: image.data,
          mimeType: image.type || 'image/jpeg'
        });
        if (uploadRes && uploadRes.viewUrl) {
          finalReceiptUrl = uploadRes.viewUrl;
        }
      } catch (imgErr) {
        console.error('[IMAGE UPLOAD ERROR]:', imgErr.message);
      }
    }

    const r = await pool.query(
      'UPDATE expenses SET expense_date=$1, description=$2, amount=$3, receipt_url=$4 WHERE id=$5 AND deleted_at IS NULL RETURNING id, site_id, expense_date, description, amount, receipt_url',
      [expense_date, descCheck.value, validAmount, finalReceiptUrl, req.params.id]
    );

    if (existing.receipt_url && finalReceiptUrl !== existing.receipt_url) {
      deleteExpenseImage(existing.receipt_url).catch(e => console.warn('[DRIVE DELETE NOTE]:', e.message));
    }

    await logAudit(pool, {
      actor: req.username, role: req.role, action: 'UPDATE',
      targetTable: 'expenses', targetId: req.params.id,
      details: { amount: validAmount }
    });

    res.json({ ok: true, expense: r.rows[0] });
  } catch (err) { handleDbError(res, err); }
});

// DELETE /api/expenses/:id (soft delete + ownership check + audit log)
app.delete('/api/expenses/:id', anyRole, async (req, res) => {
  try {
    const check = await pool.query('SELECT id, receipt_url, added_by FROM expenses WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (check.rowCount === 0) return res.status(404).json({ error: 'Expense not found' });
    const existing = check.rows[0];

    if (req.role !== 'owner' && existing.added_by !== req.username) {
      return res.status(403).json({ error: 'You can only delete your own expense entries' });
    }

    await pool.query('UPDATE expenses SET deleted_at = NOW() WHERE id=$1', [req.params.id]);

    if (existing.receipt_url) {
      deleteExpenseImage(existing.receipt_url).catch(e => console.warn('[DRIVE DELETE NOTE]:', e.message));
    }

    await logAudit(pool, {
      actor: req.username, role: req.role, action: 'SOFT_DELETE',
      targetTable: 'expenses', targetId: req.params.id
    });

    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// GET /api/sites/:id/advances (supports optional ?limit=&offset=)
app.get('/api/sites/:id/advances', ownerOnly, async (req, res) => {
  try {
    const page = parsePagination(req.query);
    let sql = 'SELECT * FROM v_advance_ledger WHERE site_id=$1 ORDER BY payment_date, id';
    const params = [req.params.id];
    if (page) {
      sql += ' LIMIT $2 OFFSET $3';
      params.push(page.limit, page.offset);
    }
    res.json((await pool.query(sql, params)).rows);
  } catch (err) { handleDbError(res, err); }
});

// POST /api/sites/:id/advances
app.post('/api/sites/:id/advances', ownerOnly, async (req, res) => {
  const { payment_date, amount } = req.body;
  const notesCheck = validateText(req.body.notes, 255, 'notes');
  if (notesCheck.error) return res.status(400).json({ error: notesCheck.error });

  if (!payment_date || amount == null)
    return res.status(400).json({ error: 'payment_date and amount are required' });
  const validAmount = parseAmount(amount);
  if (validAmount === null) return res.status(400).json({ error: 'Amount must be a positive number up to 99,999,999' });

  try {
    const dupCheck = await pool.query(
      `SELECT id FROM advance_payments
       WHERE site_id=$1 AND payment_date=$2 AND amount=$3 AND COALESCE(notes, '') = COALESCE($4, '')
         AND created_at > NOW() - INTERVAL '4 seconds'
       ORDER BY id DESC LIMIT 1`,
      [req.params.id, payment_date, validAmount, notesCheck.value]
    );
    if (dupCheck.rowCount > 0) {
      console.log(`[DEDUP] Duplicate click blocked for advance on site ${req.params.id}`);
      return res.status(200).json({ id: dupCheck.rows[0].id });
    }

    const r = await pool.query(
      'INSERT INTO advance_payments (site_id, payment_date, amount, notes) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.params.id, payment_date, validAmount, notesCheck.value]
    );
    await logAudit(pool, {
      actor: req.username, role: req.role, action: 'CREATE',
      targetTable: 'advance_payments', targetId: r.rows[0].id,
      details: { site_id: req.params.id, amount: validAmount }
    });
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) { handleDbError(res, err); }
});

// DELETE /api/advances/:id
app.delete('/api/advances/:id', ownerOnly, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM advance_payments WHERE id=$1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Advance not found' });
    await logAudit(pool, {
      actor: req.username, role: req.role, action: 'DELETE',
      targetTable: 'advance_payments', targetId: req.params.id
    });
    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// GET /api/sites/:id/export (includes Receipt URL, parallelized queries)
app.get('/api/sites/:id/export', ownerOnly, async (req, res) => {
  try {
    const siteId = req.params.id;
    const [siteRes, expRes, advRes] = await Promise.all([
      pool.query('SELECT site_name FROM sites WHERE site_id=$1', [siteId]),
      pool.query('SELECT * FROM v_expense_ledger WHERE site_id=$1 ORDER BY expense_date, id', [siteId]),
      pool.query('SELECT * FROM v_advance_ledger WHERE site_id=$1 ORDER BY payment_date, id', [siteId])
    ]);
    const siteName = siteRes.rows[0] ? siteRes.rows[0].site_name : siteId;
    const wb = XLSX.utils.book_new();
    const expData = [['Date', 'Description', 'Amount (Rs)', 'Cumulative Total (Rs)', 'Receipt URL']];
    expRes.rows.forEach(r => expData.push([
      r.expense_date instanceof Date ? r.expense_date.toISOString().slice(0,10) : String(r.expense_date),
      r.description, parseFloat(r.amount), parseFloat(r.cumulative_expense), r.receipt_url || ''
    ]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(expData), 'Expenses');
    const advData = [['Date', 'Amount (Rs)', 'Notes', 'Cumulative Total (Rs)']];
    advRes.rows.forEach(r => advData.push([
      r.payment_date instanceof Date ? r.payment_date.toISOString().slice(0,10) : String(r.payment_date),
      parseFloat(r.amount), r.notes || '', parseFloat(r.cumulative_advance)
    ]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(advData), 'Advances');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `${siteName.replace(/[^a-zA-Z0-9]/g, '_')}_report.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { handleDbError(res, err); }
});

// GET /api/export/all (includes Receipt URL, parallelized queries)
app.get('/api/export/all', ownerOnly, async (req, res) => {
  try {
    const [summaryRes, expensesRes, advancesRes, sitesRes] = await Promise.all([
      pool.query('SELECT * FROM v_sites_summary ORDER BY site_id'),
      pool.query(`
        SELECT e.site_id, s.site_name, e.expense_date, e.description, e.amount, e.receipt_url
        FROM expenses e JOIN sites s ON e.site_id=s.site_id
        WHERE e.deleted_at IS NULL
        ORDER BY e.site_id, e.expense_date, e.id
      `),
      pool.query(`SELECT a.site_id, s.site_name, a.payment_date, a.amount, a.notes FROM advance_payments a JOIN sites s ON a.site_id=s.site_id ORDER BY a.site_id, a.payment_date, a.id`),
      pool.query('SELECT site_id, site_name, client_name, start_date, status FROM sites ORDER BY site_id')
    ]);
    const wb = XLSX.utils.book_new();
    const sumData = [['Site ID','Site Name','Client','Status','Total Advance (Rs)','Total Expenses (Rs)','Difference (Rs)']];
    summaryRes.rows.forEach(r => sumData.push([r.site_id,r.site_name,r.client_name||'',r.status,parseFloat(r.total_advance||0),parseFloat(r.total_expenses||0),parseFloat(r.difference||0)]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sumData), 'Summary');
    const expData = [['Site ID','Site Name','Expense Date','Description','Amount (Rs)','Receipt URL']];
    expensesRes.rows.forEach(r => expData.push([r.site_id,r.site_name, r.expense_date instanceof Date?r.expense_date.toISOString().slice(0,10):String(r.expense_date), r.description,parseFloat(r.amount||0), r.receipt_url || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(expData), 'All Expenses');
    const advData = [['Site ID','Site Name','Payment Date','Amount Received (Rs)','Notes / Reference']];
    advancesRes.rows.forEach(r => advData.push([r.site_id,r.site_name, r.payment_date instanceof Date?r.payment_date.toISOString().slice(0,10):String(r.payment_date), parseFloat(r.amount||0),r.notes||'']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(advData), 'All Advances');
    const siteData = [['Site ID','Site Name','Client Name','Start Date','Status']];
    sitesRes.rows.forEach(r => siteData.push([r.site_id,r.site_name,r.client_name||'', r.start_date?(r.start_date instanceof Date?r.start_date.toISOString().slice(0,10):String(r.start_date).slice(0,10)):'', r.status]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(siteData), 'Projects Master');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="ContractFlow_Full_Database_Backup.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { handleDbError(res, err); }
});

// GET /api/sites/:id/expenses/today
app.get('/api/sites/:id/expenses/today', anyRole, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    res.json((await pool.query(
      'SELECT id, expense_date, description, amount, receipt_url, added_by FROM expenses WHERE site_id=$1 AND expense_date=$2 AND deleted_at IS NULL ORDER BY id',
      [req.params.id, today]
    )).rows);
  } catch (err) { handleDbError(res, err); }
});

// GET /api/drive/status
app.get('/api/drive/status', anyRole, (req, res) => {
  const mode = getDriveMode();
  res.json({
    mode,
    isGoogleDrive: mode === 'SERVICE_ACCOUNT' || mode === 'OAUTH2' || mode === 'WEBHOOK'
  });
});

// ─── Global JSON Error Handler (prevents HTML 500 error pages on /api/*) ─────
app.use((err, req, res, next) => {
  console.error('[EXPRESS ERROR]', err.message);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status < 500 ? err.message : 'An internal error occurred. Please try again.'
  });
});

// ─── Start server / Export for Vercel ────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  if (allowedOrigins.length === 0)
    console.warn('[WARN] ALLOWED_ORIGINS not set — CORS is open (dev mode only).');
  if (!isBcryptHash(OWNER_PASSWORD) || !isBcryptHash(ASSISTANT_PASSWORD))
    console.warn('[SECURITY WARN] Plaintext password env vars detected. Set OWNER_PASSWORD_HASH / ASSISTANT_PASSWORD_HASH with bcrypt hashes for production.');
  app.listen(PORT, () => {
    console.log(`ContractFlow server running on port ${PORT}`);
    Promise.resolve()
      .then(() => pool.connect())
      .then(c => {
        console.log('Database connected');
        c.release();
        initDatabaseSchema();
      })
      .catch(e => console.error('DB error:', e.message));
  });
}

app.pool = pool;
app.initDatabaseSchema = initDatabaseSchema;
module.exports = app;
