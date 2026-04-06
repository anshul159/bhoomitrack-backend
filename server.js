require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/users',     require('./routes/users'));
app.use('/api/sites',     require('./routes/sites'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/slips',     require('./routes/slips'));
app.use('/api/chat',      require('./routes/chat'));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ success: true, message: 'BhoomiTrack API is running ✅', version: '1.0.0' });
});

// ─── DATABASE + SERVER START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI not set in environment variables');
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    app.listen(PORT, () => console.log(`🚀 BhoomiTrack server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
