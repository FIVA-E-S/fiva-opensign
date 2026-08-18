import crypto from 'node:crypto';
import axios from 'axios';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 10000;

export function buildWebhookSignature(body, timestamp, secret) {
  if (!secret) {
    throw new Error('OPENSIGN_WEBHOOK_SECRET is required');
  }
  return `sha256=${crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

function shouldRetry(error) {
  const status = error?.response?.status;
  return !status || status === 408 || status === 429 || status >= 500;
}

export async function postSignedWebhook(
  webhookUrl,
  payload,
  {
    httpClient = axios,
    secret = process.env.OPENSIGN_WEBHOOK_SECRET,
    now = () => Date.now(),
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = {}
) {
  if (!webhookUrl) return null;

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(now() / 1000).toString();
  const signature = buildWebhookSignature(body, timestamp, secret);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await httpClient.post(webhookUrl, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-OpenSign-Timestamp': timestamp,
          'X-OpenSign-Signature': signature,
        },
        timeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !shouldRetry(error)) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(250 * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}
