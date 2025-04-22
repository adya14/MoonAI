const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String },
  verificationCode: { type: String },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: function() { return !this.googleId; } },
  googleId: { type: String, unique: true, sparse: true }, 
  plan: { type: String, default: 'No active plan' }, 
  totalCalls: { type: Number, default: 0 }, 
  usedCalls: { type: Number, default: 0 },
  totalCallsTillDate: { type: Number, default: 0 },
  otp: { type: String }, 
  otpExpiry: { type: Date }, 
});

userSchema.pre('save', async function (next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

// userSchema.index({ email: 1 }, { unique: true });
module.exports = mongoose.model('User', userSchema);