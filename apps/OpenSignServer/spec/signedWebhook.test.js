import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { buildWebhookSignature, postSignedWebhook } from '../cloud/parsefunction/signedWebhook.js';

test('buildWebhookSignature signs timestamp and exact request body', () => {
  const body = JSON.stringify({ event: 'completed', document_id: 'doc-1' });
  const expected = `sha256=${crypto
    .createHmac('sha256', 'shared-secret')
    .update(`1723543200.${body}`)
    .digest('hex')}`;
  assert.equal(buildWebhookSignature(body, '1723543200', 'shared-secret'), expected);
});

test('postSignedWebhook sends the serialized body and signature headers', async () => {
  const calls = [];
  const httpClient = {
    async post(...args) {
      calls.push(args);
      return { status: 200 };
    },
  };
  const payload = { event: 'viewed', document_id: 'doc-1' };

  await postSignedWebhook('https://back.example.test/webhook', payload, {
    httpClient,
    secret: 'shared-secret',
    now: () => 1723543200000,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], JSON.stringify(payload));
  assert.equal(calls[0][2].headers['X-OpenSign-Timestamp'], '1723543200');
  assert.match(calls[0][2].headers['X-OpenSign-Signature'], /^sha256=[a-f0-9]{64}$/);
});

test('postSignedWebhook retries transient failures without changing the signature', async () => {
  const calls = [];
  const httpClient = {
    async post(...args) {
      calls.push(args);
      if (calls.length === 1) {
        const error = new Error('temporary');
        error.response = { status: 503 };
        throw error;
      }
      return { status: 200 };
    },
  };

  await postSignedWebhook(
    'https://back.example.test/webhook',
    { event: 'completed', document_id: 'doc-1' },
    {
      httpClient,
      secret: 'shared-secret',
      now: () => 1723543200000,
      sleep: async () => {},
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0][2].headers['X-OpenSign-Signature'],
    calls[1][2].headers['X-OpenSign-Signature']
  );
});

test('postSignedWebhook does not retry authentication failures', async () => {
  let calls = 0;
  const httpClient = {
    async post() {
      calls += 1;
      const error = new Error('forbidden');
      error.response = { status: 403 };
      throw error;
    },
  };

  await assert.rejects(
    postSignedWebhook(
      'https://back.example.test/webhook',
      { event: 'viewed' },
      {
        httpClient,
        secret: 'shared-secret',
        sleep: async () => {},
      }
    ),
    /forbidden/
  );
  assert.equal(calls, 1);
});
