import assert from 'node:assert/strict';
import test from 'node:test';

import createDocument from '../cloud/parsefunction/createDocument.js';

test('createDocument returns the existing document for the same idempotency key', async t => {
  const previousParse = globalThis.Parse;
  const queryFilters = [];
  let objectConstructions = 0;
  const actingUser = {
    id: 'creator-1',
    get: key => ({ Name: 'Creator', Email: 'creator@example.test' })[key],
  };
  const template = {
    get: key => (key === 'CreatedBy' ? actingUser : undefined),
    toJSON: () => ({
      Name: 'Template',
      Placeholders: [{ Role: 'Customer' }],
    }),
  };
  const existingDocument = {
    id: 'doc-existing',
    get: key =>
      key === 'Placeholders'
        ? [
            { Role: 'prefill' },
            {
              Role: 'Customer',
              email: 'signer@example.test',
              signerObjId: 'contact-1',
            },
          ]
        : undefined,
    toJSON: () => ({ objectId: 'doc-existing' }),
  };

  class Query {
    constructor(className) {
      this.className = className;
      this.filters = {};
      queryFilters.push(this);
    }

    equalTo(key, value) {
      this.filters[key] = value;
      return this;
    }

    include() {
      return this;
    }

    async first() {
      if (this.className === 'contracts_Template') return template;
      if (this.className === 'contracts_Document') return existingDocument;
      return null;
    }
  }

  class ParseObject {
    constructor() {
      objectConstructions += 1;
    }
  }

  globalThis.Parse = {
    Error: class ParseError extends Error {},
    Object: ParseObject,
    Query,
  };
  t.after(() => {
    globalThis.Parse = previousParse;
  });

  const result = await createDocument({
    params: {
      templateId: 'template-1',
      idempotencyKey: 'stable-key',
      publicUrl: 'https://sign.example.test',
    },
    headers: {},
    user: actingUser,
  });

  assert.equal(result.objectId, 'doc-existing');
  assert.equal(result.idempotentReplay, true);
  assert.equal(
    result.signingUrl,
    'https://sign.example.test/load/recipientSignPdf/doc-existing/contact-1'
  );
  assert.equal(objectConstructions, 0);
  const documentQuery = queryFilters.find(query => query.className === 'contracts_Document');
  assert.equal(documentQuery.filters.CreatedBy, actingUser);
  assert.equal(documentQuery.filters.FivaIdempotencyKey, 'stable-key');
});
