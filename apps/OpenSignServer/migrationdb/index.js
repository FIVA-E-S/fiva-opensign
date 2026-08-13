import createContactIndex from './createContactIndex.js';
import createDocumentIndex from './createDocumentIndex.js';
import createOpenSignSafetyIndexes from './createOpenSignSafetyIndexes.js';

export default async function runDbMigrations() {
  await createContactIndex();
  await createDocumentIndex();
  await createOpenSignSafetyIndexes();
}
