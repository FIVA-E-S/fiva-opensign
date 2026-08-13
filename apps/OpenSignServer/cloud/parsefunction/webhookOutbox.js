import crypto from 'node:crypto';

import { postSignedWebhook } from './signedWebhook.js';

const OUTBOX_CLASS = 'contracts_WebhookOutbox';
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INTERVAL_MS = 30000;
const DELIVERY_LEASE_MS = 120000;

const asDate = value => (value instanceof Date ? value : value ? new Date(value) : null);

export function webhookDeliveryKey(payload) {
  const identity =
    payload?.signer_id || payload?.contact_id || payload?.user_id || payload?.reason || '';
  return crypto
    .createHash('sha256')
    .update(`${payload?.document_id || ''}:${payload?.event || payload?.status || ''}:${identity}`)
    .digest('hex');
}

export function webhookRetryDelayMs(attempts) {
  return Math.min(30000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

function errorMessage(error) {
  return String(error?.message || error || 'Unknown webhook delivery error').slice(0, 1000);
}

export async function deliverWebhookOutboxEntry(
  entry,
  { postWebhook = postSignedWebhook, now = () => new Date() } = {}
) {
  if (typeof entry.fetch === 'function') {
    await entry.fetch({ useMasterKey: true });
  }

  const currentTime = now();
  const currentStatus = entry.get('Status');
  const nextAttemptAt = asDate(entry.get('NextAttemptAt'));
  if (currentStatus === 'delivered') return true;
  if (currentStatus === 'delivering' && nextAttemptAt && nextAttemptAt > currentTime) {
    return false;
  }

  const attempts = Number(entry.get('Attempts') || 0) + 1;
  entry.set('Status', 'delivering');
  entry.set('Attempts', attempts);
  entry.set('LastAttemptAt', currentTime);
  entry.set('NextAttemptAt', new Date(currentTime.getTime() + DELIVERY_LEASE_MS));
  await entry.save(null, { useMasterKey: true });

  try {
    await postWebhook(entry.get('WebhookUrl'), entry.get('Payload'));
    entry.set('Status', 'delivered');
    entry.set('DeliveredAt', now());
    entry.unset('NextAttemptAt');
    entry.unset('LastError');
    await entry.save(null, { useMasterKey: true });
    return true;
  } catch (error) {
    const retryAt = new Date(now().getTime() + webhookRetryDelayMs(attempts));
    entry.set('Status', 'pending');
    entry.set('NextAttemptAt', retryAt);
    entry.set('LastError', errorMessage(error));
    await entry.save(null, { useMasterKey: true });
    console.error('Webhook delivery queued for retry:', errorMessage(error));
    return false;
  }
}

async function findOutboxEntry(ParseClient, deliveryKey) {
  const query = new ParseClient.Query(OUTBOX_CLASS);
  query.equalTo('DeliveryKey', deliveryKey);
  return query.first({ useMasterKey: true });
}

export async function enqueueWebhookDelivery(
  webhookUrl,
  payload,
  {
    ParseClient = globalThis.Parse,
    deliver = deliverWebhookOutboxEntry,
    now = () => new Date(),
  } = {}
) {
  if (!webhookUrl) return null;
  if (!ParseClient) throw new Error('Parse is required for webhook outbox delivery');

  const deliveryKey = webhookDeliveryKey(payload);
  let entry = await findOutboxEntry(ParseClient, deliveryKey);
  if (!entry) {
    entry = new ParseClient.Object(OUTBOX_CLASS);
    entry.set('DeliveryKey', deliveryKey);
    entry.set('WebhookUrl', webhookUrl);
    entry.set('Payload', payload);
    entry.set('Status', 'pending');
    entry.set('Attempts', 0);
    entry.set('NextAttemptAt', now());
    if (ParseClient.ACL) entry.setACL(new ParseClient.ACL());
    try {
      await entry.save(null, { useMasterKey: true });
    } catch (error) {
      // A unique DeliveryKey index turns concurrent enqueues into one durable row.
      entry = await findOutboxEntry(ParseClient, deliveryKey);
      if (!entry) throw error;
    }
  }

  await deliver(entry, { now });
  return entry;
}

export async function processWebhookOutboxBatch(
  {
    ParseClient = globalThis.Parse,
    deliver = deliverWebhookOutboxEntry,
    now = () => new Date(),
    limit = DEFAULT_BATCH_SIZE,
  } = {}
) {
  if (!ParseClient) return 0;
  const query = new ParseClient.Query(OUTBOX_CLASS);
  query.notEqualTo('Status', 'delivered');
  query.lessThanOrEqualTo('NextAttemptAt', now());
  query.ascending('NextAttemptAt');
  query.limit(limit);
  const entries = await query.find({ useMasterKey: true });
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    await deliver(entry, { now });
  }
  return entries.length;
}

export function startWebhookOutboxWorker({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (process.env.TESTING === 'true') return null;
  const workerKey = Symbol.for('fiva.opensign.webhookOutboxWorker');
  if (globalThis[workerKey]) return globalThis[workerKey];

  const run = () => {
    processWebhookOutboxBatch().catch(error => {
      console.error('Webhook outbox worker failed:', error?.message || error);
    });
  };
  const initial = setTimeout(run, 1000);
  initial.unref?.();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  globalThis[workerKey] = timer;
  return timer;
}
