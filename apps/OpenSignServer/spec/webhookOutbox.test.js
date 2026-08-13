import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDurableWebhookEvent,
  claimNextWebhookOutboxEntry,
  flushDocumentWebhookEvents,
  processWebhookOutboxBatch,
  reconcileDocumentWebhookEvents,
  webhookDeliveryKey,
  webhookRetryDelayMs,
} from '../cloud/parsefunction/webhookOutbox.js';

function valueAt(row, key) {
  if (!key.includes('.')) return row[key];
  const [first, ...rest] = key.split('.');
  const value = row[first];
  if (Array.isArray(value)) return value.map(item => valueAt(item, rest.join('.')));
  return valueAt(value || {}, rest.join('.'));
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(clause => matches(row, clause));
    const actual = valueAt(row, key);
    if (Array.isArray(actual)) return actual.some(value => matches({ value }, { value: expected }));
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(actual);
      if ('$lte' in expected) return actual <= expected.$lte;
    }
    return actual === expected;
  });
}

function applyUpdate(row, update, options = {}) {
  Object.assign(row, update.$setOnInsert || {}, update.$set || {});
  for (const [key, amount] of Object.entries(update.$inc || {})) {
    row[key] = Number(row[key] || 0) + amount;
  }
  for (const key of Object.keys(update.$unset || {})) delete row[key];

  for (const [key, value] of Object.entries(update.$set || {})) {
    if (!key.includes('.$[event].')) continue;
    const [arrayKey, childKey] = key.split('.$[event].');
    const eventFilter = options.arrayFilters?.[0] || {};
    for (const event of row[arrayKey] || []) {
      const normalizedFilter = Object.fromEntries(
        Object.entries(eventFilter).map(([filterKey, expected]) => [
          filterKey.replace(/^event\./, ''),
          expected,
        ])
      );
      if (matches(event, normalizedFilter)) event[childKey] = value;
    }
    delete row[key];
  }
}

function createCollection(initialRows = []) {
  const rows = initialRows.map(row => structuredClone(row));
  return {
    rows,
    find(filter) {
      const matchesFilter = rows.filter(row => matches(row, filter));
      return {
        limit(limit) {
          return {
            async toArray() {
              return matchesFilter.slice(0, limit).map(row => structuredClone(row));
            },
          };
        },
      };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      const candidates = rows.filter(row => matches(row, filter));
      if (options.sort?.NextAttemptAt) {
        candidates.sort(
          (left, right) => new Date(left.NextAttemptAt) - new Date(right.NextAttemptAt)
        );
      }
      const row = candidates[0];
      if (!row) return { value: null };
      applyUpdate(row, update, options);
      return { value: structuredClone(row) };
    },
    async updateOne(filter, update, options = {}) {
      let row = rows.find(candidate => matches(candidate, filter));
      if (!row && options.upsert) {
        row = {};
        rows.push(row);
        applyUpdate(row, { $set: filter });
      }
      if (!row) return { matchedCount: 0, upsertedCount: 0 };
      const inserted = !row._id;
      applyUpdate(row, update, options);
      return { matchedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
    },
  };
}

function createDatabase({ documents = [], outbox = [] } = {}) {
  const collections = {
    contracts_Document: createCollection(documents),
    contracts_WebhookOutbox: createCollection(outbox),
  };
  return {
    collections,
    collection(name) {
      return collections[name];
    },
  };
}

test('webhook delivery keys deduplicate the same document event', () => {
  const payload = {
    event: 'completed',
    document_id: 'doc-1',
    signer_id: 'signer-1',
  };
  assert.equal(webhookDeliveryKey(payload), webhookDeliveryKey({ ...payload }));
  assert.notEqual(
    webhookDeliveryKey(payload),
    webhookDeliveryKey({ ...payload, event: 'declined' })
  );
});

test('a document marker is reconciled into the durable outbox', async () => {
  const event = buildDurableWebhookEvent(
    'https://back.example.test/webhook',
    { event: 'viewed', document_id: 'doc-1', contact_id: 'contact-1' },
    { now: () => new Date('2026-08-13T10:00:00Z') }
  );
  const database = createDatabase({
    documents: [{ _id: 'doc-1', FivaWebhookEvents: [event] }],
  });

  const reconciled = await reconcileDocumentWebhookEvents({
    database,
    now: () => new Date('2026-08-13T10:01:00Z'),
  });

  assert.equal(reconciled, 1);
  assert.equal(database.collections.contracts_WebhookOutbox.rows.length, 1);
  assert.equal(database.collections.contracts_WebhookOutbox.rows[0].DeliveryKey, event.DeliveryKey);
  assert.equal(
    database.collections.contracts_Document.rows[0].FivaWebhookEvents[0].Status,
    'queued'
  );
});

test('only one concurrent worker can claim an outbox entry', async () => {
  const current = new Date('2026-08-13T10:00:00Z');
  const outbox = createCollection([
    {
      _id: 'outbox-1',
      Status: 'pending',
      Attempts: 0,
      NextAttemptAt: current,
    },
  ]);

  const claims = await Promise.all([
    claimNextWebhookOutboxEntry(outbox, {
      now: () => current,
      createOwnerToken: () => 'worker-1',
    }),
    claimNextWebhookOutboxEntry(outbox, {
      now: () => current,
      createOwnerToken: () => 'worker-2',
    }),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(outbox.rows[0].Attempts, 1);
});

test('two concurrent workers publish a claimed webhook only once', async () => {
  const current = new Date('2026-08-13T10:00:00Z');
  const database = createDatabase({
    outbox: [
      {
        _id: 'outbox-1',
        Status: 'pending',
        Attempts: 0,
        NextAttemptAt: current,
        WebhookUrl: 'https://back.example.test/webhook',
        Payload: { event: 'completed', document_id: 'doc-1' },
      },
    ],
  });
  let posts = 0;
  const postWebhook = async () => {
    posts += 1;
  };

  await Promise.all([
    processWebhookOutboxBatch({ database, postWebhook, now: () => current, limit: 1 }),
    processWebhookOutboxBatch({ database, postWebhook, now: () => current, limit: 1 }),
  ]);

  assert.equal(posts, 1);
  assert.equal(database.collections.contracts_WebhookOutbox.rows[0].Status, 'delivered');
});

test('failed webhook delivery remains pending for a durable retry', async () => {
  const current = new Date('2026-08-13T10:00:00Z');
  const database = createDatabase({
    outbox: [
      {
        _id: 'outbox-1',
        Status: 'pending',
        Attempts: 0,
        NextAttemptAt: current,
        WebhookUrl: 'https://back.example.test/webhook',
        Payload: { event: 'completed', document_id: 'doc-1' },
      },
    ],
  });

  await processWebhookOutboxBatch({
    database,
    now: () => current,
    limit: 1,
    postWebhook: async () => {
      throw new Error('backend unavailable');
    },
  });

  const entry = database.collections.contracts_WebhookOutbox.rows[0];
  assert.equal(entry.Status, 'pending');
  assert.equal(entry.Attempts, 1);
  assert.equal(entry.LastError, 'backend unavailable');
  assert.equal(
    entry.NextAttemptAt.toISOString(),
    new Date(current.getTime() + webhookRetryDelayMs(1)).toISOString()
  );
});

test('a crash before outbox reconciliation is recovered from the document marker', async () => {
  const event = buildDurableWebhookEvent(
    'https://back.example.test/webhook',
    { event: 'declined', document_id: 'doc-2', user_id: 'contact-2' },
    { now: () => new Date('2026-08-13T10:00:00Z') }
  );
  const database = createDatabase({
    documents: [{ _id: 'doc-2', FivaWebhookEvents: [event] }],
  });
  const delivered = [];

  await flushDocumentWebhookEvents('doc-2', {
    database,
    now: () => new Date('2026-08-13T10:01:00Z'),
    postWebhook: async (url, payload) => delivered.push({ url, payload }),
  });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.event, 'declined');
  assert.equal(database.collections.contracts_WebhookOutbox.rows[0].Status, 'delivered');
});
