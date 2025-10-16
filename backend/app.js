// backend/app.js (CommonJS)
const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const Minio = require('minio');
const stream = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

app.use(express.json());

// MinIO client
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio',
  port: parseInt(process.env.MINIO_PORT || '9000', 10),
  useSSL: (process.env.MINIO_USE_SSL === 'true') || false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});

const MINIO_BUCKET = process.env.MINIO_BUCKET || 'tasama-recordings';

// Ensure bucket exists on startup
(async () => {
  try {
    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) {
      await minioClient.makeBucket(MINIO_BUCKET);
      console.log(`Created bucket: ${MINIO_BUCKET}`);
    } else {
      console.log(`Bucket ${MINIO_BUCKET} already exists`);
    }
  } catch (err) {
    console.error('Bucket check failed:', err.message);
  }
})();

// multer in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_BYTES || String(1024 * 1024 * 1024), 10) }
});

app.get('/', (req, res) => res.send('Media Upload API running'));

// Simple auth helper
function verifyTokenFromHeader(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader) throw new Error('missing token');
  const token = authHeader.split(' ')[1];
  if (!token) throw new Error('missing token');
  return jwt.verify(token, JWT_SECRET);
}

// ============ Login endpoint to get JWT token ============
app.post('/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    // Demo auth - replace with real user validation
    if (password !== 'demo123') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { 
        sub: username,
        username: username,
        iat: Math.floor(Date.now() / 1000)
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    console.log(`[LOGIN] user=${username} token generated`);
    return res.json({ token, expiresIn: '24h' });
  } catch (err) {
    console.error('[LOGIN ERROR]', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ============ Nginx auth_request endpoint ============
app.get('/authz/media', async (req, res) => {
  try {
    const user = verifyTokenFromHeader(req);
    const originalUri = req.headers['x-original-uri'] || '';
    const originalMethod = req.headers['x-original-method'] || 'GET';

    console.log(`[AUTHZ] user=${user.username} method=${originalMethod} uri=${originalUri}`);

    // Only allow GET/HEAD/OPTIONS on /v1/audio/
    if (!/^\/v1\/audio\/.+/.test(originalUri)) {
      console.error('[AUTHZ] Invalid path format');
      return res.status(403).json({ error: 'invalid path' });
    }
    
    if (!['GET', 'HEAD', 'OPTIONS'].includes(originalMethod)) {
      console.error('[AUTHZ] Method not allowed');
      return res.status(403).json({ error: 'method not allowed' });
    }

    // Extract file path
    const filePath = originalUri.replace(/^\/v1\/audio\//, '');

    // Optional: Add per-user authorization policy here
    // For example, check if user has access to this specific file

    console.log(`[AUTHZ] Success - authorized access to: ${filePath}`);
    return res.status(200).send('OK');
    
  } catch (err) {
    console.error('[AUTHZ] Failed:', err.message);
    return res.status(401).json({ error: 'unauthorized' });
  }
});

// ============ Upload endpoint ============
app.post('/media/upload', upload.single('file'), async (req, res) => {
  try {
    const user = verifyTokenFromHeader(req);
    
    if (!req.file) {
      console.error('[UPLOAD] No file in request');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filename = req.file.originalname;
    const buffer = req.file.buffer;
    const date = new Date();
    const key = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${filename}`;

    console.log(`[UPLOAD] user=${user.username} filename=${filename} size=${buffer.length} key=${key}`);

    // Stream buffer into MinIO
    const pass = new stream.PassThrough();
    pass.end(buffer);

    await minioClient.putObject(MINIO_BUCKET, key, pass, buffer.length, {
      'Content-Type': req.file.mimetype
    });
    
    console.log(`[UPLOAD] Success - key=${key}`);

    return res.json({ 
      success: true, 
      key,
      downloadPath: `/v1/audio/${key}`
    });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err && (err.stack || err.message || err));
    return res.status(401).json({ error: 'Unauthorized or upload failed', details: err && err.message });
  }
});

// ============ List files endpoint (optional) ============
app.get('/media/list', async (req, res) => {
  try {
    const user = verifyTokenFromHeader(req);
    
    const files = [];
    const stream = minioClient.listObjects(MINIO_BUCKET, '', true);
    
    stream.on('data', (obj) => {
      files.push({
        key: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        downloadPath: `/v1/audio/${obj.name}`
      });
    });
    
    stream.on('error', (err) => {
      console.error('[LIST ERROR]', err.message);
      return res.status(500).json({ error: 'List failed' });
    });
    
    stream.on('end', () => {
      console.log(`[LIST] user=${user.username} count=${files.length}`);
      return res.json({ success: true, files });
    });
    
  } catch (err) {
    console.error('[LIST ERROR]', err.message);
    return res.status(401).json({ error: 'Unauthorized or list failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`JWT_SECRET: ${JWT_SECRET.substring(0, 10)}...`);
  console.log(`MinIO Bucket: ${MINIO_BUCKET}`);
});