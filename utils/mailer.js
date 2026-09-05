// Transactional email (ENH-001).
//
// Password reset previously wrote a six-digit code — next to the user's email
// address — into the Render log and told the caller to go and read it there.
// That is not a product, and it is a standing credential leak to anyone with log
// access.
//
// Configuration is plain SMTP, which every provider speaks (Resend, SES, Postmark,
// Brevo, Gmail). Set these on Render:
//
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
//
// If SMTP is not configured the send fails loudly in production and is skipped
// with a warning in development. It NEVER falls back to logging the code.

const nodemailer = require('nodemailer');

let transporter = null;
let initAttempted = false;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (initAttempted) return transporter;
  initAttempted = true;

  if (!isConfigured()) {
    console.warn('[MAIL] SMTP_HOST/SMTP_USER/SMTP_PASS not set — outbound email is disabled.');
    return null;
  }

  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 is implicit TLS; 587 upgrades via STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log('[MAIL] SMTP transport ready.');
  return transporter;
}

/**
 * @returns {Promise<boolean>} whether the message was handed to the provider.
 * @throws in production when email is not configured — a silent failure here
 *         means a customer waiting forever for a code that will never arrive.
 */
async function sendMail({ to, subject, text, html }) {
  const tx = getTransporter();
  if (!tx) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email is not configured on this server');
    }
    console.warn(`[MAIL] Skipped "${subject}" to ${to} — SMTP not configured (development).`);
    return false;
  }

  await tx.sendMail({
    from: process.env.MAIL_FROM || 'BhoomiTrack <no-reply@bhoomitrack.app>',
    to,
    subject,
    text,
    html,
  });
  return true;
}

// The reset code itself is never logged — not here, not by the caller.
async function sendPasswordResetEmail(to, name, code, expiryMinutes) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = [
    greeting,
    '',
    `Your BhoomiTrack password reset code is: ${code}`,
    '',
    `It expires in ${expiryMinutes} minutes and can be used once.`,
    'If you did not ask to reset your password, you can ignore this email — nothing has changed.',
    '',
    'BhoomiTrack',
  ].join('\n');

  const html = `
    <p>${greeting}</p>
    <p>Your BhoomiTrack password reset code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0">${code}</p>
    <p>It expires in ${expiryMinutes} minutes and can be used once.</p>
    <p style="color:#666">If you did not ask to reset your password, you can ignore this
    email — nothing has changed.</p>
    <p>BhoomiTrack</p>`;

  return sendMail({ to, subject: 'Your BhoomiTrack password reset code', text, html });
}

// Sent to the CURRENT super admin, never to the person being promoted — the code
// is what proves the outgoing holder agreed, so it must reach them and only them.
async function sendSuperAdminTransferEmail(to, name, targetName, code, expiryMinutes) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = [
    greeting,
    '',
    `You asked to make ${targetName} the Super Admin of your BhoomiTrack organisation.`,
    '',
    `Your confirmation code is: ${code}`,
    '',
    `It expires in ${expiryMinutes} minutes.`,
    '',
    'After you confirm:',
    `  • ${targetName} becomes Super Admin.`,
    '  • You become an owner, and keep web console access.',
    '  • Both of you will be signed out and will need to log in again.',
    '',
    'If you did not ask for this, ignore this email and change your password — nothing has changed yet.',
    '',
    'BhoomiTrack',
  ].join('\n');

  const html = `
    <p>${greeting}</p>
    <p>You asked to make <strong>${targetName}</strong> the Super Admin of your BhoomiTrack organisation.</p>
    <p>Your confirmation code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0">${code}</p>
    <p>It expires in ${expiryMinutes} minutes.</p>
    <p>After you confirm, ${targetName} becomes Super Admin, you become an owner and keep
    web console access, and <strong>both of you will be signed out</strong>.</p>
    <p style="color:#666">If you did not ask for this, ignore this email and change your
    password — nothing has changed yet.</p>
    <p>BhoomiTrack</p>`;

  return sendMail({ to, subject: 'Confirm your BhoomiTrack Super Admin transfer', text, html });
}

module.exports = { sendMail, sendPasswordResetEmail, sendSuperAdminTransferEmail, isConfigured };
