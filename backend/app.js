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
    
    console.log('AUTHZ SUCCESS:', user.username);
    res.status(200).send('OK');
  });
});

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
    const fileId = uuidv4();
    const objectName = `${year}/${month}/${fileId}${ext}`;

    console.log('Uploading:', objectName);

    await minioClient.putObject(
      BUCKET_NAME,
      objectName,
      file.buffer,
      file.size,
      { 'Content-Type': file.mimetype }
    );

    console.log('Upload successful');

    res.json({
      success: true,
      message: 'File uploaded successfully',
      file: {
        id: fileId,
        key: objectName,
        originalName: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
        uploadedAt: now.toISOString(),
        uploadedBy: req.user.username
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

// List files endpoint
app.get('/media/list', authenticateToken, async (req, res) => {
  try {
    const stream = minioClient.listObjects(BUCKET_NAME, '', true);
    const files = [];

    stream.on('data', (obj) => {
      files.push({
        key: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag
      });
    });

    stream.on('error', (err) => {
      console.error('List error:', err);
      res.status(500).json({ error: 'internal_error', message: err.message });
    });

    stream.on('end', () => {
      console.log('Listed files:', files.length);
      res.json({ success: true, files, count: files.length });
    });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

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