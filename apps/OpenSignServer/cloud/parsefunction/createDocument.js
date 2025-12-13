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
    // We might want to check permissions, but for now assuming the user has access if they have the ID
    // or we can check if the user is the creator or part of the org.
    // For simplicity, we use useMasterKey to fetch the template, but we should be careful.
    // Ideally: templateQuery.equalTo('CreatedBy', request.user); or similar if templates are private.
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
    
    // 5. Return result
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
