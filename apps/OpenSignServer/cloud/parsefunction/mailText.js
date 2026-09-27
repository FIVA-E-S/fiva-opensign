const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&copy;': '©',
  '&middot;': '·',
};

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z]+;|&#39;/gi, entity => ENTITIES[entity.toLowerCase()] ?? entity);
}

// Plain-text alternative derived from the HTML body. Mail providers score a
// text/plain part that does not match the HTML part (e.g. the literal "mail")
// as spam, so every message carries a readable version of its own content.
export function htmlToText(html) {
  if (!html) return '';
  const text = String(html)
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      if (!cleanLabel || cleanLabel === href) return href;
      return `${cleanLabel}: ${href}`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function plainTextBody(params = {}) {
  return params.text || htmlToText(params.html) || ' ';
}
