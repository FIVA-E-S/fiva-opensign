import crypto from 'node:crypto';

import { postSignedWebhook } from './signedWebhook.js';
import { findOneAndUpdateValue, getDurableDatabase } from './durableMongo.js';

const OUTBOX_CLASS = 'contracts_WebhookOutbox';
const DOCUMENT_CLASS = 'contracts_Document';
const DOCUMENT_EVENTS_FIELD = 'FivaWebhookEvents';
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INTERVAL_MS = 30000;
const DELIVERY_LEASE_MS = 120000;

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

export function buildDurableWebhookEvent(webhookUrl, payload, { now = () => new Date() } = {}) {
  if (!webhookUrl) return null;
  return {
    DeliveryKey: webhookDeliveryKey(payload),
    WebhookUrl: webhookUrl,
    Payload: payload,
    Status: 'pending',
    CreatedAt: now().toISOString(),
  };
}

export function addDurableWebhookEvent(parseObject, webhookUrl, payload, options = {}) {
  const event = buildDurableWebhookEvent(webhookUrl, payload, options);
  if (event) parseObject.addUnique(DOCUMENT_EVENTS_FIELD, event);
  return event;
}

export function durableWebhookEventRestOperation(webhookUrl, payload, options = {}) {
  const event = buildDurableWebhookEvent(webhookUrl, payload, options);
  return event ? { __op: 'AddUnique', objects: [event] } : null;
}

async function collections(database) {
  const db = database || (await getDurableDatabase());
  return {
    database: db,
    documents: db.collection(DOCUMENT_CLASS),
    outbox: db.collection(OUTBOX_CLASS),
  };
}

async function upsertOutboxEntry(outbox, event, now) {
  const currentTime = now();
  await outbox.updateOne(
    { DeliveryKey: event.DeliveryKey },
    {
      $setOnInsert: {
        _id: crypto.randomUUID().replaceAll('-', '').slice(0, 10),
        DeliveryKey: event.DeliveryKey,
        WebhookUrl: event.WebhookUrl,
        Payload: event.Payload,
        Status: 'pending',
        Attempts: 0,
        NextAttemptAt: currentTime,
        _created_at: currentTime,
        _updated_at: currentTime,
      },
    },
    { upsert: true }
  );
}

export async function reconcileDocumentWebhookEvents(
  { database, documentId, limit = DEFAULT_BATCH_SIZE, now = () => new Date() } = {}
) {
  const { documents, outbox } = await collections(database);
  const filter = { [`${DOCUMENT_EVENTS_FIELD}.Status`]: 'pending' };
  if (documentId) filter._id = documentId;
  const docs = await documents
    .find(filter, { projection: { [DOCUMENT_EVENTS_FIELD]: 1 } })
    .limit(limit)
    .toArray();
  let reconciled = 0;

  for (const document of docs) {
    const pendingEvents = (document[DOCUMENT_EVENTS_FIELD] || []).filter(
      event => event?.Status === 'pending' && event?.DeliveryKey && event?.WebhookUrl
    );
    for (const event of pendingEvents) {
      // The outbox unique key makes this safe after a crash between upsert and marker update.
      // eslint-disable-next-line no-await-in-loop
      await upsertOutboxEntry(outbox, event, now);
      // eslint-disable-next-line no-await-in-loop
      await documents.updateOne(
        { _id: document._id },
        {
          $set: {
            [`${DOCUMENT_EVENTS_FIELD}.$[event].Status`]: 'queued',
            [`${DOCUMENT_EVENTS_FIELD}.$[event].QueuedAt`]: now().toISOString(),
          },
        },
        {
          arrayFilters: [
            { 'event.DeliveryKey': event.DeliveryKey, 'event.Status': 'pending' },
          ],
        }
      );
      reconciled += 1;
    }
  }
  return reconciled;
}

export async function enqueueWebhookDelivery(
  webhookUrl,
  payload,
  { database, now = () => new Date(), deliverNow = true } = {}
) {
  if (!webhookUrl) return null;
  const { outbox } = await collections(database);
  const event = buildDurableWebhookEvent(webhookUrl, payload, { now });
  await upsertOutboxEntry(outbox, event, now);
  if (deliverNow) {
    await processWebhookOutboxBatch({ database, now, limit: 1 });
  }
  return event;
}

export async function claimNextWebhookOutboxEntry(
  outbox,
  { now = () => new Date(), createOwnerToken = crypto.randomUUID } = {}
) {
  const currentTime = now();
  const leaseOwner = createOwnerToken();
  const leaseUntil = new Date(currentTime.getTime() + DELIVERY_LEASE_MS);
  const result = await outbox.findOneAndUpdate(
    {
      $or: [
        {
          Status: { $in: ['pending', 'failed'] },
          NextAttemptAt: { $lte: currentTime },
        },
        { Status: 'delivering', LeaseUntil: { $lte: currentTime } },
      ],
    },
    {
      $set: {
        Status: 'delivering',
        LeaseOwner: leaseOwner,
        LeaseUntil: leaseUntil,
        LastAttemptAt: currentTime,
        _updated_at: currentTime,
      },
      $inc: { Attempts: 1 },
    },
    { sort: { NextAttemptAt: 1 }, returnDocument: 'after' }
  );
  const entry = findOneAndUpdateValue(result);
  return entry ? { entry, leaseOwner } : null;
}

export async function deliverClaimedWebhookEntry(
  outbox,
  claim,
  { postWebhook = postSignedWebhook, now = () => new Date() } = {}
) {
  const { entry, leaseOwner } = claim;
  try {
    await postWebhook(entry.WebhookUrl, entry.Payload);
    const currentTime = now();
    const result = await outbox.updateOne(
      { _id: entry._id, Status: 'delivering', LeaseOwner: leaseOwner },
      {
        $set: { Status: 'delivered', DeliveredAt: currentTime, _updated_at: currentTime },
        $unset: { LeaseOwner: '', LeaseUntil: '', NextAttemptAt: '', LastError: '' },
      }
    );
    if (result.matchedCount !== 1) {
      throw new Error('Webhook outbox lease was lost before completion');
    }
    return true;
  } catch (error) {
    const attempts = Number(entry.Attempts || 1);
    const currentTime = now();
    await outbox.updateOne(
      { _id: entry._id, Status: 'delivering', LeaseOwner: leaseOwner },
      {
        $set: {
          Status: 'pending',
          NextAttemptAt: new Date(currentTime.getTime() + webhookRetryDelayMs(attempts)),
          LastError: errorMessage(error),
          _updated_at: currentTime,
        },
        $unset: { LeaseOwner: '', LeaseUntil: '' },
      }
    );
    console.error('Webhook delivery queued for retry:', errorMessage(error));
    return false;
  }
}

export async function processWebhookOutboxBatch(
  {
    database,
    postWebhook = postSignedWebhook,
    now = () => new Date(),
    limit = DEFAULT_BATCH_SIZE,
    createOwnerToken = crypto.randomUUID,
  } = {}
) {
  const { outbox } = await collections(database);
  let processed = 0;
  while (processed < limit) {
    // Atomic findOneAndUpdate is the only way a worker acquires a lease.
    // eslint-disable-next-line no-await-in-loop
    const claim = await claimNextWebhookOutboxEntry(outbox, { now, createOwnerToken });
    if (!claim) break;
    // eslint-disable-next-line no-await-in-loop
    await deliverClaimedWebhookEntry(outbox, claim, { postWebhook, now });
    processed += 1;
  }
  return processed;
}

export async function flushDocumentWebhookEvents(documentId, options = {}) {
  await reconcileDocumentWebhookEvents({ ...options, documentId });
  return processWebhookOutboxBatch(options);
}

export function startWebhookOutboxWorker({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (process.env.TESTING === 'true') return null;
  const workerKey = Symbol.for('fiva.opensign.webhookOutboxWorker');
  if (globalThis[workerKey]) return globalThis[workerKey];

  const run = async () => {
    await reconcileDocumentWebhookEvents();
    await processWebhookOutboxBatch();
  };
  const safeRun = () => {
    run().catch(error => {
      console.error('Webhook outbox worker failed:', error?.message || error);
    });
  };
  const initial = setTimeout(safeRun, 1000);
  initial.unref?.();
  const timer = setInterval(safeRun, intervalMs);
  timer.unref?.();
  globalThis[workerKey] = timer;
  return timer;
}
