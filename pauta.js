/* Feeds e cache ficam salvos no navegador. Também dá para abrir com ?rss=ENDERECO (aceita vários, separados por vírgula). */
const CACHE_MINUTES = 15;
const MAX_ITEMS = 12;
const PALETTE = ['#D62839', '#1F6FB2', '#E08A00', '#7A3FD1', '#1E9E6A', '#0E8F9E', '#C2410C', '#4D7C0F'];
const API_KEY = ''; // opcional: chave do rss2json para mais requisições

const $app = document.getElementById('app');
const $chips = document.getElementById('chips');
const $tools = document.getElementById('tools');
const $msg = document.getElementById('msg');
const $status = document.getElementById('status');
const $input = document.getElementById('rssUrl');
const $addBtn = document.getElementById('addBtn');

const state = { feeds: [], items: [], source: 'all', q: '', errors: [], updatedAt: null };

/* ---------- utilidades ---------- */
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}
function plainText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}
function firstImage(html) {
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}
function safeUrl(u) {
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('http://')) u = 'https://' + u.slice(7);
  return /^https:\/\//i.test(u) ? u : '';
}
function parseDate(value) {
  if (!value) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;

  // Preserve explicit timezone information. For timezone-less ISO-like
  // values, let the browser interpret them as local time instead of
  // forcing UTC with a trailing "Z".
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)
    ? raw.replace(' ', 'T')
    : raw;

  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
function timeAgo(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return `há ${d} d`;
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}
function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch (e) { return ''; }
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }
function getFeed(url) { return state.feeds.find(f => f.url === url); }
function say(text) { $msg.textContent = text || ''; }

/* ---------- armazenamento ---------- */
function saveFeeds() { try { localStorage.setItem('pauta:feeds', JSON.stringify(state.feeds)); } catch (e) {} }
function loadFeeds() { try { const v = JSON.parse(localStorage.getItem('pauta:feeds') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function cacheKey(url) { return 'pauta:cache:' + url; }
function readCache(url) {
  try {
    const o = JSON.parse(localStorage.getItem(cacheKey(url)) || 'null');
    if (o && Date.now() - o.t < CACHE_MINUTES * 60000) return o;
  } catch (e) {}
  return null;
}
function writeCache(url, title, items) { try { localStorage.setItem(cacheKey(url), JSON.stringify({ t: Date.now(), title, items })); } catch (e) {} }
function dropCache(url) { try { localStorage.removeItem(cacheKey(url)); } catch (e) {} }

/* ---------- leitura do feed ---------- */
const PROXIES = [
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)
];

async function fetchWithTimeout(u, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), ms);

  try {
    return await fetch(u, {
      signal: controller.signal,
      headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('tempo limite excedido após ' + Math.round(ms / 1000) + ' segundos');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Caminho 1: rss2json (devolve JSON pronto)
async function viaRss2json(url) {
  let api = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url);
  api += '&count=' + MAX_ITEMS;
  if (API_KEY) api += '&api_key=' + encodeURIComponent(API_KEY);
  const res = await fetchWithTimeout(api, 25000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'Feed inválido');
  const items = (data.items || []).slice(0, MAX_ITEMS).map(it => {
    const enc = it.enclosure && it.enclosure.link && /image|jpe?g|png|webp/i.test((it.enclosure.type || '') + it.enclosure.link) ? it.enclosure.link : '';
    return {
      source: url,
      title: plainText(it.title),
      link: it.link,
      date: parseDate(it.pubDate),
      summary: plainText(it.description || it.content).slice(0, 240),
      img: safeUrl(it.thumbnail || enc || firstImage(it.content) || firstImage(it.description))
    };
  });
  return { title: plainText(data.feed && data.feed.title), items };
}

// Caminho 2: baixa o texto (direto ou por proxy CORS) e lê o XML no navegador
async function fetchTextAny(url, errors) {
  const attempts = [url, ...PROXIES.map(p => p(url))];
  for (const a of attempts) {
    try {
      const r = await fetchWithTimeout(a, 25000);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' em ' + new URL(a).hostname);
      const t = await r.text();
      if (t && t.length > 50) return t;
      throw new Error('resposta vazia');
    } catch (e) {
      errors.push((e && e.message) ? e.message : 'falha de rede');
    }
  }
  return null;
}

function parseXml(text, url) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const nodes = Array.from(doc.getElementsByTagName('item'));
  const entries = nodes.length ? nodes : Array.from(doc.getElementsByTagName('entry'));
  if (!entries.length) return null;
  const txt = (n, ...names) => {
    for (const name of names) {
      const candidates = [
        ...n.getElementsByTagName(name),
        ...n.getElementsByTagNameNS('*', name.includes(':') ? name.split(':').pop() : name)
      ];

      const e = candidates.find(node => node && node.textContent.trim());
      if (e) return e.textContent.trim();
    }
    return '';
  };
  const attr = (n, tag, a) => { const e = n.getElementsByTagName(tag)[0]; return e ? (e.getAttribute(a) || '') : ''; };
  const items = entries.slice(0, MAX_ITEMS).map(n => {
    let href = '';
    const ls = Array.from(n.getElementsByTagName('link'));
    for (const l of ls) {
      const h = l.getAttribute('href');
      if (h && (!l.getAttribute('rel') || l.getAttribute('rel') === 'alternate')) { href = h; break; }
    }
    if (!href) href = txt(n, 'link') || txt(n, 'guid');
    const body = txt(n, 'content:encoded', 'description', 'summary', 'content');
    const enc = n.getElementsByTagName('enclosure')[0];
    const encImg = enc && /image/i.test(enc.getAttribute('type') || '') ? enc.getAttribute('url') : '';
    return {
      source: url,
      title: plainText(txt(n, 'title')),
      link: href,
      date: parseDate(txt(n, 'pubDate', 'dc:date', 'published', 'updated')),
      summary: plainText(txt(n, 'description', 'summary', 'content')).slice(0, 240),
      img: safeUrl(
        attr(n, 'media:content', 'url')
        || attr(n, 'media:thumbnail', 'url')
        || attr(n, 'image', 'href')
        || encImg
        || firstImage(body)
      )
    };
  });
  const title = plainText(txt(doc.documentElement, 'title'));
  return { title, items };
}

// Se o usuário colou o link de um site, tenta achar o feed declarado na página
function discoverFeed(html, base) {
  if (!html) return '';

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links = Array.from(doc.querySelectorAll('link[href]'));
  const acceptedTypes = new Set([
    'application/rss+xml',
    'application/atom+xml',
    'application/rdf+xml',
    'application/xml',
    'text/xml'
  ]);

  for (const link of links) {
    const type = (link.getAttribute('type') || '').toLowerCase().trim();
    const href = link.getAttribute('href');
    const rel = (link.getAttribute('rel') || '').toLowerCase();

    const looksLikeFeed = acceptedTypes.has(type)
      || /(^|\\s)(alternate|feed)(\\s|$)/.test(rel) && /rss|atom|feed|xml/i.test(href || '');

    if (!href || !looksLikeFeed) continue;

    try {
      return new URL(href, base).href;
    } catch (e) {
      // Continue searching other link elements.
    }
  }

  return '';
}


// Fallback para sites WordPress usando a API REST.
async function viaWordPress(url) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { return null; }

  const apiUrl = parsed.origin + '/wp-json/wp/v2/posts?per_page=' + MAX_ITEMS
    + '&_embed=1&orderby=date&order=desc';

  const response = await fetchWithTimeout(apiUrl, 25000);
  if (!response.ok) throw new Error('WordPress API HTTP ' + response.status);

  const posts = await response.json();
  if (!Array.isArray(posts) || !posts.length) return null;

  const items = posts.map(post => {
    const embedded = post._embedded || {};
    const media = embedded['wp:featuredmedia'] && embedded['wp:featuredmedia'][0];
    const image = media && (media.source_url || (media.guid && media.guid.rendered));

    return {
      source: url,
      title: plainText(post.title && post.title.rendered),
      link: safeUrl(post.link),
      date: parseDate(post.date_gmt || post.date),
      summary: plainText(post.excerpt && post.excerpt.rendered).slice(0, 240),
      img: safeUrl(image || '')
    };
  }).filter(item => item.title && item.link);

  return items.length ? { title: hostOf(url), items } : null;
}

async function fetchFeed(url, force, depth = 0) {
  if (!force) {
    const c = readCache(url);
    if (c) return { title: c.title, items: c.items, url };
  }
  const errors = [];
  let result = null;

  try { result = await viaRss2json(url); } catch (e) { errors.push('rss2json: ' + e.message); }

  if (!result || !result.items.length) {
    const text = await fetchTextAny(url, errors);
    if (text) {
      result = parseXml(text, url);
      if (!result && depth === 0) {
        const alt = discoverFeed(text, url);
        if (alt && alt !== url) return fetchFeed(alt, true, 1);
      }
    }
  }

  if ((!result || !result.items.length) && depth === 0) {
    try {
      result = await viaWordPress(url);
    } catch (e) {
      errors.push('WordPress API: ' + (e.message || 'falha'));
    }
  }

  if (!result) {
    console.warn('Falha ao ler', url, errors);
    const detail = [...new Set(errors.filter(Boolean))].slice(-6).join(' | ');
    throw new Error(detail || 'Feed inválido ou inacessível');
  }

  const items = result.items.filter(i => i.title && /^https?:\/\//i.test(i.link || ''));
  if (!items.length) throw new Error('Feed sem notícias');
  const title = result.title || hostOf(url);
  writeCache(url, title, items);
  return { title, items, url };
}

async function loadAll(force) {
  if (!state.feeds.length) { state.items = []; state.errors = []; render(); return; }
  $app.replaceChildren(el('div', { class: 'state' }, 'Carregando notícias…'));
  const results = await Promise.allSettled(state.feeds.map(f => fetchFeed(f.url, force)));
  const seen = new Set();
  state.items = [];
  state.errors = [];
  results.forEach((r, i) => {
    const feed = state.feeds[i];
    if (r.status === 'fulfilled') {
      feed.name = r.value.title || feed.name;
      r.value.items.forEach(it => { if (!seen.has(it.link)) { seen.add(it.link); state.items.push(it); } });
    } else {
      state.errors.push(feed.name);
    }
  });
  saveFeeds();
  state.items.sort((a, b) => b.date - a.date);
  state.updatedAt = new Date();
  renderChips();
  render();
}

/* ---------- adicionar e remover ---------- */
async function addFeed(raw) {
  const url = normalizeUrl(raw);
  if (!url) { say('Esse endereço não parece válido. Cole o link completo do feed RSS.'); return; }
  if (getFeed(url)) { say('Esse feed já está no portal.'); return; }
  say('');
  $addBtn.disabled = true;
  try {
    const res = await fetchFeed(url, true);
    const feedUrl = res.url || url;
    if (getFeed(feedUrl)) { say('Esse feed já está no portal.'); return; }
    const used = new Set(state.feeds.map(f => f.color));
    const color = PALETTE.find(c => !used.has(c)) || PALETTE[state.feeds.length % PALETTE.length];
    state.feeds.push({ url: feedUrl, name: res.title, color });
    saveFeeds();
    $input.value = '';
    await loadAll(false);
  } catch (e) {
    const detail = e && e.message ? e.message : 'erro desconhecido';
    const shortDetail = detail.length > 220 ? detail.slice(0, 220) + '…' : detail;
    say('Não consegui ler o feed. Detalhes: ' + shortDetail);
    console.error('Erro ao adicionar feed:', e);
  } finally {
    $addBtn.disabled = false;
  }
}
function removeFeed(url) {
  state.feeds = state.feeds.filter(f => f.url !== url);
  dropCache(url);
  if (state.source === url) state.source = 'all';
  saveFeeds();
  state.items = state.items.filter(i => i.source !== url);
  state.errors = [];
  renderChips();
  render();
}

/* ---------- desenho ---------- */
function styleFor(url) { const f = getFeed(url); return '--src:' + (f ? f.color : 'var(--accent)'); }

function metaLine(it) {
  const f = getFeed(it.source);
  return el('div', { class: 'meta' },
    el('span', { class: 'dot' }),
    el('span', { class: 'who' }, f ? f.name : hostOf(it.source)),
    it.date ? el('span', null, timeAgo(it.date)) : null
  );
}
function media(it) {
  if (!it.img) return null;
  const img = el('img', { src: it.img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const box = el('div', { class: 'media' }, img);
  img.addEventListener('error', () => {
    box.replaceChildren();
    box.remove();
  });
  return box;
}
function link(it, children) {
  return el('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer' }, children);
}
function visibleItems() {
  const q = state.q.trim().toLowerCase();
  return state.items.filter(it =>
    (state.source === 'all' || it.source === state.source) &&
    (!q || (it.title + ' ' + it.summary).toLowerCase().includes(q))
  );
}

function renderChips() {
  $tools.hidden = !state.feeds.length;
  const all = el('div', { class: 'chip' + (state.source === 'all' ? ' on' : '') },
    el('button', { type: 'button', class: 'pick', 'aria-pressed': String(state.source === 'all') }, 'Todos'));
  all.querySelector('button').style.borderRadius = '999px';
  all.querySelector('button').style.paddingRight = '0.85rem';
  all.querySelector('button').addEventListener('click', () => { state.source = 'all'; renderChips(); render(); });

  const chips = state.feeds.map(f => {
    const pick = el('button', { type: 'button', class: 'pick', 'aria-pressed': String(state.source === f.url) },
      el('span', { class: 'dot' }), f.name);
    const x = el('button', { type: 'button', class: 'x', 'aria-label': 'Remover ' + f.name }, '×');
    const chip = el('div', { class: 'chip' + (state.source === f.url ? ' on' : '') }, pick, x);
    chip.style.setProperty('--src', f.color);
    pick.addEventListener('click', () => { state.source = f.url; renderChips(); render(); });
    x.addEventListener('click', () => removeFeed(f.url));
    return chip;
  });
  $chips.replaceChildren(all, ...chips);
}

function render() {
  $app.replaceChildren();

  if (!state.feeds.length) {
    $app.append(el('div', { class: 'state' },
      el('strong', null, 'Cole um endereço RSS para começar'),
      'O portal é montado a partir do feed que você adicionar. Você pode incluir quantos quiser e remover depois.'));
    $status.textContent = '';
    return;
  }

  const items = visibleItems();
  if (!items.length) {
    $app.append(el('div', { class: 'state' }, state.items.length
      ? 'Nenhuma notícia encontrada. Tente outro termo ou escolha outro feed.'
      : 'Não foi possível carregar as notícias. Clique em Atualizar para tentar de novo.'));
  } else {
    const leadIdx = Math.max(0, items.findIndex(i => i.img));
    const lead = items[leadIdx];
    const rest = items.filter((_, i) => i !== leadIdx);
    const latest = rest.slice(0, 5);
    const grid = rest.slice(5);

    const leadEl = el('article', { class: 'lead' }, link(lead, [
      media(lead),
      metaLine(lead),
      el('h2', { class: 'headline' }, lead.title),
      lead.summary ? el('p', { class: 'summary' }, lead.summary) : null
    ]));
    leadEl.setAttribute('style', styleFor(lead.source));

    const latestEl = el('aside', { class: 'latest' },
      el('h2', null, 'Mais recentes'),
      el('ol', null, latest.map(it => {
        const li = el('li', null, metaLine(it), link(it, el('span', { class: 'headline' }, it.title)));
        li.setAttribute('style', styleFor(it.source));
        return li;
      })));

    $app.append(el('section', { class: 'top' }, leadEl, latestEl));

    if (grid.length) {
      $app.append(el('section', { class: 'grid' }, grid.map(it => {
        const card = el('article', { class: 'card' },
          media(it), metaLine(it),
          link(it, el('h3', { class: 'headline' }, it.title)),
          it.summary ? el('p', { class: 'summary' }, it.summary) : null);
        card.setAttribute('style', styleFor(it.source));
        return card;
      })));
    }
  }

  const parts = [];
  if (state.updatedAt) parts.push('Atualizado às ' + state.updatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '.');
  if (state.errors.length) parts.push('Não carregaram: ' + state.errors.join(', ') + '.');
  $status.textContent = parts.join(' ');
}

/* ---------- eventos e tema ---------- */
document.getElementById('addForm').addEventListener('submit', e => { e.preventDefault(); addFeed($input.value); });
document.getElementById('refresh').addEventListener('click', () => loadAll(true));
let timer;
document.getElementById('q').addEventListener('input', e => {
  clearTimeout(timer);
  timer = setTimeout(() => { state.q = e.target.value; render(); }, 150);
});

const $theme = document.getElementById('theme');
function isDark() {
  const t = document.documentElement.getAttribute('data-theme');
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function syncThemeLabel() { $theme.textContent = isDark() ? 'Modo claro' : 'Modo escuro'; }
$theme.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('pauta:theme', next); } catch (e) {}
  syncThemeLabel();
});

/* ---------- início ---------- */
(function init() {
  syncThemeLabel();
  state.feeds = loadFeeds();

  // ?rss=url1,url2 adiciona feeds direto pelo link
  const fromLink = (new URLSearchParams(location.search).get('rss') || '').split(',').map(normalizeUrl).filter(Boolean);
  fromLink.forEach(u => {
    if (!getFeed(u)) state.feeds.push({ url: u, name: hostOf(u), color: PALETTE.find(c => !state.feeds.some(f => f.color === c)) || PALETTE[state.feeds.length % PALETTE.length] });
  });
  if (fromLink.length) saveFeeds();

  renderChips();
  loadAll(false);
})();
