// Função serverless da Vercel: recebe ?url=LINK_DO_PRODUTO e devolve título, foto, preço e loja.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PRIVATE = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/;

function dec(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();
}

function meta(html, keys) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const k of keys) {
    for (const t of tags) {
      const m = t.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i);
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
    } catch (e) { /* ignora JSON inválido */ }
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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600');
  let u;
  try { u = new URL(req.query.url); } catch (e) { return res.status(400).json({ error: 'Link inválido.' }); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) {
    return res.status(400).json({ error: 'Link não permitido.' });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(u.href, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      }
    });
    clearTimeout(timer);
    const html = (await r.text()).slice(0, 1500000);

    const ld = ldProduct(html);
    let ldImg = ld && ld.image;
    if (Array.isArray(ldImg)) ldImg = ldImg[0];
    if (ldImg && typeof ldImg === 'object') ldImg = ldImg.url || ldImg['@id'];
    let offer = ld && ld.offers;
    if (Array.isArray(offer)) offer = offer[0];

    const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const title = dec((ld && ld.name) || meta(html, ['og:title', 'twitter:title']) || titleTag || '');
    let image = meta(html, ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']) || ldImg || '';
    if (image) { try { image = new URL(image, r.url).href; } catch (e) { image = ''; } }
    const price = parsePrice(
      meta(html, ['product:price:amount', 'og:price:amount']) ||
      (offer && (offer.price || offer.lowPrice)) || ''
    );
    const host = new URL(r.url).hostname.replace(/^www\./, '');
    const store = host.split('.')[0].replace(/^./, c => c.toUpperCase());

    if (!title && !image) {
      return res.status(200).json({ error: 'Esse site não liberou os dados do produto.' });
    }
    return res.status(200).json({ title, image, price, store, url: r.url });
  } catch (e) {
    return res.status(200).json({ error: 'Não consegui abrir esse link.' });
  }
};
