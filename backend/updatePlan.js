require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/user');
const connectDB = require('./db');

async function updateBasicPlanUsers() {
  try {
    await connectDB();
    
    const result = await User.updateMany(
      { plan: "Basic Plan" },
      { $set: { totalCalls: 10000 } }
    );
    
    console.log(`Updated ${result.modifiedCount}`);
    process.exit(0);
  } catch (error) {
    console.error('Error updating users:', error);
    process.exit(1);
  }
}

updateBasicPlanUsers();