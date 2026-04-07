// Email sending is disabled - using code-based invites via WhatsApp/SMS instead
async function sendInviteEmail(toEmail, code, inviterName, orgName) {
  console.log(`[INVITE] Code ${code} generated for ${toEmail} by ${inviterName} (${orgName})`);
  return false;
}

module.exports = { sendInviteEmail };
