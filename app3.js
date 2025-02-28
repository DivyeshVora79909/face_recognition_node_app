const express = require('express');
const { User, UserType } = require('./models');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const sharp = require('sharp');
const bodyParser = require('body-parser');
const fs = require('fs');

require('dotenv').config();
const debug = process.env.DEBUG === 'true' 
  ? (...args) => console.log('[Debug]', ...args)
  : () => {};

totalLec = 16
// debug('Environment', process.env);
// debug(UserType)

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// auth middleware
const auth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    if (!authHeader) throw new Error('Authorization header missing');

    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findOne({ uid: decoded.uid });

    if (!user) throw new Error('User not found');
    req.user = user;

    debug(`Authenticated user: ${user.uid}`);
    next();
  } catch (error) {
    debug('Authentication error:', error.message);
    res.status(401).json({ error: 'Please authenticate' });
  }
};


// Create media directories if they don't exist
const mediaDir = process.env.MEDIA;
const directories = ['images', 'pdfs', 'csvs', 'extras', 'attendance', 'remarks'];
directories.forEach(dir => {
  const dirPath = path.join(mediaDir, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    debug(`Created directory: ${dirPath}`);
  }
});

// Login Route
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { uid: user.uid, usertype: user.usertype },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
    
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Create user with Base64 image upload
app.post('/create', auth, async (req, res) => {
  let user;
  try {
      const { image, ...userData } = req.body;

      // Remove protected fields
      delete userData.uid;
      delete userData.rollno;

      // Create and save user (even if image is missing)
      user = new User(userData);
      await user.save();

      // Process Base64 image if provided
      if (image) {
          const matches = image.match(/^data:image\/(\w+);base64,(.+)$/);
          if (!matches) {
              // If image is provided but format is invalid, delete the user and return error
              await User.deleteOne({ _id: user._id });
              return res.status(400).json({ error: 'Invalid image format - must be base64 encoded data URI' });
          }

          const filename = `${user.uid}_${user.username || ''}.jpeg`;
          const destPath = path.join(mediaDir, 'images', filename);
          await sharp(Buffer.from(matches[2], 'base64'))
              .jpeg()
              .toFile(destPath);

          debug(`Image saved successfully for user: ${user.uid}`); // Log only if saved
      }

      // Return user without password
      const userResponse = user.toObject();
      delete userResponse.password;
      res.status(201).json(userResponse);

  } catch (error) {
      // Cleanup user if image processing or other errors failed
      if (user) await User.deleteOne({ _id: user._id });
      res.status(400).json({ error: error.message });
  }
});

// Get user as self
app.get('/users/me', auth, async (req, res) => {
  try {
    // Convert mongoose document to plain object and remove password
    const user = req.user.toObject();
    delete user.password;
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all users
app.get('/users', auth, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get attendance summary for all users
app.get('/users/attendance', async (req, res) => {
  try {
    // Fetch all users from the database, including only the 'uid' and 'attendance' fields
    const users = await User.aggregateAttendance();
    debug('All users attendance summary:', users);

    // Return the consolidated attendance summaries for all users
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Fetch all UIDs starting with "ST"
app.get('/fetch', async (req, res) => {
  try {
    // Query the database to get users whose UIDs start with "ST"
    const users = await User.find({ uid: { $regex: '^ST', $options: 'i' } }, { uid: 1, _id: 0 });

    // Extract UIDs into an array
    const uids = users.map(user => user.uid);

    // Return the array of UIDs
    res.json({ uids });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to return a list of predefined subjects
app.get('/subjects', (req, res) => {
  try {
    // Define the list of subjects
    const subjects = [
      "Geography",
      "Mathematics",
      "Science",
      "Art",
      "Physical Education",
      "History",
      "English"
    ];

    // Return the list as JSON
    res.json({ subjects });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/users/attendance/:date?', async (req, res) => {
  try {
    let date = req.params.date;

    // Validate the date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (date && !dateRegex.test(date)) {
      date = null; // Invalidate if not in correct format
    }

    if (!date) {
      // If no date is provided or it's invalid, use today's date
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      date = `${year}-${month}-${day}`;
    }

    const users = await User.getAttendanceByDate(date);
    debug(`All users attendance summary for ${date}:`, users);

    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get user by UID
app.get('/users/:uid', auth, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.params.uid }).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get users by type
app.get('/users/type/:usertype', auth, async (req, res) => {
  const user = req.params.usertype;
  if (!UserType.hasOwnProperty(user)) {
    return res.status(404).json({ error: 'User type not found' });
  }

  try {
    const users = await User.find({ usertype: user }).select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get attendance summary for authenticated user
app.get('/users/me/attendance', auth, async (req, res) => {
  try {
    // Extract the authenticated user's UID
    const uid = req.user.uid;

    // Find the user by UID and retrieve only the 'attendance' field
    const user = await User.findOne({ uid }, { attendance: 1 }).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Initialize an object to store subject counts
    const subjectCounts = {};

    if (user.attendance) {
      for (const timestamp in user.attendance) {
        const subject = user.attendance[timestamp];
        if (subjectCounts[subject]) {
          subjectCounts[subject]++;
        } else {
          subjectCounts[subject] = 1;
        }
      }
    }
    // Convert the subjectCounts object into an array of objects for better readability
    const attendanceSummary = Object.keys(subjectCounts).map(subject => ({
      subject,
      count: subjectCounts[subject]
    }));
    debug('Attendance summary:', attendanceSummary);
    // Return the attendance summary
    res.json({ attendanceSummary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Partial update user (PATCH) with Base64 image (Image-only update)
app.patch('/users/:uid', auth, async (req, res) => {
  try {
      const user = await User.findOne({ uid: req.params.uid });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const updates = {}; // Start with an empty updates object

      // Check if only image is being updated
      if (Object.keys(req.body).length === 1 && req.body.image) {
          const matches = req.body.image.match(/^data:image\/(\w+);base64,(.+)$/);
          if (!matches) {
              return res.status(400).json({ error: 'Invalid image format - must be base64 encoded data URI' });
          }

          const filename = `${user.uid}_${user.username || ''}.jpeg`;
          const destPath = path.join(mediaDir, 'images', filename);
          await sharp(Buffer.from(matches[2], 'base64'))
              .jpeg()
              .toFile(destPath);

          // If you're storing the image path in the user document:
          // updates.profileImagePath = destPath; 

          // Important: Don't assign req.body directly to updates!
          // updates = req.body; // This would overwrite updates with just the image.
      } else if (Object.keys(req.body).length > 0) { // Regular partial update
          Object.assign(updates, req.body);
          delete updates.uid;
          delete updates.usertype;
          delete updates.rollno;
          delete updates.password;
          if (updates.image) { // If image is part of a regular update
              const matches = updates.image.match(/^data:image\/(\w+);base64,(.+)$/);
              if (!matches) {
                  return res.status(400).json({ error: 'Invalid image format - must be base64 encoded data URI' });
              }

              const filename = `${user.uid}_${user.username || ''}.jpeg`;
              const destPath = path.join(mediaDir, 'images', filename);
              await sharp(Buffer.from(matches[2], 'base64'))
                  .jpeg()
                  .toFile(destPath);
              delete updates.image;
          }
      }
      
      if (Object.keys(updates).length > 0) { // Only update if there are changes
          Object.assign(user, updates);
          await user.save();
      }

      res.json(user); // Return the updated user (or the original if no changes)

  } catch (error) {
      res.status(400).json({ error: error.message });
  }
});


// Delete user
// app.delete('/users/:uid', auth, async (req, res) => {
//   try {
//     const user = await User.findOneAndDelete({ uid: req.params.uid });
//     if (!user) return res.status(404).json({ error: 'User not found' });
//     res.json(user);
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });


// Delete user
app.delete('/users/:uid', auth, async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ uid: req.params.uid });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const imageDir = path.join(mediaDir, 'images');

        // Use fs.promises directly
        const files = await fs.promises.readdir(imageDir);

        const deletePromises = files.map(async (file) => {
            if (file.startsWith(`${req.params.uid}_`)) {
                const filePath = path.join(imageDir, file);
                try {
                    await fs.promises.unlink(filePath); // Use fs.promises.unlink
                    console.log(`Deleted image: ${filePath}`);
                } catch (deleteError) {
                    console.error(`Error deleting image ${filePath}:`, deleteError);
                }
            }
        });

        await Promise.all(deletePromises);

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  debug(`Server running on port http://127.0.0.1:${PORT}`);
});