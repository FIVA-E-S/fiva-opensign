import savecontact from './savecontact.js';
import { buildSigningUrl } from './remindDocument.helpers.js';
import remindDocument from './remindDocument.js';

const isPrefillPlaceholder = placeholder =>
    String(placeholder?.Role || placeholder?.role || '').toLowerCase() === 'prefill';

function documentResult(document, publicUrl, idempotentReplay = false) {
    const placeholders = document.get('Placeholders') || [];
    const firstSigner = placeholders.find(placeholder => !isPrefillPlaceholder(placeholder));
    let signingUrl = null;
    if (publicUrl && firstSigner) {
        signingUrl = buildSigningUrl(publicUrl, document.id, firstSigner);
    }
    return {
        status: 'success',
        objectId: document.id,
        signingUrl,
        data: document.toJSON(),
        placeholders,
        idempotentReplay,
    };
}

async function ensureInitialDelivery(document, request, idempotencyKey) {
    if (document.get('FivaInitialDeliveryCompletedAt')) return;
    const publicUrl = request.params.publicUrl || request.headers?.public_url;
    const result = await remindDocument({
        master: true,
        user: request.user,
        headers: request.headers || {},
        params: {
            documentId: document.id,
            publicUrl,
            emailSubject: request.params.emailSubject,
            emailBody: request.params.emailBody,
            idempotencyKey: `initial:${idempotencyKey || document.id}`,
        },
    });
    if (result?.status !== 'success') {
        throw new Error('Initial document email failed');
    }
    document.set('FivaInitialDeliveryCompletedAt', new Date());
    await document.save(null, { useMasterKey: true });
}

async function createDocumentWithDelivery(request, deliverInitial) {
    const { templateId, signers, title, webhookUrl, emailSubject, emailBody, publicUrl: paramPublicUrl, fields, idempotencyKey } = request.params;

    if (!templateId) {
        throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing templateId');
    }

    // 1. Fetch Template (moved up to allow user inference)
    const templateQuery = new Parse.Query('contracts_Template');
    templateQuery.equalTo('objectId', templateId);
    templateQuery.include('ExtUserPtr');
    templateQuery.include('ExtUserPtr.TenantId');
    templateQuery.include('CreatedBy');
    const template = await templateQuery.first({ useMasterKey: true });

    if (!template) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Template not found');
    }

    let actingUser = request.user;

    // If no user but Master Key is used, try to infer user from template
    if (!actingUser && request.master) {
        actingUser = template.get('CreatedBy');
        if (!actingUser) {
            throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Template has no creator to act as user');
        }
    } else if (!actingUser) {
        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User not authenticated');
    }

    const _template = template.toJSON();
    const normalizedIdempotencyKey = String(idempotencyKey || '').trim();
    if (normalizedIdempotencyKey) {
        const existingQuery = new Parse.Query('contracts_Document');
        existingQuery.equalTo('CreatedBy', actingUser);
        existingQuery.equalTo('FivaIdempotencyKey', normalizedIdempotencyKey);
        const existingDocument = await existingQuery.first({ useMasterKey: true });
        if (existingDocument) {
            await deliverInitial(existingDocument, request, normalizedIdempotencyKey);
            return documentResult(
                existingDocument,
                paramPublicUrl || request.headers?.public_url,
                true
            );
        }
    }

    try {
        // 2. Prepare Document Data
        const doc = new Parse.Object('contracts_Document');

        // Copy simple fields
        doc.set('Name', title || _template.Name);
        doc.set('Description', _template.Description);
        doc.set('Note', _template.Note);
        doc.set('URL', _template.URL);
        doc.set('SignedUrl', _template.URL); // Initial state
        doc.set('ExtUserPtr', _template.ExtUserPtr); // Keep the organization/user pointer from template
        doc.set('CreatedBy', actingUser); // The user calling the API is the creator
        doc.set('SendinOrder', _template.SendinOrder || false);
        doc.set('AutomaticReminders', _template.AutomaticReminders || false);
        doc.set('RemindOnceInEvery', _template.RemindOnceInEvery || 5);
        doc.set('TimeToCompleteDays', _template.TimeToCompleteDays || 15);
        doc.set('IsEnableOTP', _template.IsEnableOTP || false);
        doc.set('IsTourEnabled', _template.IsTourEnabled || false);
        doc.set('AllowModifications', _template.AllowModifications || false);
        doc.set('DocSentAt', new Date());
        if (normalizedIdempotencyKey) {
            doc.set('FivaIdempotencyKey', normalizedIdempotencyKey);
        }

        if (webhookUrl) {
            doc.set('WebhookUrl', webhookUrl);
        }

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
        let documentSigners = []; // To store the signers for the document object (contracts_Contactbook pointers)

        if (signers && Array.isArray(signers)) {
            // Map input signers to placeholders
            placeholders = await Promise.all(placeholders.map(async (p) => {
                if (isPrefillPlaceholder(p)) return p;
                // Find signer by Role (case insensitive)
                let signerMatch = signers.find(
                    s => s.role && s.role.toLowerCase() === String(p.Role || '').toLowerCase()
                );

                // Fallback: If no match found and only 1 signer provided, use it (assuming single-signer template or user intent)
                if (!signerMatch && signers.length === 1) {
                    signerMatch = signers[0];
                }

                if (signerMatch) {
                    // Ensure contact exists
                    let contactId;
                    let contactObj;

                    try {
                        // Try to create contact
                        const contactReq = {
                            params: {
                                name: signerMatch.name || "",
                                email: signerMatch.email,
                                // Add other fields if available
                            },
                            user: actingUser
                        };
                        const contactRes = await savecontact(contactReq);
                        contactId = contactRes.objectId;
                        contactObj = contactRes;
                    } catch (e) {
                        // If duplicate, fetch existing
                        const query = new Parse.Query('contracts_Contactbook');
                        query.equalTo('CreatedBy', actingUser);
                        query.notEqualTo('IsDeleted', true);
                        query.equalTo('Email', signerMatch.email);
                        const existingContact = await query.first({ useMasterKey: true });
                        if (existingContact) {
                            contactId = existingContact.id;
                            contactObj = existingContact.toJSON();
                        } else {
                            console.error("Failed to create or find contact for", signerMatch.email, e);
                            // Fallback: proceed without contact ID (link generation will fail for this signer)
                        }
                    }

                    if (contactId) {
                        // Add to document signers list if not already present
                        if (!documentSigners.find(ds => ds.objectId === contactId)) {
                            documentSigners.push({
                                __type: 'Pointer',
                                className: 'contracts_Contactbook',
                                objectId: contactId
                            });
                        }

                        return {
                            ...p,
                            email: signerMatch.email,
                            signerObjId: contactId,
                            signerPtr: {
                                __type: 'Pointer',
                                className: 'contracts_Contactbook',
                                objectId: contactId
                            }
                        };
                    } else {
                        return {
                            ...p,
                            email: signerMatch.email
                        };
                    }
                }
                return p;
            }));
        }

        // --- NEW: Map fields to placeholders (widgets) ---
        if (fields && typeof fields === 'object') {
            const fieldKeys = Object.keys(fields);
            if (fieldKeys.length > 0) {
                // Iterate over each placeholder (role/signer-group)
                placeholders = placeholders.map(ph => {
                    if (!ph.placeHolder || !Array.isArray(ph.placeHolder)) return ph;

                    // Iterate over pages in the placeholder
                    const updatedPlaceHolders = ph.placeHolder.map(page => {
                        if (!page.pos || !Array.isArray(page.pos)) return page;

                        // Iterate over widgets (pos) in the page
                        const updatedPos = page.pos.map(widget => {
                            const wName = widget.name;
                            const wOptName = widget.options?.name;
                            const wLabel = widget.options?.label || "";

                            // Find a key in 'fields' that matches any of these
                            const matchedKey = fieldKeys.find(k => {
                                return (wName === k) ||
                                    (wOptName === k) ||
                                    (wLabel === k) ||
                                    (wLabel.toUpperCase() === k.toUpperCase()); // Loose matching for labels
                            });

                            if (matchedKey) {
                                const val = fields[matchedKey];
                                const newOptions = { ...widget.options };
                                newOptions.defaultValue = val;
                                newOptions.response = val;

                                return {
                                    ...widget,
                                    options: newOptions
                                };
                            }

                            return widget;
                        });

                        return {
                            ...page,
                            pos: updatedPos
                        };
                    });

                    return {
                        ...ph,
                        placeHolder: updatedPlaceHolders
                    };
                });
            }
        }

        doc.set('Placeholders', placeholders);
        if (documentSigners.length > 0) {
            doc.set('Signers', documentSigners);
        }

        // 4. Save Document
        let savedDoc;
        try {
            savedDoc = await doc.save(null, { useMasterKey: true });
        } catch (saveError) {
            if (normalizedIdempotencyKey) {
                const existingQuery = new Parse.Query('contracts_Document');
                existingQuery.equalTo('CreatedBy', actingUser);
                existingQuery.equalTo('FivaIdempotencyKey', normalizedIdempotencyKey);
                const existingDocument = await existingQuery.first({ useMasterKey: true });
                if (existingDocument) {
                    await deliverInitial(existingDocument, request, normalizedIdempotencyKey);
                    return documentResult(
                        existingDocument,
                        paramPublicUrl || request.headers?.public_url,
                        true
                    );
                }
            }
            throw saveError;
        }

        // 5. Send initial emails through the same durable, idempotent ledger
        // used by reminders. Mail provider failures now fail the API call.
        await deliverInitial(savedDoc, request, normalizedIdempotencyKey);
        const firstSigningUrl = documentResult(
            savedDoc,
            paramPublicUrl || request.headers?.public_url
        ).signingUrl;

        // 6. Trigger Webhook (Sent) - REMOVED to avoid race condition
        // The calling server (Fiva) sets status to 'sent' upon receiving the response.
        /*
        if (webhookUrl) {
            try {
                await axios.post(webhookUrl, {
                    event: 'sent',
                    document_id: savedDoc.id,
                    status: 'sent',
                    timestamp: new Date().toISOString()
                });
            } catch (e) {
                console.error("Error sending webhook:", e);
            }
        }
        */

        // 7. Return result
        return {
            status: "success",
            objectId: savedDoc.id,
            signingUrl: firstSigningUrl,
            data: savedDoc.toJSON(),
            placeholders: placeholders,
            idempotentReplay: false,
        };

    } catch (err) {
        console.error('Error in createDocument:', err);
        throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Failed to create document: ' + err.message);
    }
}

export function createCreateDocument({ deliverInitial = ensureInitialDelivery } = {}) {
    return request => createDocumentWithDelivery(request, deliverInitial);
}

const createDocument = createCreateDocument();

export default createDocument;
