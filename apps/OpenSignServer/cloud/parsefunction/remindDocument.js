import sendmailv3 from './sendMailv3.js';
import { appName, mailTemplate, replaceMailVaribles } from '../../Utils.js';
import {
  buildSigningUrl,
  isSignerAlreadySigned,
  normalizePublicUrl,
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

export function createRemindDocument({ sendmail = sendmailv3 } = {}) {
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

    if (document.get('IsCompleted')) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Document is already completed');
    }
    if (document.get('IsDeclined')) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Document was declined');
    }

    const documentCreator = document.get('CreatedBy');
    if (!request.master && (!request.user || request.user.id !== documentCreator?.id)) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Document access denied');
    }
    const actingUser = request.user || documentCreator;
    if (!actingUser) {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Document creator not found');
    }

    const publicUrl = params.publicUrl || request.headers?.public_url || process.env.PUBLIC_URL;
    const hostUrl = normalizePublicUrl(publicUrl);
    const extUser = document.get('ExtUserPtr');
    const extUserData = extUser?.toJSON?.() || {};
    const tenantData = extUserData?.TenantId || {};
    const senderName =
      process.env.SMTP_FROM_NAME || actingUser.get('Name') || actingUser.get('username') || appName;
    const senderEmail = actingUser.get('Email') || actingUser.get('email') || '';
    const expiryDate = getExpiryDate(document).toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const auditTrail = document.get('AuditTrail') || [];
    let signers = document.get('Placeholders') || [];
    signers = signers.filter(signer => signer?.email && !isSignerAlreadySigned(auditTrail, signer));
    if (document.get('SendinOrder')) {
      signers = signers.slice(0, 1);
    }
    if (!signers.length) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'No pending signers found');
    }

    let sent = 0;
    for (const signer of signers) {
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
    }

    return {
      status: 'success',
      message: 'reminder_sent',
      objectId: document.id,
      sent,
    };
  };
}

const remindDocument = createRemindDocument();

export default remindDocument;
