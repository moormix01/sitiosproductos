// Force IPv4 for all outbound TCP connections (Render free tier blocks IPv6 to Supabase)
const net = require('net');
const _createConn = net.createConnection.bind(net);
net.createConnection = function(options, ...args) {
  if (options && typeof options === 'object' && !options.family) options.family = 4;
  return _createConn(options, ...args);
};

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

let pool = null;
let dbReady = false;
let dbError = null;

function createPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    dbError = 'DATABASE_URL is not set';
    console.error('[DB] DATABASE_URL not set');
    return null;
  }
  const p = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    max: 5
  });
  p.on('error', (err) => console.error('[DB] pool error:', err.message));
  return p;
}

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, service TEXT DEFAULT '',
      account_type TEXT DEFAULT 'cuenta', price NUMERIC NOT NULL,
      features JSONB DEFAULT '[]', days_guaranteed INTEGER DEFAULT 30,
      whatsapp_message TEXT DEFAULT '', image TEXT DEFAULT '',
      active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT DEFAULT ''
    )`);
    await client.query(`INSERT INTO settings(key,value) VALUES
      ('whatsapp_number',''),('banner_image',''),('site_title','JACK STREAMING')
      ON CONFLICT(key) DO NOTHING`);
    await client.query(`CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      telefono TEXT NOT NULL,
      numero_pedido TEXT DEFAULT '',
      correo TEXT NOT NULL,
      contrasena TEXT NOT NULL,
      plataforma TEXT NOT NULL,
      fecha_compra TEXT NOT NULL,
      fecha_vencimiento TEXT NOT NULL,
      meses TEXT NOT NULL,
      tipo_error TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    dbReady = true; dbError = null;
    console.log('[DB] OK');
  } finally { client.release(); }
}

// ── IN-MEMORY CACHE (reduces Neon data transfer) ─────────────────────────────
const cache = { products: null, settings: null, productsTTL: 0, settingsTTL: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

function invalidateCache() { cache.products = null; cache.settings = null; cache.productsTTL = 0; cache.settingsTTL = 0; }

async function getProducts() {
  if (cache.products && Date.now() < cache.productsTTL) return cache.products;
  const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at ASC');
  cache.products = rows.map(r => ({ ...r, price: parseFloat(r.price), features: Array.isArray(r.features) ? r.features : [] }));
  cache.productsTTL = Date.now() + CACHE_MS;
  return cache.products;
}
async function getSettings() {
  if (cache.settings && Date.now() < cache.settingsTTL) return cache.settings;
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const s = { whatsapp_number: '', banner_image: '', site_title: 'JACK STREAMING' };
  rows.forEach(r => { s[r.key] = r.value || ''; });
  cache.settings = s;
  cache.settingsTTL = Date.now() + CACHE_MS;
  return s;
}
function dbCheck(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible: ' + (dbError || 'conectando...') });
  next();
}

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Solo imagenes'))
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({ secret: process.env.SESSION_SECRET || 'jack-streaming-secret-2024', resave: false, saveUninitialized: false, cookie: { secure: false, maxAge: 86400000 } }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'No autorizado' });
}

app.get('/api/db-status', (req, res) => res.json({ dbReady, dbError, env: !!process.env.DATABASE_URL }));

app.get('/api/products', dbCheck, async (req, res) => {
  try {
    const p = (await getProducts()).filter(p => p.active);
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.json(p.map(p => ({ id:p.id,name:p.name,service:p.service,account_type:p.account_type,price:p.price,features:p.features,days_guaranteed:p.days_guaranteed,whatsapp_message:p.whatsapp_message,image:p.image })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings/public', dbCheck, async (req, res) => {
  try {
    const s = await getSettings();
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    res.json({ banner_image:s.banner_image, site_title:s.site_title, whatsapp_number:s.whatsapp_number });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === (process.env.ADMIN_USER||'jack0706') && password === (process.env.ADMIN_PASS||'jack0706')) { req.session.admin = true; res.json({ ok: true }); }
  else res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/check-auth', (req, res) => res.json({ authenticated: !!(req.session && req.session.admin) }));

app.get('/api/admin/products', auth, dbCheck, async (req, res) => {
  try { res.json(await getProducts()); } catch(e) { res.status(500).json({ error: e.message }); }
});
// Auto-genera el mensaje de WhatsApp a partir de los datos del producto
function buildWhatsappMessage({ name, account_type, days_guaranteed, feat }) {
  const tipo = account_type === 'perfil' ? 'Perfil' : 'Cuenta Completa';
  let msg = `Hola Jack, me interesa comprar *${name}* (${tipo}) - Garantía: ${days_guaranteed || 30} días.`;
  if (feat && feat.length) msg += ` Incluye: ${feat.join(', ')}.`;
  return msg;
}

app.post('/api/admin/products', auth, dbCheck, upload.single('image'), async (req, res) => {
  try {
    const { name, service, account_type, price, features, days_guaranteed } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'Faltan campos' });
    const id = Date.now().toString();
    const feat = features ? features.split('\n').map(f=>f.trim()).filter(Boolean) : [];
    const days = parseInt(days_guaranteed)||30;
    const img = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : '';
    const whatsapp_message = buildWhatsappMessage({ name, account_type, days_guaranteed: days, feat });
    const { rows } = await pool.query(
      `INSERT INTO products(id,name,service,account_type,price,features,days_guaranteed,whatsapp_message,image,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *`,
      [id,name,service||'',account_type||'cuenta',parseFloat(price),JSON.stringify(feat),days,whatsapp_message,img]
    );
    const p=rows[0]; invalidateCache(); res.json({ ok:true, product:{...p,price:parseFloat(p.price),features:Array.isArray(p.features)?p.features:[]} });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/products/:id', auth, dbCheck, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const ex = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'No encontrado' });
    const cur = ex.rows[0];
    const { name, service, account_type, price, features, days_guaranteed } = req.body;
    const feat = features ? features.split('\n').map(f=>f.trim()).filter(Boolean) : (Array.isArray(cur.features)?cur.features:[]);
    const img = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : cur.image;
    const finalName = name||cur.name;
    const finalType = account_type||cur.account_type;
    const finalDays = days_guaranteed?parseInt(days_guaranteed):cur.days_guaranteed;
    const whatsapp_message = buildWhatsappMessage({ name: finalName, account_type: finalType, days_guaranteed: finalDays, feat });
    const { rows } = await pool.query(
      `UPDATE products SET name=$2,service=$3,account_type=$4,price=$5,features=$6,days_guaranteed=$7,whatsapp_message=$8,image=$9 WHERE id=$1 RETURNING *`,
      [id,finalName,service!==undefined?service:cur.service,finalType,price?parseFloat(price):parseFloat(cur.price),JSON.stringify(feat),finalDays,whatsapp_message,img]
    );
    const p=rows[0]; invalidateCache(); res.json({ ok:true, product:{...p,price:parseFloat(p.price),features:Array.isArray(p.features)?p.features:[]} });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/products/:id', auth, dbCheck, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    invalidateCache(); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/products/:id/toggle', auth, dbCheck, async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE products SET active=NOT active WHERE id=$1 RETURNING active', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    invalidateCache(); res.json({ ok:true, active:rows[0].active });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/settings', auth, dbCheck, upload.single('banner'), async (req, res) => {
  try {
    const up = (k,v) => pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',[k,v]);
    if (req.body.whatsapp_number !== undefined) await up('whatsapp_number', req.body.whatsapp_number);
    if (req.body.site_title !== undefined) await up('site_title', req.body.site_title);
    if (req.file) await up('banner_image', `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`);
    invalidateCache(); res.json({ ok:true, settings: await getSettings() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/settings', auth, dbCheck, async (req, res) => {
  try { res.json(await getSettings()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/backup', auth, dbCheck, async (req, res) => {
  try {
    res.setHeader('Content-Disposition','attachment; filename="backup.json"');
    res.json({ products: await getProducts(), settings: await getSettings(), exported_at: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/restore', auth, dbCheck, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { products, settings } = req.body;
    if (Array.isArray(products)) {
      await pool.query('DELETE FROM products');
      for (const p of products) {
        await pool.query(
          `INSERT INTO products(id,name,service,account_type,price,features,days_guaranteed,whatsapp_message,image,active,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET name=$2,service=$3,account_type=$4,price=$5,features=$6,days_guaranteed=$7,whatsapp_message=$8,image=$9,active=$10`,
          [p.id||Date.now().toString(),p.name,p.service||'',p.account_type||'cuenta',parseFloat(p.price),JSON.stringify(Array.isArray(p.features)?p.features:[]),parseInt(p.days_guaranteed)||30,p.whatsapp_message,p.image||'',p.active!==false,p.created_at||new Date().toISOString()]
        );
      }
    }
    if (settings) for (const [k,v] of Object.entries(settings)) {
      if (['whatsapp_number','banner_image','site_title'].includes(k))
        await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',[k,v||'']);
    }
    invalidateCache(); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTS ─────────────────────────────────────────────────────────────────
// Public: client submits a report
app.post('/api/reports', dbCheck, async (req, res) => {
  try {
    const { telefono, numero_pedido, correo, contrasena, plataforma, fecha_compra, fecha_vencimiento, meses, tipo_error } = req.body;
    if (!telefono || !correo || !contrasena || !plataforma || !fecha_compra || !fecha_vencimiento || !meses || !tipo_error)
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    await pool.query(
      'INSERT INTO reports(telefono,numero_pedido,correo,contrasena,plataforma,fecha_compra,fecha_vencimiento,meses,tipo_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [telefono, numero_pedido||'', correo, contrasena, plataforma, fecha_compra, fecha_vencimiento, meses, tipo_error]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: list reports with optional search
app.get('/api/admin/reports', auth, dbCheck, async (req, res) => {
  try {
    const q = req.query.q || '';
    const { rows } = await pool.query(
      'SELECT * FROM reports WHERE correo ILIKE $1 OR telefono ILIKE $1 ORDER BY created_at DESC',
      [`%${q}%`]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: mark report as solved (delete)
app.delete('/api/admin/reports/:id', auth, dbCheck, async (req, res) => {
  try {
    await pool.query('DELETE FROM reports WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, async () => {
  console.log(`Servidor en puerto ${PORT}`);
  console.log('DATABASE_URL:', !!process.env.DATABASE_URL);
  pool = createPool();
  if (pool) {
    const tryInit = async (n) => {
      try { await initDB(); }
      catch(e) { dbError=e.message; console.error('[DB] intento '+n+' fallo:',e.message); if(n<5) setTimeout(()=>tryInit(n+1),10000); }
    };
    tryInit(1);
  }
  const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => fetch(`${base}/api/settings/public`).catch(()=>{}), 840000);
});
