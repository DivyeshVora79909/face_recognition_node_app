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

const defaults = {
  MONGO_URI: 'mongodb://localhost:27017/default_organization',
  JWT_SECRET: 'default_jwt_secret_key',
  JWT_EXPIRES_IN: '1h',
  PORT: 3000,
  SALT: 10,
  DEBUG: 'false',
  MEDIA: 'media',
  PYTHON_SERVER_URL: 'http://127.0.0.1:8000',
  BATCH_SIZE: 1,
  CSV_STORE: './media/csvs',
};

Object.keys(defaults).forEach(key => {
  if (process.env[key] === undefined) {
    process.env[key] = defaults[key];
  }
});

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

          const destPath = path.join(mediaDir, 'images', `${user.uid}.jpeg`);
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

          const destPath = path.join(mediaDir, 'images', `${user.uid}.jpeg`);
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

              const destPath = path.join(mediaDir, 'images', `${user.uid}.jpeg`);
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
app.delete('/users/:uid', auth, async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ uid: req.params.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  debug(`Server running on port http://127.0.0.1:${PORT}`);
});