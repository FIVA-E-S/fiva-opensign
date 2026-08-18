import { MongoClient } from 'mongodb';

const clientKey = Symbol.for('fiva.opensign.durableMongoClient');

export async function getDurableDatabase() {
  if (!globalThis[clientKey]) {
    const uri =
      process.env.DATABASE_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/dev';
    const client = new MongoClient(uri);
    globalThis[clientKey] = client.connect().then(() => client);
  }
  const client = await globalThis[clientKey];
  return client.db();
}

export function findOneAndUpdateValue(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, 'value')) {
    return result.value;
  }
  return result || null;
}
