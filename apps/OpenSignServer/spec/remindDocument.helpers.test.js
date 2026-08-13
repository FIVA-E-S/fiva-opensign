import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSigningUrl,
  isSignerAlreadySigned,
  normalizePublicUrl,
  signerIdentity,
  wasReminderDelivered,
} from '../cloud/parsefunction/remindDocument.helpers.js';
import { createRemindDocument } from '../cloud/parsefunction/remindDocument.js';

function parseObject(id, values = {}) {
  return {
    id,
    get: key => values[key],
    toJSON: () => ({ objectId: id, ...values }),
  };
}

function installParseMock(t, document, contacts = {}) {
  const previousParse = global.Parse;
  const queryCalls = [];

  class ParseError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  ParseError.INVALID_QUERY = 102;
  ParseError.VALIDATION_ERROR = 142;
  ParseError.OPERATION_FORBIDDEN = 119;
  ParseError.INVALID_SESSION_TOKEN = 209;
  ParseError.INTERNAL_SERVER_ERROR = 1;

  class Query {
    constructor(className) {
      this.className = className;
      assert.ok(['contracts_Document', 'contracts_Contactbook'].includes(className));
    }

    include(path) {
      queryCalls.push(['include', path]);
      return this;
    }

    async get(documentId, options) {
      queryCalls.push(['get', this.className, documentId, options]);
      if (this.className === 'contracts_Document') return document;
      if (contacts[documentId]) return contacts[documentId];
      throw new Error('contact not found');
    }
  }

  global.Parse = { Error: ParseError, Query };
  t.after(() => {
    global.Parse = previousParse;
  });
  return queryCalls;
}

function reminderDocument(overrides = {}) {
  const creator = parseObject('creator-1', {
    Name: 'Fiva',
    Email: 'firma@example.test',
  });
  const extUser = parseObject('ext-user-1', {
    Company: 'Fiva',
    Phone: '600000000',
    TenantId: {},
  });
  const values = {
    CreatedBy: creator,
    ExtUserPtr: extUser,
    IsCompleted: false,
    IsDeclined: false,
    Name: 'Contrato existente',
    Note: 'Revisa y firma el contrato',
    TimeToCompleteDays: 15,
    SendinOrder: false,
    RequestSubject: 'Firma {{document_title}}',
    RequestBody: '<p>Hola {{receiver_name}}: <a href="{{signing_url}}">Firma</a></p>',
    Placeholders: [
      {
        Name: 'Firmado',
        email: 'signed@example.test',
        signerObjId: 'contact-signed',
      },
      {
        Name: 'Pendiente',
        email: 'pending@example.test',
        signerObjId: 'contact-pending',
      },
    ],
    AuditTrail: [
      {
        Activity: 'Signed',
        UserPtr: parseObject('contact-signed', {
          Email: 'signed@example.test',
        }),
      },
    ],
    ...overrides,
  };
  return {
    creator,
    document: {
      id: 'doc-existing',
      createdAt: new Date('2026-08-01T10:00:00Z'),
      get: key => values[key],
      set: (key, value) => {
        values[key] = value;
      },
      saveCalls: 0,
      async save() {
        this.saveCalls += 1;
        return this;
      },
      values,
    },
  };
}

test('normalizePublicUrl keeps only the public origin', () => {
  assert.equal(
    normalizePublicUrl('https://sign.example.test/api/app'),
    'https://sign.example.test'
  );
});

test('normalizePublicUrl rejects non-HTTP protocols', () => {
  assert.throws(() => normalizePublicUrl('javascript:alert(1)'), /must use HTTP or HTTPS/);
});

test('buildSigningUrl uses the direct contact link when available', () => {
  assert.equal(
    buildSigningUrl('https://sign.example.test/api/app', 'doc-1', {
      email: 'signer@example.test',
      signerObjId: 'contact-1',
    }),
    'https://sign.example.test/load/recipientSignPdf/doc-1/contact-1'
  );
});

test('buildSigningUrl falls back to the encoded login link', () => {
  const expected = Buffer.from('doc-1/signer@example.test').toString('base64');
  assert.equal(
    buildSigningUrl('https://sign.example.test', 'doc-1', {
      email: 'signer@example.test',
    }),
    `https://sign.example.test/login/${expected}`
  );
});

test('isSignerAlreadySigned matches the signer pointer', () => {
  assert.equal(
    isSignerAlreadySigned(
      [
        {
          Activity: 'Signed',
          UserPtr: { objectId: 'contact-1' },
        },
      ],
      { signerObjId: 'contact-1', email: 'signer@example.test' }
    ),
    true
  );
});

test('isSignerAlreadySigned ignores viewed audit entries', () => {
  assert.equal(
    isSignerAlreadySigned(
      [
        {
          Activity: 'Viewed',
          UserPtr: { objectId: 'contact-1' },
        },
      ],
      { signerObjId: 'contact-1', email: 'signer@example.test' }
    ),
    false
  );
});

test('isSignerAlreadySigned supports Parse objects and case-insensitive email', () => {
  assert.equal(
    isSignerAlreadySigned(
      [
        {
          Activity: 'SIGNED',
          UserPtr: parseObject('contact-1', {
            Email: 'SIGNER@example.test',
          }),
        },
      ],
      {
        signerPtr: parseObject('contact-1'),
        email: 'signer@example.test',
      }
    ),
    true
  );
});

test('reminder delivery identity is stable for contact pointers', () => {
  const signer = { signerPtr: { objectId: 'contact-1' } };
  assert.equal(signerIdentity(signer), 'contact:contact-1');
  assert.equal(
    wasReminderDelivered(
      [{ idempotencyKey: 'retry-1', signerIdentity: 'contact:contact-1' }],
      'retry-1',
      signer
    ),
    true
  );
});

test('remindDocument reuses the existing document and emails only pending signers', async t => {
  const { creator, document } = reminderDocument();
  const queryCalls = installParseMock(t, document);
  const sentMessages = [];
  const remindDocument = createRemindDocument({
    now: () => new Date('2026-08-10T10:00:00Z'),
    createIdempotencyKey: () => 'reminder-1',
    sendmail: async message => {
      sentMessages.push(message);
      return { status: 'success' };
    },
  });

  const result = await remindDocument({
    master: true,
    params: {
      documentId: 'doc-existing',
      publicUrl: 'https://sign.example.test/api/app',
    },
    headers: {},
    user: null,
  });

  assert.deepEqual(result, {
    status: 'success',
    message: 'reminder_sent',
    objectId: 'doc-existing',
    sent: 1,
    skipped: 0,
    idempotencyKey: 'reminder-1',
  });
  assert.deepEqual(queryCalls.at(-1), [
    'get',
    'contracts_Document',
    'doc-existing',
    { useMasterKey: true },
  ]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].user, creator);
  assert.equal(sentMessages[0].params.recipient, 'pending@example.test');
  assert.match(
    sentMessages[0].params.html,
    /https:\/\/sign\.example\.test\/load\/recipientSignPdf\/doc-existing\/contact-pending/
  );
});

test('remindDocument renews an expired document before emailing', async t => {
  const { document } = reminderDocument({
    ExpiryDate: { iso: '2026-08-01T00:00:00Z' },
    AuditTrail: [],
    Placeholders: [{ email: 'pending@example.test', signerObjId: 'contact-pending' }],
  });
  installParseMock(t, document);
  const remindDocument = createRemindDocument({
    now: () => new Date('2026-08-13T10:00:00Z'),
    createIdempotencyKey: () => 'expiry-1',
    sendmail: async () => ({ status: 'success' }),
  });

  await remindDocument({
    master: true,
    params: { documentId: 'doc-existing', publicUrl: 'https://sign.example.test' },
    headers: {},
    user: null,
  });

  assert.equal(document.values.ExpiryDate.toISOString(), '2026-08-28T10:00:00.000Z');
  assert.equal(document.saveCalls, 2);
});

test('remindDocument resolves a missing email from signerPtr', async t => {
  const { document } = reminderDocument({
    AuditTrail: [],
    Placeholders: [
      {
        signerObjId: 'contact-pending',
        signerPtr: { objectId: 'contact-pending' },
      },
    ],
  });
  installParseMock(t, document, {
    'contact-pending': parseObject('contact-pending', {
      Email: 'resolved@example.test',
      Name: 'Resolved signer',
    }),
  });
  const recipients = [];
  const remindDocument = createRemindDocument({
    now: () => new Date('2026-08-10T10:00:00Z'),
    createIdempotencyKey: () => 'contact-1',
    sendmail: async message => {
      recipients.push(message.params.recipient);
      return { status: 'success' };
    },
  });

  await remindDocument({
    master: true,
    params: { documentId: 'doc-existing', publicUrl: 'https://sign.example.test' },
    headers: {},
    user: null,
  });
  assert.deepEqual(recipients, ['resolved@example.test']);
});

test('ordered reminders never skip an unresolved first pending signer', async t => {
  const { document } = reminderDocument({
    AuditTrail: [],
    SendinOrder: true,
    Placeholders: [
      { signerObjId: 'missing-contact' },
      { email: 'second@example.test', signerObjId: 'contact-second' },
    ],
  });
  installParseMock(t, document);
  let sendCount = 0;
  const remindDocument = createRemindDocument({
    sendmail: async () => {
      sendCount += 1;
      return { status: 'success' };
    },
  });

  await assert.rejects(
    remindDocument({
      master: true,
      params: { documentId: 'doc-existing', publicUrl: 'https://sign.example.test' },
      headers: {},
      user: null,
    }),
    /Pending signer email not found/
  );
  assert.equal(sendCount, 0);
});

test('unordered reminders fail instead of silently skipping an unresolved signer', async t => {
  const { document } = reminderDocument({
    AuditTrail: [],
    Placeholders: [
      { email: 'first@example.test', signerObjId: 'contact-first' },
      { signerObjId: 'missing-contact' },
    ],
  });
  installParseMock(t, document);
  let sendCount = 0;
  const remindDocument = createRemindDocument({
    sendmail: async () => {
      sendCount += 1;
      return { status: 'success' };
    },
  });

  await assert.rejects(
    remindDocument({
      master: true,
      params: { documentId: 'doc-existing', publicUrl: 'https://sign.example.test' },
      headers: {},
      user: null,
    }),
    /Pending signer email not found/
  );
  assert.equal(sendCount, 0);
});

test('a partial reminder retry skips recipients already delivered for the same key', async t => {
  const { document } = reminderDocument({
    AuditTrail: [],
    Placeholders: [
      { email: 'first@example.test', signerObjId: 'contact-first' },
      { email: 'second@example.test', signerObjId: 'contact-second' },
    ],
  });
  installParseMock(t, document);
  const firstAttempt = [];
  const failingReminder = createRemindDocument({
    now: () => new Date('2026-08-10T10:00:00Z'),
    sendmail: async message => {
      firstAttempt.push(message.params.recipient);
      return message.params.recipient === 'second@example.test'
        ? { status: 'error' }
        : { status: 'success' };
    },
  });

  await assert.rejects(
    failingReminder({
      master: true,
      params: {
        documentId: 'doc-existing',
        publicUrl: 'https://sign.example.test',
        idempotencyKey: 'retry-1',
      },
      headers: {},
      user: null,
    }),
    /Reminder email failed/
  );
  assert.deepEqual(firstAttempt, ['first@example.test', 'second@example.test']);

  const retryRecipients = [];
  const retryReminder = createRemindDocument({
    now: () => new Date('2026-08-10T10:01:00Z'),
    sendmail: async message => {
      retryRecipients.push(message.params.recipient);
      return { status: 'success' };
    },
  });
  const result = await retryReminder({
    master: true,
    params: {
      documentId: 'doc-existing',
      publicUrl: 'https://sign.example.test',
      idempotencyKey: 'retry-1',
    },
    headers: {},
    user: null,
  });

  assert.deepEqual(retryRecipients, ['second@example.test']);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 1);
});

test('remindDocument rejects access from a different document owner', async t => {
  const { document } = reminderDocument();
  installParseMock(t, document);
  let sendCount = 0;
  const remindDocument = createRemindDocument({
    sendmail: async () => {
      sendCount += 1;
      return { status: 'success' };
    },
  });

  await assert.rejects(
    remindDocument({
      master: false,
      params: {
        documentId: 'doc-existing',
        publicUrl: 'https://sign.example.test',
      },
      headers: {},
      user: parseObject('different-user'),
    }),
    error => error.code === global.Parse.Error.OPERATION_FORBIDDEN
  );
  assert.equal(sendCount, 0);
});

test('completed status is not disclosed before document authorization', async t => {
  const { document } = reminderDocument({ IsCompleted: true });
  installParseMock(t, document);
  const remindDocument = createRemindDocument();

  await assert.rejects(
    remindDocument({
      master: false,
      params: { documentId: 'doc-existing', publicUrl: 'https://sign.example.test' },
      headers: {},
      user: parseObject('different-user'),
    }),
    error =>
      error.code === global.Parse.Error.OPERATION_FORBIDDEN &&
      error.message === 'Document access denied'
  );
});

test('remindDocument never emails completed documents', async t => {
  const { document } = reminderDocument({ IsCompleted: true });
  installParseMock(t, document);
  let sendCount = 0;
  const remindDocument = createRemindDocument({
    sendmail: async () => {
      sendCount += 1;
      return { status: 'success' };
    },
  });

  await assert.rejects(
    remindDocument({
      master: true,
      params: {
        documentId: 'doc-existing',
        publicUrl: 'https://sign.example.test',
      },
      headers: {},
      user: null,
    }),
    error => error.code === global.Parse.Error.VALIDATION_ERROR
  );
  assert.equal(sendCount, 0);
});

test('remindDocument surfaces mail provider failures', async t => {
  const { document } = reminderDocument({ AuditTrail: [] });
  installParseMock(t, document);
  const remindDocument = createRemindDocument({
    sendmail: async () => ({ status: 'error' }),
  });

  await assert.rejects(
    remindDocument({
      master: true,
      params: {
        documentId: 'doc-existing',
        publicUrl: 'https://sign.example.test',
      },
      headers: {},
      user: null,
    }),
    error => error.code === global.Parse.Error.INTERNAL_SERVER_ERROR
  );
});
