import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliverWebhookOutboxEntry,
  webhookDeliveryKey,
  webhookRetryDelayMs,
} from '../cloud/parsefunction/webhookOutbox.js';

class FakeEntry {
  constructor(values) {
    this.values = { ...values };
    this.saveCalls = 0;
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
  }

  unset(key) {
    delete this.values[key];
  }

  async fetch() {
    return this;
  }

  async save() {
    this.saveCalls += 1;
    return this;
  }
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

test('failed webhook delivery remains pending for a durable retry', async () => {
  const entry = new FakeEntry({
    Status: 'pending',
    Attempts: 0,
    WebhookUrl: 'https://back.example.test/webhook',
    Payload: { event: 'completed', document_id: 'doc-1' },
  });
  const current = new Date('2026-08-13T10:00:00Z');

  const delivered = await deliverWebhookOutboxEntry(entry, {
    now: () => current,
    postWebhook: async () => {
      throw new Error('backend unavailable');
    },
  });

  assert.equal(delivered, false);
  assert.equal(entry.get('Status'), 'pending');
  assert.equal(entry.get('Attempts'), 1);
  assert.equal(entry.get('LastError'), 'backend unavailable');
  assert.equal(
    entry.get('NextAttemptAt').toISOString(),
    new Date(current.getTime() + webhookRetryDelayMs(1)).toISOString()
  );
});

test('a pending webhook is marked delivered after recovery', async () => {
  const entry = new FakeEntry({
    Status: 'pending',
    Attempts: 2,
    WebhookUrl: 'https://back.example.test/webhook',
    Payload: { event: 'declined', document_id: 'doc-2' },
    NextAttemptAt: new Date('2026-08-13T09:59:00Z'),
  });
  let calls = 0;

  const delivered = await deliverWebhookOutboxEntry(entry, {
    now: () => new Date('2026-08-13T10:00:00Z'),
    postWebhook: async (url, payload) => {
      calls += 1;
      assert.equal(url, 'https://back.example.test/webhook');
      assert.equal(payload.event, 'declined');
    },
  });

  assert.equal(delivered, true);
  assert.equal(calls, 1);
  assert.equal(entry.get('Status'), 'delivered');
  assert.equal(entry.get('Attempts'), 3);
  assert.equal(entry.get('NextAttemptAt'), undefined);
});

test('an active delivery lease prevents concurrent duplicate sends', async () => {
  const entry = new FakeEntry({
    Status: 'delivering',
    Attempts: 1,
    NextAttemptAt: new Date('2026-08-13T10:02:00Z'),
    WebhookUrl: 'https://back.example.test/webhook',
    Payload: { event: 'viewed', document_id: 'doc-3' },
  });
  let calls = 0;

  const delivered = await deliverWebhookOutboxEntry(entry, {
    now: () => new Date('2026-08-13T10:00:00Z'),
    postWebhook: async () => {
      calls += 1;
    },
  });

  assert.equal(delivered, false);
  assert.equal(calls, 0);
});
