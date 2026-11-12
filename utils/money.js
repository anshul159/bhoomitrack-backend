// Rupees as the app shows them, for messages the server writes itself (push).
// Indian grouping — ₹1,25,000, not ₹125,000 — and paise only when there are any.

function formatRupees(amount) {
  const value = Number(amount) || 0;
  const hasPaise = Math.round(Math.abs(value) * 100) % 100 !== 0;
  return '₹' + value.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

module.exports = { formatRupees };
