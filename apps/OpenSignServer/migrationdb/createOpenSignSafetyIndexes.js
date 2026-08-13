import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

import { generateId } from '../Utils.js';

dotenv.config({ quiet: true });

export default async function createOpenSignSafetyIndexes() {
  const client = new MongoClient(
    process.env.DATABASE_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/dev'
  );
  try {
    await client.connect();
    const database = client.db();
    const migrations = database.collection('Migrationdb');
    const migrationName = 'opensignSafetyIndexes_1';
    if (await migrations.findOne({ name: migrationName })) return;

    await database.collection('contracts_Document').createIndex(
      { _p_CreatedBy: 1, FivaIdempotencyKey: 1 },
      {
        name: 'uniq_fiva_document_idempotency',
        unique: true,
        partialFilterExpression: { FivaIdempotencyKey: { $type: 'string' } },
      }
    );
    await database.collection('contracts_WebhookOutbox').createIndex(
      { DeliveryKey: 1 },
      { name: 'uniq_webhook_delivery_key', unique: true }
    );
    await database.collection('contracts_WebhookOutbox').createIndex(
      { Status: 1, NextAttemptAt: 1 },
      { name: 'idx_webhook_outbox_due' }
    );
    await database.collection('contracts_ReminderDelivery').createIndex(
      { DeliveryKey: 1 },
      { name: 'uniq_reminder_delivery_key', unique: true }
    );

    await migrations.insertOne({
      _id: generateId(10),
      name: migrationName,
      _created_at: new Date(),
      _updated_at: new Date(),
      executedAt: new Date(),
      details: 'Created idempotency, webhook outbox and reminder delivery indexes',
    });
  } catch (error) {
    console.error('ERROR running OpenSign safety index migration:', error);
    throw error;
  } finally {
    await client.close();
  }
}
