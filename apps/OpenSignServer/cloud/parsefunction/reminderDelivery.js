import crypto from 'node:crypto';

import { signerIdentity } from './remindDocument.helpers.js';

const DELIVERY_CLASS = 'contracts_ReminderDelivery';
const DELIVERY_LEASE_MS = 120000;

export function reminderDeliveryKey(documentId, idempotencyKey, signer) {
  return crypto
    .createHash('sha256')
    .update(`${documentId}:${idempotencyKey}:${signerIdentity(signer)}`)
    .digest('hex');
}

async function findDelivery(ParseClient, deliveryKey) {
  const query = new ParseClient.Query(DELIVERY_CLASS);
  query.equalTo('DeliveryKey', deliveryKey);
  return query.first({ useMasterKey: true });
}

export async function reserveReminderDelivery(
  document,
  idempotencyKey,
  signer,
  { ParseClient = globalThis.Parse, now = () => new Date() } = {}
) {
  const identity = signerIdentity(signer);
  if (!identity || !idempotencyKey) {
    throw new Error('Reminder delivery requires signer identity and idempotency key');
  }

  const deliveryKey = reminderDeliveryKey(document.id, idempotencyKey, signer);
  let delivery = await findDelivery(ParseClient, deliveryKey);
  const currentTime = now();

  if (delivery) {
    if (delivery.get('Status') === 'delivered') {
      return { shouldSend: false, delivery };
    }
    const leaseUntil = delivery.get('LeaseUntil');
    if (
      delivery.get('Status') === 'sending' &&
      leaseUntil &&
      new Date(leaseUntil) > currentTime
    ) {
      return { shouldSend: false, delivery };
    }
  } else {
    delivery = new ParseClient.Object(DELIVERY_CLASS);
    delivery.set('DeliveryKey', deliveryKey);
    delivery.set('DocumentId', document.id);
    delivery.set('IdempotencyKey', idempotencyKey);
    delivery.set('SignerIdentity', identity);
    if (ParseClient.ACL) delivery.setACL(new ParseClient.ACL());
  }

  delivery.set('Status', 'sending');
  delivery.set('LeaseUntil', new Date(currentTime.getTime() + DELIVERY_LEASE_MS));
  delivery.set('Attempts', Number(delivery.get('Attempts') || 0) + 1);
  try {
    await delivery.save(null, { useMasterKey: true });
  } catch (error) {
    // The unique DeliveryKey index decides the winner of concurrent reservations.
    const existing = await findDelivery(ParseClient, deliveryKey);
    if (!existing) throw error;
    return { shouldSend: false, delivery: existing };
  }

  return { shouldSend: true, delivery };
}

export async function markReminderDelivered(delivery, { now = () => new Date() } = {}) {
  delivery.set('Status', 'delivered');
  delivery.set('DeliveredAt', now());
  delivery.unset('LeaseUntil');
  delivery.unset('LastError');
  await delivery.save(null, { useMasterKey: true });
}

export async function releaseReminderDelivery(delivery, error) {
  delivery.set('Status', 'failed');
  delivery.set('LastError', String(error?.message || error || 'Reminder email failed').slice(0, 1000));
  delivery.unset('LeaseUntil');
  await delivery.save(null, { useMasterKey: true });
}
