let pendingDeleteId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const auth = await fetch('/api/check-auth').then(r => r.json());
  if (auth.authenticated) showAdmin();
  else showLogin();

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    btn.textContent = 'Ingresando...'; btn.disabled = true;
    const err = document.getElementById('login-error');
    err.style.display = 'none';
    const res = await fetch('/api/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
    });
    if (res.ok) { showAdmin(); }
    else { err.style.display = 'block'; btn.textContent = 'Ingresar'; btn.disabled = false; }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method:'POST' });
    location.reload();
  });

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      showTab(item.dataset.tab);
    });
  });

  document.getElementById('product-form').addEventListener('submit', saveProduct);
  document.getElementById('settings-form').addEventListener('submit', saveSettings);

  document.getElementById('p-image').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      document.getElementById('image-preview').src = ev.target.result;
      document.getElementById('image-preview-wrap').style.display = 'block';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('s-banner').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      document.getElementById('banner-preview').src = ev.target.result;
      document.getElementById('banner-preview-wrap').style.display = 'block';
    };
    reader.readAsDataURL(file);
  });
});

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('admin-screen').style.display = 'none';
}

async function showAdmin() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-screen').style.display = 'flex';
  await loadAdminProducts();
  await loadAdminSettings();
}

function showTab(tab) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  document.querySelector(`[data-tab="${tab}"]`)?.classList.add('active');
  if (tab === 'products') loadAdminProducts();
  if (tab === 'reports') loadReports();
}

let allAdminProducts = [];

async function loadAdminProducts() {
  const list = document.getElementById('products-list');
  list.innerHTML = '<div class="loading">Cargando...</div>';
  try {
    allAdminProducts = await fetch('/api/admin/products').then(r => r.json());
    const searchEl = document.getElementById('products-search');
    if (searchEl) searchEl.value = '';
    renderProductList(allAdminProducts);
  } catch { list.innerHTML = '<div class="empty">Error al cargar productos</div>'; }
}

function filterProducts(q) {
  const term = (q || '').toLowerCase().trim();
  const filtered = term
    ? allAdminProducts.filter(p =>
        p.name.toLowerCase().includes(term) ||
        (p.service || '').toLowerCase().includes(term)
      )
    : allAdminProducts;
  renderProductList(filtered);
}

function renderProductList(products) {
  const list = document.getElementById('products-list');
  if (!products.length) {
    list.innerHTML = '<div class="empty">No se encontraron productos.</div>';
    return;
  }
  list.innerHTML = '';
  products.forEach(p => {
    const item = document.createElement('div');
    item.className = `product-item ${p.active ? '' : 'inactive-item'}`;
    const imgHTML = p.image
      ? `<img src="${p.image}" alt="${p.name}">`
      : getEmoji(p.service);
    item.innerHTML = `
      <div class="product-item-img">${imgHTML}</div>
      <div class="product-item-info">
        <h3>${p.name}</h3>
        <div class="product-item-meta">
          <span>${p.account_type === 'perfil' ? '👤 Perfil' : '💻 Cuenta completa'}</span>
          <span>⏱ ${p.days_guaranteed} días</span>
          <span>${p.active ? '✅ Activo' : '❌ Inactivo'}</span>
        </div>
      </div>
      <span class="product-item-price">${parseFloat(p.price).toFixed(2)}</span>
      <div class="product-item-actions">
        <button class="action-btn ${p.active ? 'active-btn' : 'inactive-btn'}" onclick="toggleProduct('${p.id}')">${p.active ? 'Desactivar' : 'Activar'}</button>
        <button class="action-btn edit-btn" onclick="editProduct('${p.id}')">Editar</button>
        <button class="action-btn del-btn" onclick="confirmDelete('${p.id}', '${p.name.replace(/'/g,"\\'")}')">Eliminar</button>
      </div>`;
    list.appendChild(item);
  });
}

async function loadAdminSettings() {
  try {
    const s = await fetch('/api/admin/settings').then(r => r.json());
    if (s.site_title) document.getElementById('s-title').value = s.site_title;
    if (s.whatsapp_number) document.getElementById('s-whatsapp').value = s.whatsapp_number;
    if (s.banner_image) {
      document.getElementById('banner-preview').src = s.banner_image;
      document.getElementById('banner-preview-wrap').style.display = 'block';
    }
  } catch {}
}

// ── REPORTS ──────────────────────────────────────────────────────────────────
async function loadReports(q = '') {
  const list = document.getElementById('reports-list');
  list.innerHTML = '<div class="loading">Cargando reportes...</div>';
  try {
    const reports = await fetch(`/api/admin/reports?q=${encodeURIComponent(q)}`).then(r => r.json());
    if (!reports.length) {
      list.innerHTML = '<div class="empty">No hay reportes pendientes. 🎉</div>';
      return;
    }
    list.innerHTML = '';
    reports.forEach(r => {
      const card = document.createElement('div');
      card.className = 'report-card';
      card.innerHTML = `
        <div class="report-card-header">
          <div class="report-card-info">
            <span class="report-error-badge">${r.tipo_error}</span>
            <span class="report-date">${new Date(r.created_at).toLocaleString('es-VE')}</span>
          </div>
          <button class="btn-solved" onclick="solveReport(${r.id}, this)">✅ Reporte Solucionado</button>
        </div>
        <div class="report-card-body">
          <div class="rinfo"><span>📱 Teléfono</span><strong>${r.telefono}</strong></div>
          <div class="rinfo"><span>📧 Correo</span><strong>${r.correo}</strong></div>
          <div class="rinfo"><span>🔑 Contraseña</span><strong>${r.contrasena}</strong></div>
          <div class="rinfo"><span>📺 Plataforma</span><strong>${r.plataforma}</strong></div>
          <div class="rinfo"><span>🗓 Compra</span><strong>${r.fecha_compra}</strong></div>
          <div class="rinfo"><span>⏳ Vencimiento</span><strong>${r.fecha_vencimiento}</strong></div>
          <div class="rinfo"><span>📅 Meses</span><strong>${r.meses}</strong></div>
          ${r.numero_pedido ? `<div class="rinfo"><span>🔖 N° Pedido</span><strong>${r.numero_pedido}</strong></div>` : ''}
        </div>`;
      list.appendChild(card);
    });
  } catch { list.innerHTML = '<div class="empty">Error al cargar reportes</div>'; }
}

async function solveReport(id, btn) {
  btn.textContent = 'Eliminando...';
  btn.disabled = true;
  await fetch(`/api/admin/reports/${id}`, { method: 'DELETE' });
  loadReports(document.getElementById('reports-search').value);
}
// ─────────────────────────────────────────────────────────────────────────────

async function saveProduct(e) {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const btn = document.getElementById('save-btn');
  const msg = document.getElementById('form-msg');
  btn.textContent = 'Guardando...'; btn.disabled = true;
  msg.style.display = 'none';

  const formData = new FormData();
  formData.append('name', document.getElementById('p-name').value);
  formData.append('service', document.getElementById('p-service').value);
  formData.append('account_type', document.getElementById('p-account-type').value);
  formData.append('price', document.getElementById('p-price').value);
  formData.append('features', document.getElementById('p-features').value);
  formData.append('days_guaranteed', document.getElementById('p-days').value);
  formData.append('whatsapp_message', document.getElementById('p-whatsapp').value);
  const imgFile = document.getElementById('p-image').files[0];
  if (imgFile) formData.append('image', imgFile);

  const url = id ? `/api/admin/products/${id}` : '/api/admin/products';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, body: formData });
  btn.textContent = 'Guardar Producto'; btn.disabled = false;
  if (res.ok) {
    msg.className = 'form-msg success'; msg.textContent = '✓ Producto guardado correctamente'; msg.style.display = 'block';
    document.getElementById('product-form').reset();
    document.getElementById('edit-id').value = '';
    document.getElementById('image-preview-wrap').style.display = 'none';
    document.getElementById('form-title').textContent = 'Agregar Producto';
    setTimeout(() => { showTab('products'); }, 1200);
  } else {
    const err = await res.json().catch(() => ({}));
    msg.className = 'form-msg error'; msg.textContent = '✗ ' + (err.error || 'Error al guardar'); msg.style.display = 'block';
  }
}

async function editProduct(id) {
  const products = await fetch('/api/admin/products').then(r => r.json());
  const p = products.find(x => x.id === id);
  if (!p) return;
  document.getElementById('edit-id').value = p.id;
  document.getElementById('p-name').value = p.name;
  document.getElementById('p-service').value = p.service || '';
  document.getElementById('p-account-type').value = p.account_type;
  document.getElementById('p-price').value = p.price;
  document.getElementById('p-days').value = p.days_guaranteed;
  document.getElementById('p-features').value = (p.features || []).join('\n');
  document.getElementById('p-whatsapp').value = p.whatsapp_message;
  if (p.image) { document.getElementById('image-preview').src = p.image; document.getElementById('image-preview-wrap').style.display = 'block'; }
  document.getElementById('form-title').textContent = 'Editar Producto';
  showTab('add-product');
}

function cancelEdit() {
  document.getElementById('product-form').reset();
  document.getElementById('edit-id').value = '';
  document.getElementById('image-preview-wrap').style.display = 'none';
  document.getElementById('form-title').textContent = 'Agregar Producto';
  document.getElementById('form-msg').style.display = 'none';
  showTab('products');
}

async function toggleProduct(id) {
  await fetch(`/api/admin/products/${id}/toggle`, { method:'PATCH' });
  loadAdminProducts();
}

function confirmDelete(id, name) {
  pendingDeleteId = id;
  document.getElementById('modal-msg').textContent = `¿Eliminar "${name}"? Esta acción no se puede deshacer.`;
  document.getElementById('modal').style.display = 'flex';
  document.getElementById('modal-confirm').onclick = async () => {
    await fetch(`/api/admin/products/${pendingDeleteId}`, { method:'DELETE' });
    closeModal(); loadAdminProducts();
  };
}
function closeModal() { document.getElementById('modal').style.display = 'none'; }

async function saveSettings(e) {
  e.preventDefault();
  const msg = document.getElementById('settings-msg');
  msg.style.display = 'none';
  const formData = new FormData();
  formData.append('site_title', document.getElementById('s-title').value);
  formData.append('whatsapp_number', document.getElementById('s-whatsapp').value);
  const banner = document.getElementById('s-banner').files[0];
  if (banner) formData.append('banner', banner);
  const res = await fetch('/api/admin/settings', { method:'POST', body: formData });
  if (res.ok) { msg.className = 'form-msg success'; msg.textContent = '✓ Configuración guardada'; }
  else { msg.className = 'form-msg error'; msg.textContent = '✗ Error al guardar'; }
  msg.style.display = 'block';
}

function exportBackup() { window.location.href = '/api/admin/backup'; }

async function importBackup() {
  const file = document.getElementById('restore-file').files[0];
  const msg = document.getElementById('restore-msg');
  if (!file) { msg.className = 'form-msg error'; msg.textContent = 'Selecciona un archivo'; msg.style.display = 'block'; return; }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await fetch('/api/admin/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
    if (res.ok) { msg.className = 'form-msg success'; msg.textContent = '✓ Datos restaurados correctamente'; }
    else { msg.className = 'form-msg error'; msg.textContent = '✗ Error al restaurar'; }
  } catch { msg.className = 'form-msg error'; msg.textContent = '✗ Archivo inválido'; }
  msg.style.display = 'block';
}

function getEmoji(service) {
  const map = { netflix:'🎬', disney:'🏰', hbo:'📺', amazon:'🎥', paramount:'⭐', apple:'🍎', spotify:'🎵' };
  const k = (service||'').toLowerCase();
  for (const key in map) { if (k.includes(key)) return map[key]; }
  return '📺';
}
