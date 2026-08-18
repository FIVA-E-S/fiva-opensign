export function normalizePublicUrl(value) {
  if (!value) {
    throw new Error('Missing public URL');
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Public URL must use HTTP or HTTPS');
  }
  return url.origin;
}

export function buildSigningUrl(publicUrl, documentId, signer) {
  const hostUrl = normalizePublicUrl(publicUrl);
  if (signer?.signerObjId) {
    return `${hostUrl}/load/recipientSignPdf/${documentId}/${signer.signerObjId}`;
  }
  if (!signer?.email) {
    throw new Error('Signer email is required');
  }
  const encoded = Buffer.from(`${documentId}/${signer.email}`).toString('base64');
  return `${hostUrl}/login/${encoded}`;
}

export function isSignerAlreadySigned(auditTrail, signer) {
  const objectId = value => value?.objectId || value?.id || value?.toJSON?.()?.objectId;
  const email = value =>
    value?.Email || value?.email || value?.get?.('Email') || value?.get?.('email');
  const signerObjectId = signer?.signerObjId || objectId(signer?.signerPtr);
  return (auditTrail || []).some(entry => {
    if (entry?.Activity?.toLowerCase() !== 'signed') return false;
    const auditObjectId = objectId(entry?.UserPtr);
    const auditEmail = email(entry?.UserPtr) || email(entry);
    return (
      (signerObjectId && auditObjectId === signerObjectId) ||
      (signer?.email && auditEmail?.toLowerCase() === signer.email.toLowerCase())
    );
  });
}

export function signerIdentity(signer) {
  const pointerId =
    signer?.signerObjId ||
    signer?.signerPtr?.objectId ||
    signer?.signerPtr?.id ||
    signer?.signerPtr?.toJSON?.()?.objectId;
  if (pointerId) return `contact:${pointerId}`;
  if (signer?.email) return `email:${signer.email.toLowerCase()}`;
  return '';
}

export function wasReminderDelivered(deliveries, idempotencyKey, signer) {
  const identity = signerIdentity(signer);
  if (!identity || !idempotencyKey) return false;
  return (deliveries || []).some(
    delivery => delivery?.idempotencyKey === idempotencyKey && delivery?.signerIdentity === identity
  );
}
