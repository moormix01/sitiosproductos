const express = require('express');
    const session = require('express-session');
    const multer = require('multer');
    const path = require('path');
    const { Pool } = require('pg');

    const app = express();
    const PORT = process.env.PORT || 3000;

    // ── Supabase / PostgreSQL ────────────────────────────────────────────────────
    const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
    });

    async function initDB() {
    await pool.query(`
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT ''
      )
    `);
    await pool.query(`
      INSERT INTO settings (key, value) VALUES
        ('whatsapp_number', ''),
        ('banner_image', ''),
        ('site_title', 'JACK STREAMING')
      ON CONFLICT (key) DO NOTHING
    `);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────
    async function getProducts() {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at ASC');
    return rows.map(r => ({
      ...r,
      price: parseFloat(r.price),
      features: Array.isArray(r.features) ? r.features : []
    }));
    }

    async function getSettings() {
    const { rows } = await pool.query('SELECT key, value FROM settings');
    const s = { whatsapp_number: '', banner_image: '', site_title: 'JACK STREAMING' };
    rows.forEach(r => { s[r.key] = r.value || ''; });
    return s;
    }

    // ── Multer ───────────────────────────────────────────────────────────────────
    const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Solo se permiten imagenes'));
    }
    });

    // ── Middleware ────────────────────────────────────────────────────────────────
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

    // ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
    app.get('/api/products', async (req, res) => {
    try {
      const products = (await getProducts()).filter(p => p.active);
      const safe = products.map(p => ({
        id: p.id, name: p.name, service: p.service,
        account_type: p.account_type, price: p.price,
        features: p.features, days_guaranteed: p.days_guaranteed,
        whatsapp_message: p.whatsapp_message, image: p.image
      }));
      res.json(safe);
    } catch (err) {
      console.error('GET /api/products error:', err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    app.get('/api/settings/public', async (req, res) => {
    try {
      const s = await getSettings();
      res.json({ banner_image: s.banner_image, site_title: s.site_title, whatsapp_number: s.whatsapp_number });
    } catch (err) {
      console.error('GET /api/settings/public error:', err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    // ── AUTH ──────────────────────────────────────────────────────────────────────
    app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const ADMIN_USER = process.env.ADMIN_USER || 'jack0706';
    const ADMIN_PASS = process.env.ADMIN_PASS || 'jack0706';
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      req.session.admin = true;
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
    }
    });

    app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
    });

    app.get('/api/check-auth', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.admin) });
    });

    // ── ADMIN: PRODUCTS ───────────────────────────────────────────────────────────
    app.get('/api/admin/products', requireAuth, async (req, res) => {
    try {
      res.json(await getProducts());
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    app.post('/api/admin/products', requireAuth, upload.single('image'), async (req, res) => {
    try {
      const { name, service, account_type, price, features, days_guaranteed, whatsapp_message } = req.body;
      if (!name || !price || !whatsapp_message) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
      }
      const id = Date.now().toString();
      const featuresArr = features ? features.split('\n').map(f => f.trim()).filter(Boolean) : [];
      const image = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : '';

      const { rows } = await pool.query(
        `INSERT INTO products (id, name, service, account_type, price, features, days_guaranteed, whatsapp_message, image, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *`,
        [id, name, service || '', account_type || 'cuenta', parseFloat(price),
         JSON.stringify(featuresArr), parseInt(days_guaranteed) || 30, whatsapp_message, image]
      );
      const product = { ...rows[0], price: parseFloat(rows[0].price), features: Array.isArray(rows[0].features) ? rows[0].features : [] };
      res.json({ ok: true, product });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    app.put('/api/admin/products/:id', requireAuth, upload.single('image'), async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await pool.query('SELECT * FROM products WHERE id=$1', [id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
      const cur = existing.rows[0];

      const { name, service, account_type, price, features, days_guaranteed, whatsapp_message } = req.body;
      const featuresArr = features ? features.split('\n').map(f => f.trim()).filter(Boolean) : (Array.isArray(cur.features) ? cur.features : []);
      const image = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : cur.image;

      const { rows } = await pool.query(
        `UPDATE products SET
          name=$2, service=$3, account_type=$4, price=$5, features=$6,
          days_guaranteed=$7, whatsapp_message=$8, image=$9
         WHERE id=$1 RETURNING *`,
        [id,
         name || cur.name,
         service !== undefined ? service : cur.service,
         account_type || cur.account_type,
         price ? parseFloat(price) : parseFloat(cur.price),
         JSON.stringify(featuresArr),
         days_guaranteed ? parseInt(days_guaranteed) : cur.days_guaranteed,
         whatsapp_message || cur.whatsapp_message,
         image]
      );
      const product = { ...rows[0], price: parseFloat(rows[0].price), features: Array.isArray(rows[0].features) ? rows[0].features : [] };
      res.json({ ok: true, product });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    app.delete('/api/admin/products/:id', requireAuth, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Producto no encontrado' });
      res.json({ ok: true });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    app.patch('/api/admin/products/:id/toggle', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'UPDATE products SET active = NOT active WHERE id=$1 RETURNING active',
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
      res.json({ ok: true, active: rows[0].active });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    // ── ADMIN: SETTINGS ───────────────────────────────────────────────────────────
    app.post('/api/admin/settings', requireAuth, upload.single('banner'), async (req, res) => {
    try {
      const { whatsapp_number, site_title } = req.body;
      if (whatsapp_number !== undefined) {
        await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', ['whatsapp_number', whatsapp_number]);
      }
      if (site_title !== undefined) {
        await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', ['site_title', site_title]);
      }
      if (req.file) {
        const banner_image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', ['banner_image', banner_image]);
      }
      const settings = await getSettings();
      res.json({ ok: true, settings });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    app.get('/api/admin/settings', requireAuth, async (req, res) => {
    try {
      res.json(await getSettings());
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    // ── BACKUP / RESTORE ──────────────────────────────────────────────────────────
    app.get('/api/admin/backup', requireAuth, async (req, res) => {
    try {
      const backup = {
        products: await getProducts(),
        settings: await getSettings(),
        exported_at: new Date().toISOString()
      };
      res.setHeader('Content-Disposition', 'attachment; filename="jack-streaming-backup.json"');
      res.setHeader('Content-Type', 'application/json');
      res.json(backup);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    app.post('/api/admin/restore', requireAuth, express.json({ limit: '50mb' }), async (req, res) => {
    try {
      const { products, settings } = req.body;
      if (Array.isArray(products)) {
        await pool.query('DELETE FROM products');
        for (const p of products) {
          await pool.query(
            `INSERT INTO products (id, name, service, account_type, price, features, days_guaranteed, whatsapp_message, image, active, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (id) DO UPDATE SET name=$2,service=$3,account_type=$4,price=$5,features=$6,
               days_guaranteed=$7,whatsapp_message=$8,image=$9,active=$10`,
            [p.id || Date.now().toString(), p.name, p.service || '', p.account_type || 'cuenta',
             parseFloat(p.price), JSON.stringify(Array.isArray(p.features) ? p.features : []),
             parseInt(p.days_guaranteed) || 30, p.whatsapp_message, p.image || '',
             p.active !== false, p.created_at || new Date().toISOString()]
          );
        }
      }
      if (settings && typeof settings === 'object') {
        for (const [key, value] of Object.entries(settings)) {
          if (['whatsapp_number','banner_image','site_title'].includes(key)) {
            await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value || '']);
          }
        }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Error interno' });
    }
    });

    // ── STATIC ────────────────────────────────────────────────────────────────────
    app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // ── START ─────────────────────────────────────────────────────────────────────
    initDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Jack Streaming server running on port ${PORT} (Supabase mode)`);
        const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        setInterval(() => {
          fetch(`${keepAliveUrl}/api/settings/public`)
            .then(() => console.log('Keep-alive ping OK'))
            .catch(() => {});
        }, 14 * 60 * 1000);
      });
    })
    .catch(err => {
      console.error('Failed to initialize DB:', err.message);
      process.exit(1);
    });
    