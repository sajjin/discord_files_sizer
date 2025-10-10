const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const fsSync = require('fs');
const cors = require('cors');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 51424;
const API_KEY = process.env.API_KEY || 'your-secret-api-key';
const DOMAIN = process.env.DOMAIN || 'http://file-server';
const FILE_RETENTION_DAYS = parseInt(process.env.FILE_RETENTION_DAYS) || 30;
const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks (safe for Cloudflare)

// Increase timeouts
app.use((req, res, next) => {
    req.setTimeout(300000); // 5 minutes per chunk
    res.setTimeout(300000);
    next();
});

// Enable CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Upload-ID', 'X-Chunk-Index', 'X-Total-Chunks', 'X-File-Name', 'X-File-Size'],
    exposedHeaders: ['Content-Length', 'Content-Type']
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Create directories
const uploadsDir = path.join(__dirname, 'uploads');
const chunksDir = path.join(__dirname, 'chunks');
fs.mkdir(uploadsDir, { recursive: true });
fs.mkdir(chunksDir, { recursive: true });

// Track active chunked uploads
const activeUploads = new Map();

// Configure multer for chunks
const chunkStorage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadId = req.headers['x-upload-id'];
        const uploadDir = path.join(chunksDir, uploadId);
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const chunkIndex = req.headers['x-chunk-index'];
        cb(null, `chunk_${chunkIndex}`);
    }
});

const chunkUpload = multer({
    storage: chunkStorage,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB per chunk
        fieldSize: 100 * 1024 * 1024
    }
});

// Regular upload storage
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueId = crypto.randomBytes(16).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueId}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB for regular uploads
        fieldSize: 100 * 1024 * 1024
    }
});

// API Key middleware
const requireApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
};

// Initialize chunked upload
app.post('/upload/init', requireApiKey, async (req, res) => {
    try {
        const { fileName, fileSize, totalChunks } = req.body;
        
        console.log(`\n📦 Init request received:`, JSON.stringify(req.body, null, 2));
        
        if (!fileName || !fileSize || !totalChunks) {
            console.error(`   ❌ Missing required fields`);
            return res.status(400).json({ 
                success: false,
                error: 'Missing required fields',
                required: ['fileName', 'fileSize', 'totalChunks']
            });
        }
        
        const uploadId = crypto.randomBytes(16).toString('hex');
        const uploadDir = path.join(chunksDir, uploadId);
        await fs.mkdir(uploadDir, { recursive: true });
        
        activeUploads.set(uploadId, {
            fileName,
            fileSize,
            totalChunks: parseInt(totalChunks),
            receivedChunks: new Set(),
            createdAt: Date.now(),
            lastActivity: Date.now()
        });
        
        console.log(`📦 Chunked upload initialized: ${uploadId}`);
        console.log(`   File: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
        console.log(`   Chunks: ${totalChunks} × ${(CHUNK_SIZE / 1024 / 1024).toFixed(0)} MB`);
        
        const response = {
            success: true,
            uploadId,
            chunkSize: CHUNK_SIZE
        };
        
        console.log(`   ✅ Sending response:`, JSON.stringify(response, null, 2));
        res.json(response);
    } catch (error) {
        console.error('Init error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to initialize upload',
            message: error.message
        });
    }
});

// Upload chunk
app.post('/upload/chunk', requireApiKey, chunkUpload.single('chunk'), async (req, res) => {
    try {
        const uploadId = req.headers['x-upload-id'];
        const chunkIndex = parseInt(req.headers['x-chunk-index']);
        const totalChunks = parseInt(req.headers['x-total-chunks']);
        
        console.log(`\n📦 Chunk upload request:`);
        console.log(`   Upload ID: ${uploadId}`);
        console.log(`   Chunk: ${chunkIndex + 1}/${totalChunks}`);
        
        if (!uploadId || uploadId === 'undefined' || uploadId === 'null') {
            console.error(`   ❌ Invalid upload ID: ${uploadId}`);
            return res.status(400).json({ 
                success: false,
                error: 'Invalid upload ID',
                received: uploadId
            });
        }
        
        if (chunkIndex === undefined || !totalChunks) {
            console.error(`   ❌ Missing chunk headers`);
            return res.status(400).json({ 
                success: false,
                error: 'Missing chunk headers',
                headers: {
                    uploadId,
                    chunkIndex,
                    totalChunks
                }
            });
        }
        
        const uploadInfo = activeUploads.get(uploadId);
        if (!uploadInfo) {
            console.error(`   ❌ Upload not found: ${uploadId}`);
            console.error(`   Active uploads: ${Array.from(activeUploads.keys()).join(', ') || 'none'}`);
            return res.status(404).json({ 
                success: false,
                error: 'Upload not found or expired',
                uploadId: uploadId,
                activeUploads: activeUploads.size
            });
        }
        
        uploadInfo.receivedChunks.add(chunkIndex);
        uploadInfo.lastActivity = Date.now();
        
        const progress = Math.round((uploadInfo.receivedChunks.size / totalChunks) * 100);
        
        console.log(`   ✓ Chunk ${chunkIndex + 1}/${totalChunks} received (${progress}%)`);
        
        res.json({
            success: true,
            chunkIndex,
            received: uploadInfo.receivedChunks.size,
            total: totalChunks,
            progress
        });
        
    } catch (error) {
        console.error('Chunk upload error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to upload chunk',
            message: error.message
        });
    }
});

// Finalize chunked upload
app.post('/upload/finalize', requireApiKey, async (req, res) => {
    try {
        const { uploadId } = req.body;
        
        if (!uploadId) {
            return res.status(400).json({ error: 'Missing uploadId' });
        }
        
        const uploadInfo = activeUploads.get(uploadId);
        if (!uploadInfo) {
            return res.status(404).json({ error: 'Upload not found' });
        }
        
        // Check all chunks received
        if (uploadInfo.receivedChunks.size !== uploadInfo.totalChunks) {
            return res.status(400).json({
                error: 'Not all chunks received',
                received: uploadInfo.receivedChunks.size,
                expected: uploadInfo.totalChunks
            });
        }
        
        console.log(`\n🔗 Assembling chunks for: ${uploadInfo.fileName}`);
        
        // Generate final filename
        const uniqueId = crypto.randomBytes(16).toString('hex');
        const ext = path.extname(uploadInfo.fileName);
        const finalFileName = `${uniqueId}${ext}`;
        const finalPath = path.join(uploadsDir, finalFileName);
        const chunksPath = path.join(chunksDir, uploadId);
        
        // Assemble chunks
        const writeStream = fsSync.createWriteStream(finalPath);
        
        for (let i = 0; i < uploadInfo.totalChunks; i++) {
            const chunkPath = path.join(chunksPath, `chunk_${i}`);
            const chunkData = await fs.readFile(chunkPath);
            writeStream.write(chunkData);
            console.log(`   ↪ Merged chunk ${i + 1}/${uploadInfo.totalChunks}`);
        }
        
        writeStream.end();
        
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
        
        // Verify file size
        const stats = await fs.stat(finalPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        console.log(`✅ File assembled: ${sizeMB} MB`);
        
        // Clean up chunks
        await fs.rm(chunksPath, { recursive: true, force: true });
        activeUploads.delete(uploadId);
        
        // Generate URLs
        const fileUrl = `${DOMAIN}/files/${finalFileName}`;
        const embedUrl = `${DOMAIN}/e/${finalFileName}`;
        const mimeType = mime.lookup(uploadInfo.fileName) || 'application/octet-stream';
        
        console.log(`File URL: ${fileUrl}`);
        console.log(`Embed URL: ${embedUrl}`);
        
        res.json({
            success: true,
            url: embedUrl,
            fileUrl: fileUrl,
            filename: finalFileName,
            originalName: uploadInfo.fileName,
            size: stats.size,
            mimeType: mimeType
        });
        
    } catch (error) {
        console.error('Finalize error:', error);
        res.status(500).json({ error: 'Failed to finalize upload' });
    }
});

// Check upload status
app.get('/upload/status/:uploadId', requireApiKey, (req, res) => {
    const uploadId = req.params.uploadId;
    const uploadInfo = activeUploads.get(uploadId);
    
    if (!uploadInfo) {
        return res.status(404).json({ error: 'Upload not found' });
    }
    
    res.json({
        uploadId,
        fileName: uploadInfo.fileName,
        fileSize: uploadInfo.fileSize,
        totalChunks: uploadInfo.totalChunks,
        receivedChunks: uploadInfo.receivedChunks.size,
        progress: Math.round((uploadInfo.receivedChunks.size / uploadInfo.totalChunks) * 100),
        missingChunks: Array.from({ length: uploadInfo.totalChunks }, (_, i) => i)
            .filter(i => !uploadInfo.receivedChunks.has(i))
    });
});

// Regular upload endpoint (for files < 100MB)
app.post('/upload', requireApiKey, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const fileUrl = `${DOMAIN}/files/${req.file.filename}`;
        const embedUrl = `${DOMAIN}/e/${req.file.filename}`;
        
        console.log(`\n📁 File uploaded: ${req.file.originalname} -> ${req.file.filename}`);
        console.log(`   Size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`   URL: ${embedUrl}`);
        
        res.json({
            success: true,
            url: embedUrl,
            fileUrl: fileUrl,
            filename: req.file.filename,
            originalName: req.file.originalname,
            size: req.file.size,
            mimeType: req.file.mimetype
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Embed page for Discord
app.get('/e/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(uploadsDir, filename);
        
        try {
            await fs.access(filePath);
        } catch (error) {
            return res.status(404).send('File not found');
        }
        
        const ext = path.extname(filename).toLowerCase();
        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        const fileUrl = `${DOMAIN}/files/${filename}`;
        
        const isVideo = mimeType.startsWith('video/');
        const isImage = mimeType.startsWith('image/');
        const isAudio = mimeType.startsWith('audio/');
        
        const stats = await fs.stat(filePath);
        const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
        const displayName = filename;
        
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${displayName}</title>
    
    <meta property="og:type" content="${isVideo ? 'video.other' : isImage ? 'website' : 'website'}">
    <meta property="og:title" content="${displayName}">
    <meta property="og:description" content="Uploaded file - ${fileSizeMB} MB">
    <meta property="og:url" content="${DOMAIN}/e/${filename}">
    <meta property="og:site_name" content="File Server">
    
    ${isVideo ? `
    <meta property="og:video" content="${fileUrl}">
    <meta property="og:video:secure_url" content="${fileUrl}">
    <meta property="og:video:type" content="${mimeType}">
    <meta property="og:video:width" content="1280">
    <meta property="og:video:height" content="720">
    ` : ''}
    
    ${isImage ? `
    <meta property="og:image" content="${fileUrl}">
    <meta property="og:image:secure_url" content="${fileUrl}">
    <meta property="og:image:type" content="${mimeType}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    ` : ''}
    
    <meta name="twitter:card" content="${isVideo ? 'player' : isImage ? 'summary_large_image' : 'summary'}">
    <meta name="twitter:title" content="${displayName}">
    <meta name="twitter:description" content="${fileSizeMB} MB">
    ${isVideo ? `<meta name="twitter:player" content="${fileUrl}">` : ''}
    ${isImage ? `<meta name="twitter:image" content="${fileUrl}">` : ''}
    
    <meta name="theme-color" content="#5865f2">
    
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            width: 100%;
            background: rgba(255, 255, 255, 0.95);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
        }
        h1 { color: #5865f2; margin-bottom: 20px; word-wrap: break-word; }
        .info { color: #666; margin-bottom: 30px; font-size: 18px; }
        .media-container { margin: 30px 0; border-radius: 12px; overflow: hidden; background: #000; }
        video, img, audio { max-width: 100%; height: auto; display: block; }
        video, audio { width: 100%; }
        .download-btn {
            display: inline-block;
            padding: 15px 40px;
            background: #5865f2;
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: 600;
            font-size: 18px;
            transition: all 0.3s;
            margin: 10px;
        }
        .download-btn:hover {
            background: #4752c4;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(88, 101, 242, 0.4);
        }
        .direct-link {
            margin-top: 20px;
            padding: 15px;
            background: #f0f0f0;
            border-radius: 8px;
            font-family: monospace;
            font-size: 14px;
            word-wrap: break-word;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📁 ${displayName}</h1>
        <div class="info">Size: ${fileSizeMB} MB • Type: ${mimeType.split('/')[0]}</div>
        
        <div class="media-container">
            ${isVideo ? `
                <video controls autoplay muted loop>
                    <source src="${fileUrl}" type="${mimeType}">
                    Your browser does not support the video tag.
                </video>
            ` : isImage ? `
                <img src="${fileUrl}" alt="${displayName}">
            ` : isAudio ? `
                <audio controls autoplay>
                    <source src="${fileUrl}" type="${mimeType}">
                    Your browser does not support the audio tag.
                </audio>
            ` : `
                <div style="padding: 40px; color: white;">
                    <p style="font-size: 48px; margin-bottom: 20px;">📄</p>
                    <p>Click download to get this file</p>
                </div>
            `}
        </div>
        
        <a href="${fileUrl}" download="${displayName}" class="download-btn">⬇️ Download File</a>
        <a href="${fileUrl}" target="_blank" class="download-btn" style="background: #43b581;">🔗 Open Direct Link</a>
    </div>
</body>
</html>`;
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
        
    } catch (error) {
        console.error('Error serving embed page:', error);
        res.status(500).send('Error loading file');
    }
});

// Serve uploaded files
app.get('/files/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(uploadsDir, filename);
        
        try {
            await fs.access(filePath);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Accept-Ranges', 'bytes');
        
        const stat = await fs.stat(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;
        
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Content-Length', chunksize);
            
            const readStream = fsSync.createReadStream(filePath, { start, end });
            readStream.pipe(res);
        } else {
            res.setHeader('Content-Length', fileSize);
            const readStream = fsSync.createReadStream(filePath);
            readStream.pipe(res);
        }
        
    } catch (error) {
        console.error('Error serving file:', error);
        res.status(500).json({ error: 'Error serving file' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        activeUploads: activeUploads.size
    });
});

// List files
app.get('/api/files', requireApiKey, async (req, res) => {
    try {
        const files = await fs.readdir(uploadsDir);
        const fileStats = await Promise.all(
            files.map(async (filename) => {
                const filePath = path.join(uploadsDir, filename);
                const stats = await fs.stat(filePath);
                return {
                    filename,
                    size: stats.size,
                    created: stats.birthtime,
                    url: `${DOMAIN}/files/${filename}`,
                    mimeType: mime.lookup(filename) || 'application/octet-stream'
                };
            })
        );
        res.json({ files: fileStats });
    } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// Delete file
app.delete('/api/files/:filename', requireApiKey, async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(uploadsDir, filename);
        
        await fs.unlink(filePath);
        console.log(`File deleted: ${filename}`);
        
        res.json({ success: true, message: 'File deleted' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Cleanup stale uploads (every hour)
setInterval(async () => {
    const now = Date.now();
    const maxAge = 3600000; // 1 hour
    
    for (const [uploadId, info] of activeUploads.entries()) {
        if (now - info.lastActivity > maxAge) {
            console.log(`🧹 Cleaning up stale upload: ${uploadId}`);
            const chunksPath = path.join(chunksDir, uploadId);
            await fs.rm(chunksPath, { recursive: true, force: true }).catch(() => {});
            activeUploads.delete(uploadId);
        }
    }
}, 3600000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Domain: ${DOMAIN}`);
    console.log(`Chunk size: ${(CHUNK_SIZE / 1024 / 1024).toFixed(0)} MB`);
    console.log(`\n📦 Chunked uploads enabled for files > 100MB`);
    console.log(`   • Cloudflare-friendly (< 100 second per chunk)`);
    console.log(`   • Automatic chunk assembly`);
    console.log(`   • Resume support\n`);
    
    startAutomaticCleanup();
});

// File retention cleanup
async function startAutomaticCleanup() {
    console.log('🧹 Starting automatic file cleanup...');
    await cleanupOldFiles();
    setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000);
}

async function cleanupOldFiles() {
    try {
        console.log(`\n🧹 [${new Date().toISOString()}] Running cleanup...`);
        
        const files = await fs.readdir(uploadsDir);
        const now = Date.now();
        const maxAge = FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        
        let deletedCount = 0;
        let deletedSize = 0;
        
        for (const file of files) {
            try {
                const filePath = path.join(uploadsDir, file);
                const stats = await fs.stat(filePath);
                const fileAge = now - stats.mtime.getTime();
                
                if (fileAge > maxAge) {
                    await fs.unlink(filePath);
                    deletedCount++;
                    deletedSize += stats.size;
                }
            } catch (err) {}
        }
        
        if (deletedCount > 0) {
            const deletedSizeMB = (deletedSize / 1024 / 1024).toFixed(2);
            console.log(`✅ Deleted ${deletedCount} file(s), freed ${deletedSizeMB} MB`);
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}