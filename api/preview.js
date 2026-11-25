// Função da Vercel: recebe ?url=LINK e devolve título, foto, preço e loja do produto.
// Tenta vários "disfarces" (navegador, WhatsApp, Facebook, celular) e, se ainda faltar algo,
// usa o serviço gratuito microlink.io como reserva.
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'WhatsApp/2.23.20.0 A',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];
const PRIVATE = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/;
const BLOCKED_TITLE = /robot check|captcha|access denied|just a moment|attention required|are you a human|verifica|acesso negado|forbidden/i;

function dec(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\s+/g, ' ').trim();
}

function meta(html, keys) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const k of keys) {
    for (const t of tags) {
      const m = t.match(/(?:property|name|itemprop)\s*=\s*["']?([^"'\s>]+)["']?/i);
      if (m && m[1].toLowerCase() === k) {
        const c = t.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i);
        if (c) {
          const v = dec(c[1] !== undefined ? c[1] : c[2]);
          if (v) return v;
        }
      }
    }
  }
  return '';
}

function findProduct(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findProduct(n); if (r) return r; }
    return null;
  }
  if (/Product/i.test([].concat(node['@type'] || []).join(','))) return node;
  if (node['@graph']) return findProduct(node['@graph']);
  return null;
}

function ldProduct(html) {
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const p = findProduct(JSON.parse(m[1].trim()));
      if (p) return p;
    } catch (e) { /* JSON inválido: ignora */ }
  }
  return null;
}

function parsePrice(v) {
  if (v === undefined || v === null || v === '') return '';
  let s = String(v).replace(/[^\d.,]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? '' : n;
}

function extract(html, base) {
  const ld = ldProduct(html);
  let ldImg = ld && ld.image;
  if (Array.isArray(ldImg)) ldImg = ldImg[0];
  if (ldImg && typeof ldImg === 'object') ldImg = ldImg.url || ldImg['@id'];
  let offer = ld && ld.offers;
  if (Array.isArray(offer)) offer = offer[0];

  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const amzTitle = (html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1];
  let title = dec(amzTitle || (ld && ld.name) || meta(html, ['og:title', 'twitter:title']) || titleTag || '');
  if (BLOCKED_TITLE.test(title)) title = '';

  const amzImg =
    (html.match(/"hiRes"\s*:\s*"(https:[^"]+)"/i) || [])[1] ||
    (html.match(/id=["']landingImage["'][^>]*?src=["']([^"']+)["']/i) || [])[1] ||
    (html.match(/data-old-hires=["']([^"']+)["']/i) || [])[1];
  let image = meta(html, ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']) || ldImg || amzImg || '';
  if (image) { try { image = new URL(image, base).href; } catch (e) { image = ''; } }

  const amzPrice = (html.match(/class=["']a-offscreen["'][^>]*>([^<]+)</i) || [])[1];
  const price = parsePrice(
    meta(html, ['product:price:amount', 'og:price:amount']) ||
    (offer && (offer.price || offer.lowPrice)) || amzPrice || ''
  );
  const strip = t => dec(String(t || '').replace(/<[^>]+>/g, ' '));
  const bullets = (html.match(/id=["']feature-bullets["'][\s\S]*?<\/ul>/i) || [''])[0]
    .match(/<span class=["']a-list-item["'][^>]*>([\s\S]*?)<\/span>/gi);
  const amzDesc = bullets ? bullets.map(strip).filter(Boolean).map(x => '• ' + x).join('\n') : '';
  const cands = [
    strip(ld && ld.description),
    meta(html, ['og:description', 'twitter:description', 'description']),
    amzDesc
  ].filter(Boolean);
  let description = cands.sort((a, b) => b.length - a.length)[0] || '';
  if (description.length > 900) description = description.slice(0, 900).replace(/\s+\S*$/, '') + '...';
  return { title, image, price, description };
}

async function grab(href, ua, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(href, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      }
    });
    const html = (await r.text()).slice(0, 1500000);
    return { status: r.status, url: r.url, html };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600');
  let u;
  try { u = new URL(req.query.url); } catch (e) { return res.status(400).json({ error: 'Link inválido.' }); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) {
    return res.status(400).json({ error: 'Link não permitido.' });
  }

  const best = { title: '', image: '', price: '', description: '' };
  let finalUrl = u.href, status = 0, lastErr = '';
  const start = Date.now();

  for (const ua of UAS) {
    if (Date.now() - start > 13000) break;
    try {
      const g = await grab(u.href, ua, 5000);
      status = g.status;
      finalUrl = g.url || finalUrl;
      const e = extract(g.html, finalUrl);
      best.title = best.title || e.title;
      best.image = best.image || e.image;
      best.price = best.price || e.price;
      if (e.description.length > best.description.length) best.description = e.description;
      if (best.title && best.image) break;
    } catch (err) {
      lastErr = err.name === 'AbortError' ? 'tempo esgotado' : String((err && err.message) || err);
    }
  }

  if (!(best.title && best.image)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      const r = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(u.href), { signal: ctrl.signal });
      clearTimeout(timer);
      const j = await r.json();
      if (j && j.status === 'success' && j.data) {
        const t = dec(j.data.title || '');
        if (!BLOCKED_TITLE.test(t)) best.title = best.title || t;
        best.image = best.image || (j.data.image && j.data.image.url) || '';
        best.description = best.description || dec(j.data.description || '');
      }
    } catch (e) { /* sem reserva */ }
  }

  if (!best.title && !best.image) {
    return res.status(200).json({
      error: 'Não consegui ler os dados desse produto.',
      detail: status ? 'O site respondeu com código ' + status + '.' : (lastErr ? 'Erro: ' + lastErr + '.' : '')
    });
  }
  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  const store = host.split('.')[0].replace(/^./, c => c.toUpperCase());
  return res.status(200).json({ title: best.title, image: best.image, price: best.price, description: best.description, store, url: finalUrl });
};
