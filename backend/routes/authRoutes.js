const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const passport = require('passport');
const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const ScheduledCall = require("../models/ScheduledCall"); 
require('../config/passportConfig');
require('dotenv').config();

const router = express.Router();

// Signup Route
router.post('/signup', async (req, res) => {
  const { firstName, lastName, email, password } = req.body;
  try {
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(400).json({ error: "Account already exists with this email. Please log in using your Google account" });
    }
    const user = new User({ firstName, lastName, email, password });
    await user.save();

    // Generate a token with userId in the payload
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { firstName, lastName, email } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Login Route
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    // Ensure the user has a password (not a Google account)
    if (!user.password) {
      return res.status(400).json({ error: 'The account was created using Google. Please log in using Google.' });
    }

    // Compare the entered password with the hashed password in the database
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Generate a token with userId in the payload
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { firstName: user.firstName, lastName: user.lastName, email: user.email } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Google Auth Routes
router.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account', 
}));
router.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err, user, info) => {
    if (err) {
      console.error("Google OAuth Callback Error:", err);
      return res.redirect(`https://moon-ai-one.vercel.app?error=Server error`);
    }

    if (!user) {
      console.error("Google OAuth Failed:", info?.message || "Unknown reason");
      return res.redirect(`https://moon-ai-one.vercel.app?error=${encodeURIComponent(info?.message || "Authentication failed")}`);
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`https://moon-ai-one.vercel.app/?token=${token}`);
  })(req, res, next);
});

// Profile Route (Protected by JWT)
router.get('/api/profile', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    // Fetch the user's profile information from the database
    const user = await User.findById(req.user._id).select('-password'); // Exclude the password field
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/send-verification-code', passport.authenticate('jwt', { session: false }), async (req, res) => {
  const { currentPassword } = req.body;

  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify the current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    // Generate a random 6-digit verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Save the verification code in the user's document
    user.verificationCode = verificationCode;
    await user.save();

    // Send the verification code via email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: 'Verification Code',
      text: `Your verification code is: ${verificationCode}`,
    };

    await transporter.sendMail(mailOptions);

    res.json({ message: 'Verification code sent successfully.' });
  } catch (error) {
    console.error('Error sending verification code:', error);
    res.status(500).json({ error: 'Failed to send verification code.' });
  }
});

// Update Profile (with verification code check)
router.put('/api/profile', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const { firstName, lastName, currentPassword, newPassword, verificationCode } = req.body;

    // Fetch the user
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify the current password
    if (currentPassword) {
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
    }

    // Verify the verification code
    if (verificationCode && verificationCode !== user.verificationCode) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    // Update the user's profile
    const updates = { firstName, lastName };
    if (newPassword) {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      updates.password = hashedPassword;
    }

    // Clear the verification code after successful update
    updates.verificationCode = null;

    const updatedUser = await User.findByIdAndUpdate(req.user._id, updates, { new: true });
    res.json({ message: 'Profile updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// Delete user profile
router.delete('/api/profile', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.user._id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Forgot password 
router.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // Generate a random 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user.otp = otp;
  user.otpExpiry = Date.now() + 10 * 60 * 1000; // OTP valid for 10 minutes
  await user.save();

  // Send OTP via email (using nodemailer)
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Password Reset OTP',
    text: `Your OTP for password reset is: ${otp}. It is valid for 10 minutes`,
  };
  console.log(`OTP for ${email}: ${otp}, Expires at: ${new Date(user.otpExpiry).toLocaleString()}`);

  await transporter.sendMail(mailOptions);
  res.json({ message: "OTP sent to your email" });
});

router.post('/api/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Log OTP and expiry for debugging
    console.log(`Received OTP: ${otp}, Stored OTP: ${user.otp}, Expiry: ${new Date(user.otpExpiry).toLocaleString()}`);

    // Ensure OTP is correct and not expired
    if (!user.otp || user.otp !== otp || !user.otpExpiry || user.otpExpiry < Date.now()) {
      return res.status(400).json({ message: 'Invalid or expired OTP.' });
    }

    // Ensure password meets security criteria
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    // new password before saving
    user.password = newPassword;
    user.otp = null;
    user.otpExpiry = null;

    await user.save();

    res.status(200).json({ success: true, message: 'Password reset successfully.' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Razorpay webhook
router.post('/payment-webhook', async (req, res) => {
  const crypto = require('crypto');
  const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET);
  shasum.update(JSON.stringify(req.body));
  const digest = shasum.digest('hex');

  if (digest !== req.headers['x-razorpay-signature']) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const { payload } = req.body;
  if (payload.payment.entity.status === 'captured') {
    try {
      const email = payload.payment.entity.email;
      const plan = payload.payment.entity.notes.plan; // From order metadata
      
      await User.findOneAndUpdate(
        { email },
        { 
          $set: { 
            plan,
            totalCalls: plan === 'Basic Plan' ? 100 : 
                      plan === 'Pro Plan' ? 250 : 
                      plan === 'Quantum Flex Plan' ? 10000 : 0,
            usedCalls: 0 
          } 
        }
      );
      res.status(200).end();
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).end();
    }
  }
});

// Update user plan after successful payment
// router.post('/api/update-plan', passport.authenticate('jwt', { session: false }), async (req, res) => {
//   const { plan, totalCalls } = req.body;
//   const userId = req.user._id;

//   try {
//     const user = await User.findById(userId);
//     if (!user) {
//       return res.status(404).json({ error: 'User not found' });
//     }

//     // Update user's plan and total calls
//     user.plan = plan;
//     user.totalCalls = totalCalls;
//     user.usedCalls = 0; // Reset used calls when a new plan is purchased
//     await user.save();

//     res.json({ message: 'Plan updated successfully', user });
//   } catch (error) {
//     console.error('Error updating plan:', error);
//     res.status(500).json({ error: 'Failed to update plan' });
//   }
// });

router.get("/user-plan", async (req, res) => {
  const { email } = req.query;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      activePlan: user.plan || null,
      totalCalls: user.totalCalls || 0,
      usedCalls: user.usedCalls || 0,
      totalCallsTillDate: user.totalCallsTillDate || 0,
    });
  } catch (error) {
    console.error("Error fetching user plan:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create Order API
router.post('/api/create-order', async (req, res) => {
  try {
    const { plan, amount } = req.body;
    const options = {
      amount: amount * 100,
      currency: 'INR',
      receipt: `order_${Date.now()}`,
      notes: { plan }, // Critical for webhook
      payment_capture: 1
    };
    const order = await razorpay.orders.create(options);
    res.json({ orderId: order.id, amount, plan });
  } catch (error) {
    res.status(500).json({ error: 'Error creating order' });
  }
});

router.post('/verify-payment', async (req, res) => {
  const crypto = require('crypto');
  
  try {
    // 1. Validate required fields
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, plan, email } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !plan || !email) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required payment verification fields' 
      });
    }

    // 2. Verify payment signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid payment signature' 
      });
    }

    // 3. Calculate call allocation based on plan
    const callAllocation = {
      'Basic Plan': 100,
      'Pro Plan': 250,
      'Quantum Flex Plan': 10000
    };

    // 4. Update user plan with transaction record
    const updateResult = await User.findOneAndUpdate(
      { email },
      { 
        $set: {
          plan,
          totalCalls: callAllocation[plan] || 0,
          usedCalls: 0,
          lastPayment: {
            paymentId: razorpay_payment_id,
            amount: req.body.amount || null,
            date: new Date()
          }
        },
        $push: {
          paymentHistory: {
            paymentId: razorpay_payment_id,
            plan,
            date: new Date(),
            amount: req.body.amount || null
          }
        }
      },
      { new: true, upsert: false }
    );

    if (!updateResult) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    // 5. Log successful verification
    console.log(`Payment verified for ${email}. Plan: ${plan}, Payment ID: ${razorpay_payment_id}`);

    // 6. Return success response with plan details
    res.json({
      success: true,
      plan,
      totalCalls: callAllocation[plan] || 0,
      paymentId: razorpay_payment_id,
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
    });

  } catch (err) {
    console.error('Payment verification error:', err);
    res.status(500).json({ 
      success: false,
      error: 'Payment verification failed',
      details: process.env.NODE_ENV === 'development' ? err.message : null
    });
  }
});

module.exports = router;