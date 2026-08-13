import sendmailv3 from './sendMailv3.js';
import { randomUUID } from 'node:crypto';
import { appName, mailTemplate, replaceMailVaribles } from '../../Utils.js';
import {
  buildSigningUrl,
  isSignerAlreadySigned,
  normalizePublicUrl,
  signerIdentity,
  wasReminderDelivered,
} from './remindDocument.helpers.js';

function getExpiryDate(document) {
  const explicitExpiry = document.get('ExpiryDate');
  if (explicitExpiry) {
    return new Date(explicitExpiry.iso || explicitExpiry);
  }
  const expiry = new Date(document.createdAt);
  expiry.setDate(expiry.getDate() + (document.get('TimeToCompleteDays') || 15));
  return expiry;
}

async function resolveSignerContact(signer) {
  if (signer?.email) return signer;
  const contactId = signer?.signerObjId || signer?.signerPtr?.objectId || signer?.signerPtr?.id;
  if (!contactId) return signer;

  try {
    const contactQuery = new Parse.Query('contracts_Contactbook');
    const contact = await contactQuery.get(contactId, { useMasterKey: true });
    return {
      ...signer,
      email: contact.get('Email') || contact.get('email') || '',
      Name: signer?.Name || signer?.name || contact.get('Name') || contact.get('name') || '',
      Phone: signer?.Phone || contact.get('Phone') || '',
      signerObjId: signer?.signerObjId || contactId,
    };
  } catch {
    return signer;
  }
}

async function ensureUsableExpiry(document, now) {
  const currentExpiry = getExpiryDate(document);
  if (currentExpiry.getTime() > now.getTime()) return currentExpiry;

  const days = Number(document.get('TimeToCompleteDays')) || 15;
  const renewedExpiry = new Date(now);
  renewedExpiry.setDate(renewedExpiry.getDate() + days);
  document.set('ExpiryDate', renewedExpiry);
  await document.save(null, { useMasterKey: true });
  return renewedExpiry;
}

export function createRemindDocument({
  sendmail = sendmailv3,
  now = () => new Date(),
  createIdempotencyKey = randomUUID,
} = {}) {
  return async function remindDocument(request) {
    const params = request.params || {};
    const documentId = params.documentId;
    if (!documentId) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing documentId');
    }

    const query = new Parse.Query('contracts_Document');
    query.include('CreatedBy');
    query.include('ExtUserPtr');
    query.include('ExtUserPtr.TenantId');
    const document = await query.get(documentId, { useMasterKey: true });

    const documentCreator = document.get('CreatedBy');
    if (!request.master && (!request.user || request.user.id !== documentCreator?.id)) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Document access denied');
    }
    const actingUser = request.user || documentCreator;
    if (!actingUser) {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Document creator not found');
    }
    if (document.get('IsCompleted')) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Document is already completed');
    }
    if (document.get('IsDeclined')) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Document was declined');
    }

    const publicUrl = params.publicUrl || request.headers?.public_url || process.env.PUBLIC_URL;
    const hostUrl = normalizePublicUrl(publicUrl);
    const extUser = document.get('ExtUserPtr');
    const extUserData = extUser?.toJSON?.() || {};
    const tenantData = extUserData?.TenantId || {};
    const senderName =
      process.env.SMTP_FROM_NAME || actingUser.get('Name') || actingUser.get('username') || appName;
    const senderEmail = actingUser.get('Email') || actingUser.get('email') || '';
    const usableExpiry = await ensureUsableExpiry(document, now());
    const expiryDate = usableExpiry.toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const auditTrail = document.get('AuditTrail') || [];
    const pendingSigners = (document.get('Placeholders') || []).filter(
      signer => !isSignerAlreadySigned(auditTrail, signer)
    );
    let signers;
    if (document.get('SendinOrder')) {
      const firstPending = pendingSigners[0];
      signers = firstPending ? [await resolveSignerContact(firstPending)] : [];
      if (signers.length && !signers[0]?.email) {
        throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Pending signer email not found');
      }
    } else {
      signers = await Promise.all(pendingSigners.map(resolveSignerContact));
      if (signers.some(signer => !signer?.email)) {
        throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Pending signer email not found');
      }
    }
    if (!signers.length) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'No pending signers found');
    }

    const idempotencyKey = params.idempotencyKey || createIdempotencyKey();
    const deliveries = [...(document.get('ReminderDeliveries') || [])];
    let sent = 0;
    let skipped = 0;
    for (const signer of signers) {
      if (wasReminderDelivered(deliveries, idempotencyKey, signer)) {
        skipped += 1;
        continue;
      }
      const signingUrl = buildSigningUrl(hostUrl, document.id, signer);
      const variables = {
        document_title: document.get('Name'),
        note: document.get('Note') || '',
        sender_name: senderName,
        sender_mail: senderEmail,
        sender_phone: extUserData?.Phone || '',
        receiver_name: signer?.Name || signer?.name || signer.email,
        receiver_email: signer.email,
        receiver_phone: signer?.Phone || '',
        expiry_date: expiryDate,
        company_name: extUserData?.Company || '',
        signing_url: signingUrl,
      };
      const mailParams = {
        senderName,
        note: variables.note,
        senderMail: senderEmail,
        title: variables.document_title,
        organization: variables.company_name,
        localExpireDate: expiryDate,
        signingUrl,
      };
      const configuredSubject =
        params.emailSubject || document.get('RequestSubject') || tenantData?.RequestSubject;
      const configuredBody =
        params.emailBody || document.get('RequestBody') || tenantData?.RequestBody;

      let subject;
      let html;
      if (configuredBody) {
        const fallbackSubject =
          configuredSubject || `${senderName} has requested you to sign "${document.get('Name')}"`;
        const wrappedBody = configuredBody.includes('<html>')
          ? configuredBody
          : `<html><head><meta http-equiv='Content-Type' content='text/html; charset=UTF-8' /></head><body>${configuredBody}</body></html>`;
        const replaced = replaceMailVaribles(fallbackSubject, wrappedBody, variables);
        subject = replaced.subject;
        html = replaced.body;
      } else {
        const generated = mailTemplate(mailParams);
        subject = generated.subject;
        html = generated.body;
      }

      // Keep delivery sequential so ordered-signature documents never notify
      // a later recipient before the current one.
      // eslint-disable-next-line no-await-in-loop
      const result = await sendmail({
        params: {
          recipient: signer.email,
          subject,
          from: senderName,
          replyto: senderEmail,
          html,
          extUserId: extUser?.id || actingUser.id,
        },
        user: actingUser,
      });
      if (result?.status !== 'success') {
        throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Reminder email failed');
      }
      sent += 1;
      deliveries.push({
        idempotencyKey,
        signerIdentity: signerIdentity(signer),
        sentAt: now().toISOString(),
      });
      document.set('ReminderDeliveries', deliveries.slice(-100));
      // Persist after every recipient so retries never duplicate successful deliveries.
      // eslint-disable-next-line no-await-in-loop
      await document.save(null, { useMasterKey: true });
    }

    return {
      status: 'success',
      message: 'reminder_sent',
      objectId: document.id,
      sent,
      skipped,
      idempotencyKey,
    };
  };
}

const remindDocument = createRemindDocument();

export default remindDocument;
