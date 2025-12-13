import sendmailv3 from './sendMailv3.js';
import { mailTemplate, replaceMailVaribles } from '../../Utils.js';

export default async function createDocument(request) {
  const { templateId, signers, title } = request.params;

  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User not authenticated');
  }

  if (!templateId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing templateId');
  }

  try {
    // 1. Fetch Template
    const templateQuery = new Parse.Query('contracts_Template');
    templateQuery.equalTo('objectId', templateId);
    templateQuery.include('ExtUserPtr');
    templateQuery.include('ExtUserPtr.TenantId');
    const template = await templateQuery.first({ useMasterKey: true });

    if (!template) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Template not found');
    }

    const _template = template.toJSON();

    // 2. Prepare Document Data
    const doc = new Parse.Object('contracts_Document');

    // Copy simple fields
    doc.set('Name', title || _template.Name);
    doc.set('Description', _template.Description);
    doc.set('Note', _template.Note);
    doc.set('URL', _template.URL);
    doc.set('SignedUrl', _template.URL); // Initial state
    doc.set('ExtUserPtr', _template.ExtUserPtr); // Keep the organization/user pointer from template
    doc.set('CreatedBy', request.user); // The user calling the API is the creator
    doc.set('SendinOrder', _template.SendinOrder || false);
    doc.set('AutomaticReminders', _template.AutomaticReminders || false);
    doc.set('RemindOnceInEvery', _template.RemindOnceInEvery || 5);
    doc.set('TimeToCompleteDays', _template.TimeToCompleteDays || 15);
    doc.set('IsEnableOTP', _template.IsEnableOTP || false);
    doc.set('IsTourEnabled', _template.IsTourEnabled || false);
    doc.set('AllowModifications', _template.AllowModifications || false);
    doc.set('DocSentAt', new Date());

    // Copy complex fields if they exist
    if (_template.SignatureType) doc.set('SignatureType', _template.SignatureType);
    if (_template.NotifyOnSignatures) doc.set('NotifyOnSignatures', _template.NotifyOnSignatures);
    if (_template.Bcc) doc.set('Bcc', _template.Bcc);
    if (_template.RedirectUrl) doc.set('RedirectUrl', _template.RedirectUrl);

    // Link back to template
    const templatePtr = new Parse.Object('contracts_Template');
    templatePtr.id = templateId;
    doc.set('TemplateId', templatePtr);

    // 3. Handle Placeholders & Signers
    let placeholders = _template.Placeholders || [];

    if (signers && Array.isArray(signers)) {
      // Map input signers to placeholders
      placeholders = placeholders.map(p => {
        // Find signer by Role (case insensitive)
        const signerMatch = signers.find(s => s.role && s.role.toLowerCase() === p.Role.toLowerCase());
        if (signerMatch) {
            // Update placeholder with signer info
            return {
                ...p,
                email: signerMatch.email,
                // We preserve other placeholder properties like widget positions
            };
        }
        return p;
      });
    }
    doc.set('Placeholders', placeholders);

    // 4. Save Document
    const savedDoc = await doc.save(null, { useMasterKey: true });
    
    // 5. Send Emails
    try {
        const publicUrl = request.headers.public_url;
        if (publicUrl) {
            const baseUrl = new URL(publicUrl);
            const hostUrl = baseUrl.origin;

            let signerMail = placeholders;
            if (doc.get('SendinOrder')) {
                signerMail = signerMail.slice(0, 1); // Only first signer
            }

            // Sender Details
            const senderName = request.user.get('Name') || request.user.get('username');
            const senderEmail = request.user.get('Email') || request.user.get('email');
            const orgName = _template.ExtUserPtr?.Company || "";

            // Calculate Expiry
            const timeToCompleteDays = doc.get('TimeToCompleteDays') || 15;
            const ExpireDate = new Date(savedDoc.createdAt);
            ExpireDate.setDate(ExpireDate.getDate() + timeToCompleteDays);
            const localExpireDate = ExpireDate.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

            for (const signer of signerMail) {
                if (!signer.email) continue;

                // Construct Sign URL
                const signerObjId = signer.signerObjId || "";
                let encodeBase64;
                if (signerObjId) {
                     encodeBase64 = Buffer.from(`${savedDoc.id}/${signer.email}/${signerObjId}`).toString('base64');
                } else {
                     encodeBase64 = Buffer.from(`${savedDoc.id}/${signer.email}`).toString('base64');
                }
                
                const signPdf = `${hostUrl}/login/${encodeBase64}`;

                // Prepare Mail Params
                const mailparam = {
                    senderName: senderName,
                    note: doc.get('Note') || '',
                    senderMail: senderEmail,
                    title: doc.get('Name'),
                    organization: orgName,
                    localExpireDate: localExpireDate,
                    signingUrl: signPdf,
                };

                // Template substitution
                let subject = _template.ExtUserPtr?.TenantId?.RequestSubject;
                let body = _template.ExtUserPtr?.TenantId?.RequestBody;
                
                let finalSubject, finalBody;

                if (subject && body) {
                    const replacedRequestBody = body.replace(/"/g, "'");
                    const htmlReqBody = "<html><head><meta http-equiv='Content-Type' content='text/html; charset=UTF-8' /></head><body>" + replacedRequestBody + "</body></html>";
                    
                    const variables = {
                        document_title: doc.get('Name'),
                        note: doc.get('Note') || '',
                        sender_name: senderName,
                        sender_mail: senderEmail,
                        sender_phone: _template.ExtUserPtr?.Phone || '',
                        receiver_name: signer.Name || '', // Name might not be in placeholder
                        receiver_email: signer.email,
                        receiver_phone: signer.Phone || '',
                        expiry_date: localExpireDate,
                        company_name: orgName,
                        signing_url: signPdf,
                    };
                    const replaceVar = replaceMailVaribles(subject, htmlReqBody, variables);
                    finalSubject = replaceVar.subject;
                    finalBody = replaceVar.body;
                } else {
                    const templateRes = mailTemplate(mailparam);
                    finalSubject = templateRes.subject;
                    finalBody = templateRes.body;
                }
                
                const params = {
                    recipient: signer.email,
                    subject: finalSubject,
                    from: senderEmail,
                    replyto: senderEmail,
                    html: finalBody,
                    extUserId: request.user.id
                };

                // Call sendmailv3
                await sendmailv3({ params: params, user: request.user });
            }
        } else {
            console.log("Skipping email: public_url header missing");
        }
    } catch (e) {
        console.error("Error sending email:", e);
        // We do not throw here to avoid rolling back the document creation, 
        // or we could throw if email is critical. 
        // For now, let's log it.
    }

    // 6. Return result
    return {
        status: "success",
        objectId: savedDoc.id,
        data: savedDoc.toJSON()
    };

  } catch (err) {
    console.error('Error in createDocument:', err);
    throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Failed to create document: ' + err.message);
  }
}
