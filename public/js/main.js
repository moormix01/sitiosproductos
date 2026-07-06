document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadSettings(), loadProducts()]);
  setupMobileMenu();
});

async function loadSettings() {
  try {
    const res = await fetch('/api/settings/public');
    const s = await res.json();
    if (s.site_title) {
      document.title = s.site_title;
      const el = document.getElementById('site-title');
      const ft = document.getElementById('footer-title');
      if (el) el.textContent = s.site_title;
      if (ft) ft.textContent = s.site_title;
    }
    if (s.banner_image) {
      document.getElementById('banner-section').style.display = 'block';
      document.getElementById('banner-img').src = s.banner_image;
      document.getElementById('hero').style.display = 'none';
    }
    if (s.whatsapp_number) {
      const btn = document.getElementById('contact-wa-btn');
      if (btn) btn.href = `https://wa.me/${s.whatsapp_number.replace(/\D/g,'')}?text=Hola%20Jack%2C%20vengo%20de%20tu%20sitio%20web%20y%20quisiera%20obtener%20m%C3%A1s%20informaci%C3%B3n`;
    }
  } catch (e) { console.error(e); }
}

async function loadProducts() {
  const grid = document.getElementById('products-grid');
  const empty = document.getElementById('empty-state');
  try {
    const res = await fetch('/api/products');
    const products = await res.json();
    grid.innerHTML = '';
    if (!products.length) { empty.style.display = 'block'; return; }
    products.forEach(p => { grid.appendChild(createCard(p)); });
  } catch (e) {
    grid.innerHTML = '<div class="empty-state"><p>Error al cargar productos</p></div>';
  }
}

function createCard(p) {
  const div = document.createElement('div');
  div.className = 'product-card';

  const waNumber = '';
  const msg = encodeURIComponent(p.whatsapp_message || `Hola Jack, vengo de tu sitio web, me interesa comprar ${p.name}`);

  const featuresHTML = (p.features || []).map(f => `<li>${f}</li>`).join('');
  const badgeClass = p.account_type === 'perfil' ? 'badge-perfil' : 'badge-cuenta';
  const badgeLabel = p.account_type === 'perfil' ? 'Perfil' : 'Cuenta';

  const imageHTML = p.image
    ? `<img src="${p.image}" alt="${p.name}" loading="lazy">`
    : `<div class="card-image-placeholder">${getServiceEmoji(p.service)}</div>`;

  div.innerHTML = `
    <div class="card-image-wrap">
      ${imageHTML}
      <span class="account-badge ${badgeClass}">${badgeLabel}</span>
    </div>
    <div class="card-body">
      <h3 class="card-title">${p.name}</h3>
      <span class="card-guarantee">✓ ${p.days_guaranteed || 30} días garantizados</span>
      ${featuresHTML ? `<ul class="card-features">${featuresHTML}</ul>` : ''}
      <p class="card-price">$${parseFloat(p.price).toFixed(2)} <span>USD</span></p>
      <a class="wa-btn" href="https://wa.me/${(p.whatsapp_number||'').replace(/\D/g,'')}?text=${msg}" target="_blank" rel="noopener" id="wa-${p.id}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        Comprar por WhatsApp
      </a>
    </div>`;

  fetch('/api/settings/public').then(r => r.json()).then(s => {
    const btn = document.getElementById(`wa-${p.id}`);
    if (btn && s.whatsapp_number) {
      btn.href = `https://wa.me/${s.whatsapp_number.replace(/\D/g,'')}?text=${msg}`;
    }
  });

  return div;
}

function getServiceEmoji(service) {
  const map = {
    netflix: '🎬', disney: '🏰', hbo: '📺', amazon: '🎥',
    paramount: '⭐', apple: '🍎', crunchyroll: '🐸', youtube: '▶️', spotify: '🎵'
  };
  const key = (service || '').toLowerCase();
  for (const k in map) { if (key.includes(k)) return map[k]; }
  return '📺';
}

function setupMobileMenu() {
  const toggle = document.getElementById('menu-toggle');
  const nav = document.getElementById('mobile-nav');
  toggle?.addEventListener('click', () => nav.classList.toggle('open'));
}

function closeMobileNav() {
  document.getElementById('mobile-nav')?.classList.remove('open');
}
