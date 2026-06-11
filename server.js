require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');

// ─── FAIL FAST ON MISSING SECRETS ─────────────────────────────────────────────
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI not set in environment variables');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET not set in environment variables. Refusing to start with an insecure default.');
  process.exit(1);
}

const app = express();

// Render/other PaaS sit behind a reverse proxy — needed for correct client IPs (rate limiting)
app.set('trust proxy', 1);

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(mongoSanitize()); // strips $ and . from keys to block NoSQL injection

// General API limiter — generous, protects against abuse/DoS
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

// Strict limiter for credential/OTP endpoints — blocks brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

app.use('/api', apiLimiter);
app.use([
  '/api/users/login',
  '/api/users/manager-login',
  '/api/users/otp',
  '/api/users/forgot-password',
  '/api/users/reset-password',
  '/api/users/setup-super-admin',
  '/api/users/register-company',
  '/api/invite/verify',
  '/api/invite/register',
], authLimiter);

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/users',     require('./routes/users'));
app.use('/api/invite',    require('./routes/invite'));
app.use('/api/sites',     require('./routes/sites'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/slips',     require('./routes/slips'));
app.use('/api/chat',      require('./routes/chat'));
app.use('/api/reports',   require('./routes/reports'));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ success: true, message: 'BhoomiTrack API is running ✅', version: '1.1.0' });
});

// ─── 404 + GLOBAL ERROR HANDLER ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[UNHANDLED ERROR]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ success: false, message: 'Server error' });
});

// ─── DATABASE + SERVER START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    app.listen(PORT, () => console.log(`🚀 BhoomiTrack server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });

// Don't crash the whole process on stray async errors — log them
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
