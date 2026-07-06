const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    whatsapp_number: '',
    banner_image: '',
    site_title: 'JACK STREAMING'
  }, null, 2));
}

function readProducts() {
  try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); }
  catch { return []; }
}
function writeProducts(data) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(data, null, 2));
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { whatsapp_number: '', banner_image: '', site_title: 'JACK STREAMING' }; }
}
function writeSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
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

// PUBLIC ROUTES
app.get('/api/products', (req, res) => {
  const products = readProducts().filter(p => p.active);
  const safe = products.map(p => ({
    id: p.id, name: p.name, service: p.service,
    account_type: p.account_type, price: p.price,
    features: p.features, days_guaranteed: p.days_guaranteed,
    whatsapp_message: p.whatsapp_message, image: p.image
  }));
  res.json(safe);
});

app.get('/api/settings/public', (req, res) => {
  const s = readSettings();
  res.json({ banner_image: s.banner_image, site_title: s.site_title, whatsapp_number: s.whatsapp_number });
});

// AUTH
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || 'jack0706';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'jack0706';
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/check-auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.admin) });
});

// ADMIN ROUTES
app.get('/api/admin/products', requireAuth, (req, res) => {
  res.json(readProducts());
});

app.post('/api/admin/products', requireAuth, upload.single('image'), (req, res) => {
  const products = readProducts();
  const { name, service, account_type, price, features, days_guaranteed, whatsapp_message } = req.body;
  if (!name || !price || !whatsapp_message) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  const newProduct = {
    id: Date.now().toString(),
    name, service: service || '',
    account_type: account_type || 'cuenta',
    price: parseFloat(price),
    features: features ? features.split('\n').map(f => f.trim()).filter(Boolean) : [],
    days_guaranteed: parseInt(days_guaranteed) || 30,
    whatsapp_message,
    image: req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : '',
    active: true,
    created_at: new Date().toISOString()
  };
  products.push(newProduct);
  writeProducts(products);
  res.json({ ok: true, product: newProduct });
});

app.put('/api/admin/products/:id', requireAuth, upload.single('image'), (req, res) => {
  const products = readProducts();
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Producto no encontrado' });
  const { name, service, account_type, price, features, days_guaranteed, whatsapp_message } = req.body;
  products[idx] = {
    ...products[idx],
    name: name || products[idx].name,
    service: service !== undefined ? service : products[idx].service,
    account_type: account_type || products[idx].account_type,
    price: price ? parseFloat(price) : products[idx].price,
    features: features ? features.split('\n').map(f => f.trim()).filter(Boolean) : products[idx].features,
    days_guaranteed: days_guaranteed ? parseInt(days_guaranteed) : products[idx].days_guaranteed,
    whatsapp_message: whatsapp_message || products[idx].whatsapp_message,
    image: req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : products[idx].image
  };
  writeProducts(products);
  res.json({ ok: true, product: products[idx] });
});

app.delete('/api/admin/products/:id', requireAuth, (req, res) => {
  const products = readProducts();
  const filtered = products.filter(p => p.id !== req.params.id);
  if (filtered.length === products.length) return res.status(404).json({ error: 'Producto no encontrado' });
  writeProducts(filtered);
  res.json({ ok: true });
});

app.patch('/api/admin/products/:id/toggle', requireAuth, (req, res) => {
  const products = readProducts();
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Producto no encontrado' });
  products[idx].active = !products[idx].active;
  writeProducts(products);
  res.json({ ok: true, active: products[idx].active });
});

app.post('/api/admin/settings', requireAuth, upload.single('banner'), (req, res) => {
  const settings = readSettings();
  const { whatsapp_number, site_title } = req.body;
  if (whatsapp_number !== undefined) settings.whatsapp_number = whatsapp_number;
  if (site_title !== undefined) settings.site_title = site_title;
  if (req.file) {
    settings.banner_image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  }
  writeSettings(settings);
  res.json({ ok: true, settings });
});

app.get('/api/admin/settings', requireAuth, (req, res) => {
  res.json(readSettings());
});

app.get('/api/admin/backup', requireAuth, (req, res) => {
  const backup = {
    products: readProducts(),
    settings: readSettings(),
    exported_at: new Date().toISOString()
  };
  res.setHeader('Content-Disposition', 'attachment; filename="jack-streaming-backup.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(backup);
});

app.post('/api/admin/restore', requireAuth, express.json({ limit: '50mb' }), (req, res) => {
  const { products, settings } = req.body;
  if (products) writeProducts(products);
  if (settings) writeSettings(settings);
  res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Jack Streaming server running on port ${PORT}`);
  const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    fetch(`${keepAliveUrl}/api/settings/public`)
      .then(() => console.log('Keep-alive ping OK'))
      .catch(() => {});
  }, 14 * 60 * 1000);
});
