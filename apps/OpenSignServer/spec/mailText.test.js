import assert from 'node:assert/strict';
import test from 'node:test';

import { htmlToText, plainTextBody } from '../cloud/parsefunction/mailText.js';

test('plain text mirrors the HTML body instead of a placeholder', () => {
  const html = `<!DOCTYPE html><html><head><title>Firma</title><style>p{color:red}</style></head>
<body><span style="display:none">preheader</span><h1>Tu contrato está preparado</h1>
<p>Hola Ana,<br>revisa y firma el contrato.</p>
<a href="https://sign.example.test/doc/1" style="color:#fff">Revisar y firmar el contrato</a>
<p>FIVA E&amp;S Solutions &middot; &#169; 2026</p></body></html>`;

  const text = htmlToText(html);

  assert.equal(
    text,
    [
      'Tu contrato está preparado',
      '',
      'Hola Ana,',
      'revisa y firma el contrato.',
      '',
      'Revisar y firmar el contrato: https://sign.example.test/doc/1',
      'FIVA E&S Solutions · © 2026',
    ].join('\n')
  );
  assert.ok(!text.includes('preheader'));
  assert.ok(!text.includes('color:red'));
});

test('explicit text wins and an empty message never falls back to "mail"', () => {
  assert.equal(plainTextBody({ text: 'Texto propio', html: '<p>HTML</p>' }), 'Texto propio');
  assert.equal(plainTextBody({ html: '<p>Hola</p>' }), 'Hola');
  assert.notEqual(plainTextBody({}), 'mail');
});
