import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreateDocument } from '../cloud/parsefunction/createDocument.js';

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

  const deliveries = [];
  const createDocument = createCreateDocument({
    deliverInitial: async (document, request, key) => {
      deliveries.push({ document, request, key });
    },
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
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].document, existingDocument);
  assert.equal(deliveries[0].key, 'stable-key');
});

test('createDocument propagates a pending initial delivery failure on replay', async t => {
  const previousParse = globalThis.Parse;
  const actingUser = { id: 'creator-1' };
  const template = {
    get: key => (key === 'CreatedBy' ? actingUser : undefined),
    toJSON: () => ({ Name: 'Template', Placeholders: [] }),
  };
  const existingDocument = {
    id: 'doc-existing',
    get: key => (key === 'Placeholders' ? [] : undefined),
    toJSON: () => ({ objectId: 'doc-existing' }),
  };

  class Query {
    constructor(className) {
      this.className = className;
    }

    equalTo() {
      return this;
    }

    include() {
      return this;
    }

    async first() {
      return this.className === 'contracts_Template' ? template : existingDocument;
    }
  }

  globalThis.Parse = {
    Error: class ParseError extends Error {},
    Query,
  };
  t.after(() => {
    globalThis.Parse = previousParse;
  });

  const createDocument = createCreateDocument({
    deliverInitial: async () => {
      throw new Error('mail provider unavailable');
    },
  });

  await assert.rejects(
    createDocument({
      params: { templateId: 'template-1', idempotencyKey: 'stable-key' },
      headers: {},
      user: actingUser,
    }),
    /mail provider unavailable/
  );
});

test('createDocument marks a first-attempt preparation rejection as definitive', async t => {
  const previousParse = globalThis.Parse;
  const actingUser = { id: 'creator-1' };
  const template = {
    get: key => (key === 'CreatedBy' ? actingUser : undefined),
    toJSON: () => ({ Name: 'Template', Placeholders: [] }),
  };

  class Query {
    constructor(className) {
      this.className = className;
    }

    equalTo() {
      return this;
    }

    include() {
      return this;
    }

    async first() {
      return this.className === 'contracts_Template' ? template : null;
    }
  }

  class ParseObject {
    constructor() {
      throw new Error('invalid document preparation');
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

  const createDocument = createCreateDocument({ deliverInitial: async () => {} });
  const result = await createDocument({
    params: { templateId: 'template-1', idempotencyKey: 'stable-key' },
    headers: {},
    user: actingUser,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'document_creation_rejected');
  assert.equal(result.creationStarted, false);
  assert.match(result.message, /invalid document preparation/);
});

test('createDocument keeps a save failure ambiguous after persistence starts', async t => {
  const previousParse = globalThis.Parse;
  const actingUser = { id: 'creator-1' };
  const template = {
    get: key => (key === 'CreatedBy' ? actingUser : undefined),
    toJSON: () => ({ Name: 'Template', Placeholders: [] }),
  };

  class Query {
    constructor(className) {
      this.className = className;
    }

    equalTo() {
      return this;
    }

    include() {
      return this;
    }

    async first() {
      return this.className === 'contracts_Template' ? template : null;
    }
  }

  class ParseObject {
    constructor() {
      this.values = {};
    }

    set(key, value) {
      this.values[key] = value;
    }

    async save() {
      throw new Error('save response lost');
    }
  }

  class ParseError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  ParseError.INTERNAL_SERVER_ERROR = 1;

  globalThis.Parse = {
    Error: ParseError,
    Object: ParseObject,
    Query,
  };
  t.after(() => {
    globalThis.Parse = previousParse;
  });

  const createDocument = createCreateDocument({ deliverInitial: async () => {} });
  await assert.rejects(
    createDocument({
      params: { templateId: 'template-1', idempotencyKey: 'stable-key' },
      headers: {},
      user: actingUser,
    }),
    /save response lost/
  );
});
