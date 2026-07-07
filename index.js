const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const dns = require('dns').promises;
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

let pool = null;
let dbReady = false;
let dbError = null;

// Resolve Supabase hostname to IPv4 — Render free tier blocks IPv6 outbound
async function resolveToIPv4(url) {
  const m = url.match(/postgresql:\/\/([^@]+)@([^:/]+)(:\d+)?(\/.*)?/);
  if (!m) return url;
  const userpass = m[1];
  const hostname = m[2];
  const portStr = m[3] || ':5432';
  const dbpath = m[4] || '/postgres';
  try {
    const addrs = await dns.resolve4(hostname);
    if (addrs && addrs.length > 0) {
      console.log('[DB] Resolved', hostname, '->', addrs[0]);
      return 'postgresql://' + userpass + '@' + addrs[0] + portStr + dbpath;
    }
  } catch (e) {
    console.error('[DB] DNS resolve4 failed:', e.message);
  }
  return url;
}

async function initPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    dbError = 'DATABASE_URL is not set';
    console.error('[DB] ERROR: DATABASE_URL is not set');
    return;
  }
  console.log('[DB] Resolving Supabase hostname to IPv4...');
  let url = await resolveToIPv4(dbUrl);
  if (!url.includes('sslmode')) {
    url += (url.includes('?') ? '&' : '?') + 'sslmode=require';
  }
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    max: 5
  });
  pool.on('error', (err) => console.error('[DB] Pool error:', err.message));
}

async function initDB() {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        service TEXT DEFAULT '',
        account_type TEXT DEFAULT 'cuenta',
        price NUMERIC NOT NULL,
        features JSONB DEFAULT '[]',
        days_guaranteed INTEGER DEFAULT 30,
        whatsapp_message TEXT NOT NULL,
        image TEXT DEFAULT '',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT ''
      )
    `);
    await client.query(`
      INSERT INTO settings (key, value) VALUES
        ('whatsapp_number', ''),
        ('banner_image', ''),
        ('site_title', 'JACK STREAMING')
      ON CONFLICT (key) DO NOTHING
    `);
    dbReady = true;
    dbError = null;
    console.log('[DB] Connected and initialized OK');
  } finally {
    client.release();
  }
}

async function getProducts() {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at ASC');
  return rows.map(r => ({ ...r, price: parseFloat(r.price), features: Array.isArray(r.features) ? r.features : [] }));
}

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const s = { whatsapp_number: '', banner_image: '', site_title: 'JACK STREAMING' };
  rows.forEach(r => { s[r.key] = r.value || ''; });
  return s;
}

function dbCheck(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible: ' + (dbError || 'conectando...') });
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imagenes'));
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'jack-streaming-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// Debug endpoint
app.get('/api/db-status', (req, res) => {
  res.json({ dbReady, dbError, env: !!process.env.DATABASE_URL });
});

// PUBLIC ROUTES
app.get('/api/products', dbCheck, async (req, res) => {
  try {
    const products = (await getProducts()).filter(p => p.active);
    res.json(products.map(p => ({
      id: p.id, name: p.name, service: p.service,
      account_type: p.account_type, price: p.price,
      features: p.features, days_guaranteed: p.days_guaranteed,
      whatsapp_message: p.whatsapp_message, image: p.image
    })));
  } catch (err) { console.error('GET /api/products:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/settings/public', dbCheck, async (req, res) => {
  try {
    const s = await getSettings();
    res.json({ banner_image: s.banner_image, site_title: s.site_title, whatsapp_number: s.whatsapp_number });
  } catch (err) { console.error('GET /api/settings/public:', err.message); res.status(500).json({ error: err.message }); }
});

// AUTH
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || 'jack0706';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'jack0706';
  if (username === ADMIN_USER && password === ADMIN_PASS) { req.session.admin = true; res.json({ ok: true }); }
  else res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/check-auth', (req, res) => res.json({ authenticated: !!(req.session && req.session.admin) }));

// ADMIN: PRODUCTS
app.get('/api/admin/products', requireAuth, dbCheck, async (req, res) => {
  try { res.json(await getProducts()); }
  catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/products', requireAuth, dbCheck, upload.single('image'), async (req, res) => {
  try {
    const { name, service, account_type, price, features, days_guaranteed, whatsapp_message } = req.body;
    if (!name || !price || !whatsapp_message) return res.status(400).json({ error: 'Faltan campos requeridos' });
    const id = Date.now().toString();
    const featuresArr = features ? features.split('\n').map(f => f.trim()).filter(Boolean) : [];
    const image = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : '';
    const { rows } = await pool.query(
      `INSERT INTO products (id,name,service,account_type,price,features,days_guaranteed,whatsapp_message,image,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *`,
      [id, name, service||'', account_type||'cuenta', parseFloat(price),
       JSON.stringify(featuresArr), parseInt(days_guaranteed)||30, whatsapp_message, image]
    );
    const p = rows[0];
    res.json({ ok: true, product: { ...p, price: parseFloat(p.price), features: Array.isArray(p.features)?p.features:[] } });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/products/:id', requireAuth, dbCheck, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const ex = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    const cur = ex.rows[0];
    const { name, service, account_type, price, features, days_guaranteed, whatsapp_message } = req.body;
    const featuresArr = features ? features.split('\n').map(f => f.trim()).filter(Boolean) : (Array.isArray(cur.features)?cur.features:[]);
    const image = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : cur.image;
    const { rows } = await pool.query(
      `UPDATE products SET name=$2,service=$3,account_type=$4,price=$5,features=$6,
       days_guaranteed=$7,whatsapp_message=$8,image=$9 WHERE id=$1 RETURNING *`,
      [id, name||cur.name, service!==undefined?service:cur.service, account_type||cur.account_type,
       price?parseFloat(price):parseFloat(cur.price), JSON.stringify(featuresArr),
       days_guaranteed?parseInt(days_guaranteed):cur.days_guaranteed, whatsapp_message||cur.whatsapp_message, image]
    );
    const p = rows[0];
    res.json({ ok: true, product: { ...p, price: parseFloat(p.price), features: Array.isArray(p.features)?p.features:[] } });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/products/:id', requireAuth, dbCheck, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/products/:id/toggle', requireAuth, dbCheck, async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE products SET active=NOT active WHERE id=$1 RETURNING active', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, active: rows[0].active });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

// ADMIN: SETTINGS
app.post('/api/admin/settings', requireAuth, dbCheck, upload.single('banner'), async (req, res) => {
  try {
    const { whatsapp_number, site_title } = req.body;
    const upsert = (k, v) => pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [k, v]);
    if (whatsapp_number !== undefined) await upsert('whatsapp_number', whatsapp_number);
    if (site_title !== undefined) await upsert('site_title', site_title);
    if (req.file) await upsert('banner_image', `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`);
    res.json({ ok: true, settings: await getSettings() });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/settings', requireAuth, dbCheck, async (req, res) => {
  try { res.json(await getSettings()); }
  catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

// BACKUP / RESTORE
app.get('/api/admin/backup', requireAuth, dbCheck, async (req, res) => {
  try {
    res.setHeader('Content-Disposition', 'attachment; filename="jack-streaming-backup.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json({ products: await getProducts(), settings: await getSettings(), exported_at: new Date().toISOString() });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/restore', requireAuth, dbCheck, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { products, settings } = req.body;
    if (Array.isArray(products)) {
      await pool.query('DELETE FROM products');
      for (const p of products) {
        await pool.query(
          `INSERT INTO products(id,name,service,account_type,price,features,days_guaranteed,whatsapp_message,image,active,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT(id) DO UPDATE SET name=$2,service=$3,account_type=$4,price=$5,features=$6,
           days_guaranteed=$7,whatsapp_message=$8,image=$9,active=$10`,
          [p.id||Date.now().toString(), p.name, p.service||'', p.account_type||'cuenta',
           parseFloat(p.price), JSON.stringify(Array.isArray(p.features)?p.features:[]),
           parseInt(p.days_guaranteed)||30, p.whatsapp_message, p.image||'',
           p.active!==false, p.created_at||new Date().toISOString()]
        );
      }
    }
    if (settings && typeof settings === 'object') {
      for (const [k, v] of Object.entries(settings)) {
        if (['whatsapp_number','banner_image','site_title'].includes(k)) {
          await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [k, v||'']);
        }
      }
    }
    res.json({ ok: true });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

// STATIC
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// START — server always starts, DB connects in background
app.listen(PORT, async () => {
  console.log(`Jack Streaming running on port ${PORT}`);
  console.log('DATABASE_URL set:', !!process.env.DATABASE_URL);
  await initPool();
  if (pool) {
    try {
      await initDB();
    } catch (err) {
      dbError = err.message;
      console.error('[DB] Init failed:', err.message);
      setTimeout(async () => {
        try { await initDB(); }
        catch (e) { dbError = e.message; console.error('[DB] Retry failed:', e.message); }
      }, 15000);
    }
  }
  const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    fetch(`${keepAliveUrl}/api/settings/public`).catch(() => {});
  }, 14 * 60 * 1000);
});
