export default async function updateUserProfile(request) {
  if (!request?.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }

  const { name, phone, ProfilePic, mailDisplaySender } = request.params;

  try {
    const user = request.user;
    
    if (name !== undefined) user.set('name', name);
    if (phone !== undefined) user.set('phone', phone);
    if (ProfilePic !== undefined) user.set('ProfilePic', ProfilePic);
    if (mailDisplaySender !== undefined) user.set('mailDisplaySender', mailDisplaySender);

    const updatedUser = await user.save(null, { useMasterKey: true });
    return updatedUser.toJSON();
  } catch (err) {
    console.log('Error in updateUserProfile:', err);
    throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Failed to update user profile.');
  }
}
