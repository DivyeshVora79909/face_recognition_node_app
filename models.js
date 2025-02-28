const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const { Schema } = mongoose;
require('dotenv').config();

const debug = process.env.DEBUG === 'true' 
  ? (...args) => console.log('[Debug]', ...args)
  : () => {};
  
// Connect to MongoDB
mongoose.connect('mongodb://localhost/institution', { 
  useNewUrlParser: true, 
  useUnifiedTopology: true 
});

const db = mongoose.connection;
db.on('error', (error) => {
  debug('MongoDB connection error:', error);
  process.exit(1);
});
db.once('open', () => debug('Connected to MongoDB'));

// Counter schema
const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// UserType registry and prefix check
const UserType = {};
const prefixes = {};

function registerUserType(name, prefix) {
  if (prefix.length !== 2) {
    throw new Error(`Prefix ${prefix} must be 2 characters`);
  }
  if (prefixes[prefix]) {
    throw new Error(`Prefix ${prefix} is already used by ${prefixes[prefix]}`);
  }
  UserType[name] = prefix;
  prefixes[prefix] = name;
}

// Register user types (example types)
registerUserType('Student', 'ST');
registerUserType('Teacher', 'TE');
registerUserType('Manager', 'MA');

// BaseUser schema
const userSchema = new Schema({
  usertype: { 
    type: String, 
    enum: Object.keys(UserType), 
    required: true 
  },
  // rollno: { type: Number, required: true },
  // uid: { type: String, required: true, unique: true },
  rollno: { type: Number },
  uid: { type: String, unique: true },
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  password: { type: String, required: true },
  additional: { type: Object, required: false }
});

// Pre-save middleware to generate rollno and uid
userSchema.pre('save', async function(next) {
  if (this.isNew) {

    const prefix = UserType[this.usertype];
    if (!prefix) return next(new Error('Invalid user type'));

    try {
      const counter = await Counter.findOneAndUpdate(
        { _id: this.usertype },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.rollno = counter.seq;
      this.uid = prefix + this.rollno;
    } catch (err) {
      return next(err);
    }
  }

  if (this.isModified('password')) {
    try {
      const saltRounds = parseInt(process.env.SALT_ROUNDS) || 10;
      this.password = await bcrypt.hash(this.password, saltRounds);      
    } catch (err) {
      return next(err);
    }
  }
  next();
});

// Aggregation function to process attendance
userSchema.statics.aggregateAttendance = async function () {
  try {
    return await this.aggregate([
      { $match: { uid: { $exists: true }, attendance: { $exists: true } } },
      { $project: { uid: 1, attendanceArray: { $objectToArray: "$attendance" } } },
      { $unwind: "$attendanceArray" },
      { 
        $group: {
          _id: { uid: "$uid", subject: "$attendanceArray.v" },
          count: { $sum: 1 }
        }
      },
      { 
        $group: {
          _id: "$_id.uid",
          subjects: { 
            $push: { subject: "$_id.subject", count: "$count" } 
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);
  } catch (error) {
    throw new Error(`Error aggregating attendance: ${error.message}`);
  }
};


userSchema.statics.getAttendanceByDate = async function (targetDate) {
  try {
    return await this.aggregate([
      {
        $match: {
          uid: { $exists: true },
          attendance: { $exists: true, $type: "object" }
        }
      },
      {
        $project: {
          uid: 1,
          attendanceArray: { $objectToArray: "$attendance" }
        }
      },
      {
        $project: {
          uid: 1,
          filteredAttendance: {
            $filter: {
              input: "$attendanceArray",
              as: "entry",
              cond: {
                $regexMatch: {
                  input: "$$entry.k",
                  regex: `^${targetDate}` // Match keys starting with the specified date
                }
              }
            }
          }
        }
      },
      {
        $match: {
          filteredAttendance: { $ne: [] } // Exclude users with empty filteredAttendance
        }
      },
      {
        $project: {
          _id: 0,
          uid: 1,
          attendance: {
            $arrayToObject: "$filteredAttendance"
          }
        }
      }
    ]);
  } catch (error) {
    throw new Error(`Error fetching attendance for ${targetDate}: ${error.message}`);
  }
};

const User = mongoose.model('User', userSchema);

module.exports = {
  Counter,
  User,
  UserType
};
