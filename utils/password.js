// Shared password policy (ENH-018).
//
// The old rule was six characters with no other constraint, which is below what
// a paying customer's IT reviewer expects. The rules below are deliberately
// modest: long enough to matter, but not so fussy that site managers on phones
// end up writing passwords on a wall.

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

// The handful that show up first in any credential-stuffing list. Not a
// substitute for a breach-corpus check, just the cheapest possible filter.
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'welcome1', 'welcome123',
  'abc12345', 'letmein1', 'bhoomitrack', 'construction',
]);

/**
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function validatePassword(password, { name = '', email = '', phone = '' } = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, message: 'Password is required' };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_LENGTH} characters` };
  }
  if (password.length > MAX_LENGTH) {
    return { ok: false, message: `Password must be at most ${MAX_LENGTH} characters` };
  }
  if (/^\d+$/.test(password)) {
    return { ok: false, message: 'Password cannot be only numbers' };
  }
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, message: 'Password cannot be a single repeated character' };
  }

  const lower = password.toLowerCase();
  if (COMMON.has(lower)) {
    return { ok: false, message: 'That password is too common. Please choose another.' };
  }

  // Reject a password that is just the person's own details — the most likely
  // guess anyone who knows them would make.
  const localPart = String(email || '').split('@')[0];
  for (const personal of [name, localPart, phone]) {
    const p = String(personal || '').trim().toLowerCase();
    if (p.length >= 4 && (lower === p || lower.includes(p))) {
      return { ok: false, message: 'Password must not contain your name, email or phone number' };
    }
  }

  return { ok: true };
}

module.exports = { validatePassword, MIN_LENGTH };
