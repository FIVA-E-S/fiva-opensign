import { createHash, randomUUID } from 'node:crypto';

import { signerIdentity } from './remindDocument.helpers.js';
import { findOneAndUpdateValue, getDurableDatabase } from './durableMongo.js';

const DELIVERY_CLASS = 'contracts_ReminderDelivery';
const DELIVERY_LEASE_MS = 120000;

export function reminderDeliveryKey(documentId, idempotencyKey, signer) {
  return createHash('sha256')
    .update(`${documentId}:${idempotencyKey}:${signerIdentity(signer)}`)
    .digest('hex');
}

async function deliveryCollection(collection) {
  if (collection) return collection;
  const database = await getDurableDatabase();
  return database.collection(DELIVERY_CLASS);
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

export async function reserveReminderDelivery(
  document,
  idempotencyKey,
  signer,
  { collection, now = () => new Date(), createOwnerToken = randomUUID } = {}
) {
  const identity = signerIdentity(signer);
  if (!identity || !idempotencyKey) {
    throw new Error('Reminder delivery requires signer identity and idempotency key');
  }

  const deliveries = await deliveryCollection(collection);
  const currentTime = now();
  const leaseOwner = createOwnerToken();
  const leaseUntil = new Date(currentTime.getTime() + DELIVERY_LEASE_MS);
  const deliveryKey = reminderDeliveryKey(document.id, idempotencyKey, signer);
  const claimFilter = {
    DeliveryKey: deliveryKey,
    $or: [
      { Status: { $in: ['pending', 'failed'] } },
      { Status: 'sending', LeaseUntil: { $lte: currentTime } },
    ],
  };
  const claimUpdate = {
    $set: {
      Status: 'sending',
      LeaseOwner: leaseOwner,
      LeaseUntil: leaseUntil,
      LastAttemptAt: currentTime,
      _updated_at: currentTime,
    },
    $inc: { Attempts: 1 },
  };

  let claimed = findOneAndUpdateValue(
    await deliveries.findOneAndUpdate(claimFilter, claimUpdate, {
      returnDocument: 'after',
    })
  );

  if (!claimed) {
    try {
      const row = {
        _id: randomUUID().replaceAll('-', '').slice(0, 10),
        DeliveryKey: deliveryKey,
        DocumentId: document.id,
        IdempotencyKey: idempotencyKey,
        SignerIdentity: identity,
        Status: 'sending',
        LeaseOwner: leaseOwner,
        LeaseUntil: leaseUntil,
        Attempts: 1,
        LastAttemptAt: currentTime,
        _created_at: currentTime,
        _updated_at: currentTime,
      };
      await deliveries.insertOne(row);
      claimed = row;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  if (claimed) {
    return {
      shouldSend: true,
      state: 'claimed',
      collection: deliveries,
      deliveryKey,
      leaseOwner,
    };
  }

  const existing = await deliveries.findOne({ DeliveryKey: deliveryKey });
  if (existing?.Status === 'delivered') {
    return { shouldSend: false, state: 'delivered', deliveryKey };
  }
  return { shouldSend: false, state: 'in_progress', deliveryKey };
}

export async function markReminderDelivered(reservation, { now = () => new Date() } = {}) {
  const currentTime = now();
  const result = await reservation.collection.updateOne(
    {
      DeliveryKey: reservation.deliveryKey,
      Status: 'sending',
      LeaseOwner: reservation.leaseOwner,
    },
    {
      $set: {
        Status: 'delivered',
        DeliveredAt: currentTime,
        _updated_at: currentTime,
      },
      $unset: { LeaseOwner: '', LeaseUntil: '', LastError: '' },
    }
  );
  if (result.matchedCount !== 1) {
    throw new Error('Reminder delivery lease was lost before completion');
  }
}

export async function releaseReminderDelivery(reservation, error, { now = () => new Date() } = {}) {
  const currentTime = now();
  await reservation.collection.updateOne(
    {
      DeliveryKey: reservation.deliveryKey,
      Status: 'sending',
      LeaseOwner: reservation.leaseOwner,
    },
    {
      $set: {
        Status: 'failed',
        LastError: String(error?.message || error || 'Reminder email failed').slice(0, 1000),
        _updated_at: currentTime,
      },
      $unset: { LeaseOwner: '', LeaseUntil: '' },
    }
  );
}
