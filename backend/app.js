const express = require('express');
const jwt = require('jsonwebtoken');
const Minio = require('minio');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-super-secret-jwt-key-in-production';
const JWT_EXPIRES_IN = '24h';

// --- NEW ---
// In-memory database to map private IDs to file metadata
// In production, this would be a real database (e.g., Redis, PostgreSQL)
const mediaDatabase = {};
// --- END NEW ---

console.log('Starting backend...');
console.log('JWT_SECRET:', JWT_SECRET.substring(0, 10) + '...');
console.log('MINIO_ENDPOINT:', process.env.MINIO_ENDPOINT || 'minio');

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'recordings';
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || '1073741824');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'unauthorized', message: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'forbidden', message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Health check
app.get('/health', (req, res) => {
  res.send('Backend OK');
});

// Login endpoint
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;

  console.log('Login attempt:', username);

  if (username === 'testuser' && password === 'demo123') {
    const token = jwt.sign(
      { sub: username, username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    console.log('Login successful:', username);

    return res.json({
      success: true,
      token,
      expiresIn: JWT_EXPIRES_IN,
      username
    });
  }

  res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
});

// --- UPDATED ---
// Authorization endpoint for Nginx auth_request
app.get('/authz/media', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  console.log('AUTHZ - Token:', token ? 'present' : 'missing');

  if (!token) {
    console.log('AUTHZ FAILED: No token');
    return res.status(401).send('Unauthorized');
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('AUTHZ FAILED:', err.message);
      return res.status(403).send('Forbidden');
    }
    
    // --- NEW LOGIC ---
    // Get the private ID from the original request URI
    const originalUri = req.headers['x-original-uri'];
    if (!originalUri) {
        console.log('AUTHZ FAILED: Missing X-Original-URI header');
        return res.status(400).send('Bad Request');
    }

    const match = originalUri.match(/\/v1\/audio\/(.*)$/);
    if (!match || !match[1]) {
        console.log('AUTHZ FAILED: Could not parse private ID from URI', originalUri);
        return res.status(400).send('Bad Request: Invalid URI');
    }

    const privateId = match[1];
    const mediaInfo = mediaDatabase[privateId];

    if (!mediaInfo) {
        console.log('AUTHZ FAILED: No media found for private ID', privateId);
        return res.status(404).send('Not Found');
    }

    // Success! Return 200 OK and set headers for Nginx
    console.log(`AUTHZ SUCCESS: User [${user.username}] -> Private ID [${privateId}] -> MinIO Key [${mediaInfo.key}]`);
    
    // This header will be captured by Nginx to rewrite the request to MinIO
    res.setHeader('X-Media-Key', mediaInfo.key);
    // This header will be passed back to the client for display
    res.setHeader('X-Media-Filename', mediaInfo.originalName);

    res.status(200).send('OK');
    // --- END NEW LOGIC ---
  });
});
// --- END UPDATED ---

// --- UPDATED ---
// Upload endpoint
app.post('/media/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'bad_request', message: 'No file uploaded' });
    }

    const file = req.file;
    const ext = path.extname(file.originalname);
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    
    // This is the *real* key for the object in MinIO
    const objectName = `${year}/${month}/${uuidv4()}${ext}`;
    
    // This is the *private* ID we will give to the user
    const privateId = uuidv4();

    console.log(`Uploading: [${file.originalname}] as [${objectName}] with Private ID [${privateId}]`);

    await minioClient.putObject(
      BUCKET_NAME,
      objectName,
      file.buffer,
      file.size,
      { 'Content-Type': file.mimetype }
    );

    console.log('Upload successful to MinIO');

    // Store metadata in our "database"
    const fileMetadata = {
        privateId: privateId,
        key: objectName, // The MinIO key
        originalName: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
        uploadedAt: now.toISOString(),
        uploadedBy: req.user.username
    };
    mediaDatabase[privateId] = fileMetadata;

    console.log('Metadata saved to DB');

    // Return the *privateId* to the client
    res.json({
      success: true,
      message: 'File uploaded successfully',
      file: fileMetadata // Send all metadata back
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});
// --- END UPDATED ---

// --- UPDATED ---
// List files endpoint
app.get('/media/list', authenticateToken, async (req, res) => {
  try {
    // List files from our in-memory DB, not MinIO
    const files = Object.values(mediaDatabase);

    console.log('Listed files from DB:', files.length);
    res.json({ success: true, files, count: files.length });

  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});
// --- END UPDATED ---

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Backend listening on port ${PORT}`);
  console.log(`✓ MinIO: ${process.env.MINIO_ENDPOINT || 'minio'}:${process.env.MINIO_PORT || '9000'}`);
  console.log(`✓ Bucket: ${BUCKET_NAME}`);
});