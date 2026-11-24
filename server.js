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

const app  = express();
const PORT = process.env.PORT || 3000;

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
const OWNER_PASSWORD     = requireEnv('OWNER_PASSWORD');
const ASSISTANT_USERNAME = process.env.ASSISTANT_USERNAME || 'assistant';
const ASSISTANT_PASSWORD = requireEnv('ASSISTANT_PASSWORD');
const TOKEN_SECRET       = requireEnv('TOKEN_SECRET');
const TOKEN_TTL          = 86400000; // 24 h

// ─── DB Pool (PostgreSQL / Supabase) ─────────────────────────────────────────
// SEC-010: rejectUnauthorized: false kept for Supabase pooler compat.
// Full fix: set ssl: { rejectUnauthorized: true, ca: fs.readFileSync('./supabase-ca.crt').toString() }
const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host    : process.env.DB_HOST     || 'localhost',
      user    : process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'postgres',
      port    : parseInt(process.env.DB_PORT || '5432', 10),
      ssl     : process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

// ─── SEC-008 FIX: Sanitised DB error handler ─────────────────────────────────
function handleDbError(res, err) {
  console.error('[DB ERROR]', err.message);
  return res.status(500).json({ error: 'An internal error occurred. Please try again.' });
}

// ─── SEC-009 FIX: Amount validation ──────────────────────────────────────────
function parseAmount(val) {
  const n = parseFloat(val);
  if (!Number.isFinite(n) || n <= 0 || n > 99999999) return null;
  return Math.round(n * 100) / 100;
}

// ─── SEC-007 FIX: Security headers via Helmet ────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc    : ["'self'"],
      scriptSrc     : ["'self'", "'unsafe-inline'"],
      styleSrc      : ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc       : ["'self'", "https://fonts.gstatic.com"],
      imgSrc        : ["'self'", "data:", "https://img.icons8.com"],
      connectSrc    : ["'self'"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ─── SEC-004 FIX: Restrict CORS to allowed origins ───────────────────────────
const rawAllowedOrigins = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = rawAllowedOrigins.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true); // dev fallback
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  optionsSuccessStatus: 200
}));

app.use(express.json());

// ─── SEC-006 FIX: Serve only the public/ subdirectory ────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Serve Homepage ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const p = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send('index.html not found');
});

// ─── Serve PWA Static Files ───────────────────────────────────────────────────
const manifestData = require('./manifest.json');

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json(manifestData);
});

const swScript = `// SR Builders Service Worker
const CACHE_NAME = 'srbuilders-v1';
const ASSETS_TO_CACHE = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];
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
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
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

// ─── Token helpers ────────────────────────────────────────────────────────────
function makeToken(role, username) {
  const payload = Buffer.from(JSON.stringify({ role, username, exp: Date.now() + TOKEN_TTL })).toString('base64');
  const sig     = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function parseToken(token) {
  if (!token || !token.includes('.')) return null;
  const dotIdx  = token.indexOf('.');
  const payload = token.slice(0, dotIdx);
  const sig     = token.slice(dotIdx + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
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

// ─── Auto site_id helper ──────────────────────────────────────────────────────
async function nextSiteId(client) {
  const res = await client.query('SELECT MAX(CAST(SUBSTRING(site_id, 2) AS INTEGER)) AS mx FROM sites');
  const n = (res.rows[0].mx || 0) + 1;
  return 'S' + String(n).padStart(3, '0');
}

// ─── SEC-003 FIX: Rate-limit the login endpoint ───────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

// POST /api/login  (SEC-011: PIN fallback with hardcoded 1234/5678 removed)
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Please enter User ID and Password' });

  const u = String(username).trim().toLowerCase();
  const p = String(password).trim();

  if (u === OWNER_USERNAME.toLowerCase() && p === OWNER_PASSWORD)
    return res.json({ role: 'owner', username: OWNER_USERNAME, token: makeToken('owner', OWNER_USERNAME) });

  if (u === ASSISTANT_USERNAME.toLowerCase() && p === ASSISTANT_PASSWORD)
    return res.json({ role: 'assistant', username: ASSISTANT_USERNAME, token: makeToken('assistant', ASSISTANT_USERNAME) });

  return res.status(401).json({ error: 'Incorrect User ID or Password' });
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
  const { site_name, client_name, start_date } = req.body;
  if (!site_name) return res.status(400).json({ error: 'site_name is required' });
  const client = await pool.connect();
  try {
    const site_id = await nextSiteId(client);
    await client.query(
      'INSERT INTO sites (site_id, site_name, client_name, start_date) VALUES ($1, $2, $3, $4)',
      [site_id, site_name, client_name || null, start_date || null]
    );
    res.status(201).json({ site_id, site_name, client_name, start_date });
  } catch (err) { handleDbError(res, err); } finally { client.release(); }
});

// PUT /api/sites/:id/status
app.put('/api/sites/:id/status', ownerOnly, async (req, res) => {
  const { status } = req.body;
  if (!['active', 'completed', 'on-hold'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  try {
    await pool.query('UPDATE sites SET status=$1 WHERE site_id=$2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// PUT /api/sites/:id
app.put('/api/sites/:id', ownerOnly, async (req, res) => {
  const { site_name, client_name, status, start_date } = req.body;
  if (!site_name) return res.status(400).json({ error: 'Site name is required' });
  try {
    await pool.query(
      'UPDATE sites SET site_name=$1, client_name=$2, status=$3, start_date=$4 WHERE site_id=$5',
      [site_name, client_name || null, status || 'active', start_date || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// DELETE /api/sites/:id
app.delete('/api/sites/:id', ownerOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE site_id=$1', [req.params.id]);
    await pool.query('DELETE FROM advance_payments WHERE site_id=$1', [req.params.id]);
    await pool.query('DELETE FROM sites WHERE site_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// GET /api/sites/:id/expenses
app.get('/api/sites/:id/expenses', anyRole, async (req, res) => {
  try {
    res.json((await pool.query('SELECT * FROM v_expense_ledger WHERE site_id=$1 ORDER BY expense_date, id', [req.params.id])).rows);
  } catch (err) { handleDbError(res, err); }
});

// POST /api/sites/:id/expenses
app.post('/api/sites/:id/expenses', anyRole, async (req, res) => {
  const { expense_date, description, amount } = req.body;
  if (!expense_date || !description || amount == null)
    return res.status(400).json({ error: 'expense_date, description and amount are required' });
  const validAmount = parseAmount(amount);
  if (validAmount === null) return res.status(400).json({ error: 'Amount must be a positive number up to 99,999,999' });
  try {
    const r = await pool.query(
      'INSERT INTO expenses (site_id, expense_date, description, amount) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.params.id, expense_date, description, validAmount]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) { handleDbError(res, err); }
});

// PUT /api/expenses/:id  (SEC-005 FIX: existence check added)
app.put('/api/expenses/:id', anyRole, async (req, res) => {
  const { expense_date, description, amount } = req.body;
  if (!expense_date || !description || amount == null)
    return res.status(400).json({ error: 'expense_date, description and amount are required' });
  const validAmount = parseAmount(amount);
  if (validAmount === null) return res.status(400).json({ error: 'Amount must be a positive number up to 99,999,999' });
  try {
    const check = await pool.query('SELECT id FROM expenses WHERE id=$1', [req.params.id]);
    if (check.rowCount === 0) return res.status(404).json({ error: 'Expense not found' });
    const r = await pool.query(
      'UPDATE expenses SET expense_date=$1, description=$2, amount=$3 WHERE id=$4 RETURNING id, site_id, expense_date, description, amount',
      [expense_date, description, validAmount, req.params.id]
    );
    res.json({ ok: true, expense: r.rows[0] });
  } catch (err) { handleDbError(res, err); }
});

// DELETE /api/expenses/:id  (SEC-005 FIX: existence check added)
app.delete('/api/expenses/:id', anyRole, async (req, res) => {
  try {
    const check = await pool.query('SELECT id FROM expenses WHERE id=$1', [req.params.id]);
    if (check.rowCount === 0) return res.status(404).json({ error: 'Expense not found' });
    await pool.query('DELETE FROM expenses WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// GET /api/sites/:id/advances
app.get('/api/sites/:id/advances', ownerOnly, async (req, res) => {
  try {
    res.json((await pool.query('SELECT * FROM v_advance_ledger WHERE site_id=$1 ORDER BY payment_date, id', [req.params.id])).rows);
  } catch (err) { handleDbError(res, err); }
});

// POST /api/sites/:id/advances
app.post('/api/sites/:id/advances', ownerOnly, async (req, res) => {
  const { payment_date, amount, notes } = req.body;
  if (!payment_date || amount == null)
    return res.status(400).json({ error: 'payment_date and amount are required' });
  const validAmount = parseAmount(amount);
  if (validAmount === null) return res.status(400).json({ error: 'Amount must be a positive number up to 99,999,999' });
  try {
    const r = await pool.query(
      'INSERT INTO advance_payments (site_id, payment_date, amount, notes) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.params.id, payment_date, validAmount, notes || null]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) { handleDbError(res, err); }
});

// DELETE /api/advances/:id
app.delete('/api/advances/:id', ownerOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM advance_payments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { handleDbError(res, err); }
});

// GET /api/sites/:id/export
app.get('/api/sites/:id/export', ownerOnly, async (req, res) => {
  try {
    const siteId   = req.params.id;
    const siteRes  = await pool.query('SELECT site_name FROM sites WHERE site_id=$1', [siteId]);
    const siteName = siteRes.rows[0] ? siteRes.rows[0].site_name : siteId;
    const expRes   = await pool.query('SELECT * FROM v_expense_ledger WHERE site_id=$1 ORDER BY expense_date, id', [siteId]);
    const advRes   = await pool.query('SELECT * FROM v_advance_ledger WHERE site_id=$1 ORDER BY payment_date, id', [siteId]);
    const wb = XLSX.utils.book_new();
    const expData = [['Date', 'Description', 'Amount (Rs)', 'Cumulative Total (Rs)']];
    expRes.rows.forEach(r => expData.push([
      r.expense_date instanceof Date ? r.expense_date.toISOString().slice(0,10) : String(r.expense_date),
      r.description, parseFloat(r.amount), parseFloat(r.cumulative_expense)
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

// GET /api/export/all
app.get('/api/export/all', ownerOnly, async (req, res) => {
  try {
    const summaryRes  = await pool.query('SELECT * FROM v_sites_summary ORDER BY site_id');
    const expensesRes = await pool.query(`SELECT e.site_id, s.site_name, e.expense_date, e.description, e.amount FROM expenses e JOIN sites s ON e.site_id=s.site_id ORDER BY e.site_id, e.expense_date, e.id`);
    const advancesRes = await pool.query(`SELECT a.site_id, s.site_name, a.payment_date, a.amount, a.notes FROM advance_payments a JOIN sites s ON a.site_id=s.site_id ORDER BY a.site_id, a.payment_date, a.id`);
    const sitesRes    = await pool.query('SELECT site_id, site_name, client_name, start_date, status FROM sites ORDER BY site_id');
    const wb = XLSX.utils.book_new();
    const sumData = [['Site ID','Site Name','Client','Status','Total Advance (Rs)','Total Expenses (Rs)','Difference (Rs)']];
    summaryRes.rows.forEach(r => sumData.push([r.site_id,r.site_name,r.client_name||'',r.status,parseFloat(r.total_advance||0),parseFloat(r.total_expenses||0),parseFloat(r.difference||0)]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sumData), 'Summary');
    const expData = [['Site ID','Site Name','Expense Date','Description','Amount (Rs)']];
    expensesRes.rows.forEach(r => expData.push([r.site_id,r.site_name, r.expense_date instanceof Date?r.expense_date.toISOString().slice(0,10):String(r.expense_date), r.description,parseFloat(r.amount||0)]));
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
      'SELECT id, expense_date, description, amount FROM expenses WHERE site_id=$1 AND expense_date=$2 ORDER BY id',
      [req.params.id, today]
    )).rows);
  } catch (err) { handleDbError(res, err); }
});

// ─── Start server / Export for Vercel ────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  if (allowedOrigins.length === 0)
    console.warn('[WARN] ALLOWED_ORIGINS not set — CORS is open (dev mode only).');
  app.listen(PORT, () => {
    console.log(`ContractFlow server running on port ${PORT}`);
    pool.connect().then(c => { console.log('Database connected'); c.release(); }).catch(e => console.error('DB error:', e.message));
  });
}

module.exports = app;