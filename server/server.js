const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const cors = require('cors');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 51424;
const API_KEY = process.env.API_KEY || 'your-secret-api-key';
const DOMAIN = process.env.DOMAIN || 'http://file-server';
const FILE_RETENTION_DAYS = parseInt(process.env.FILE_RETENTION_DAYS) || 30;

// Enable CORS for Discord embedding
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
    exposedHeaders: ['Content-Length', 'Content-Type']
}));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        // Generate unique ID but KEEP the original extension for Discord embedding
        const uniqueId = crypto.randomBytes(16).toString('hex');
        const ext = path.extname(file.originalname);
        // Format: uniqueid.ext (e.g., abc123.mp4)
        cb(null, `${uniqueId}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit
    },
    fileFilter: (req, file, cb) => {
        // Add any file type restrictions here if needed
        cb(null, true);
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

// Upload endpoint
app.post('/upload', requireApiKey, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // URL includes the file extension for Discord embedding
        const fileUrl = `${DOMAIN}/files/${req.file.filename}`;
        
        console.log(`File uploaded: ${req.file.originalname} -> ${req.file.filename}`);
        console.log(`Accessible at: ${fileUrl}`);
        console.log(`MIME type: ${req.file.mimetype}`);
        
        res.json({
            success: true,
            url: fileUrl,
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

// Serve uploaded files with proper headers for Discord embedding
app.get('/files/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(uploadsDir, filename);
        
        // Check if file exists
        try {
            await fs.access(filePath);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        // Get file extension and determine MIME type
        const ext = path.extname(filename).toLowerCase();
        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        
        console.log(`Serving file: ${filename} (${mimeType})`);
        
        // Set headers for Discord embedding
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', 'inline'); // Critical for embedding
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.setHeader('Accept-Ranges', 'bytes'); // Allow range requests for videos
        
        // Handle range requests for video seeking
        const stat = await fs.stat(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;
        
        if (range) {
            // Parse range header
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            
            res.status(206); // Partial Content
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Content-Length', chunksize);
            
            const readStream = require('fs').createReadStream(filePath, { start, end });
            readStream.pipe(res);
        } else {
            // Send entire file
            res.setHeader('Content-Length', fileSize);
            const readStream = require('fs').createReadStream(filePath);
            readStream.pipe(res);
        }
        
    } catch (error) {
        console.error('Error serving file:', error);
        res.status(500).json({ error: 'Error serving file' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// List files endpoint (protected)
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

// Delete file endpoint (protected)
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

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Domain: ${DOMAIN}`);
    console.log(`API Key: ${API_KEY.substring(0, 4)}...`);
    console.log(`\n📝 For Discord embedding to work:`);
    console.log(`   1. Files are served with proper MIME types`);
    console.log(`   2. Content-Disposition is set to 'inline'`);
    console.log(`   3. CORS is enabled`);
    console.log(`   4. Range requests supported for videos`);
    console.log(`   5. File extensions preserved in URLs`);
    console.log(`\n🗑️  File retention: ${FILE_RETENTION_DAYS} days`);
    console.log(`   Files older than ${FILE_RETENTION_DAYS} days will be automatically deleted`);
    
    // Start automatic cleanup
    startAutomaticCleanup();
});

// Automatic file cleanup
async function startAutomaticCleanup() {
    console.log('\n🧹 Starting automatic file cleanup service...');
    console.log(`   Checking every 24 hours`);
    console.log(`   Deleting files older than ${FILE_RETENTION_DAYS} days`);
    
    // Run cleanup immediately on startup
    await cleanupOldFiles();
    
    // Then run every 24 hours
    setInterval(async () => {
        await cleanupOldFiles();
    }, 24 * 60 * 60 * 1000); // 24 hours
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
                    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
                    await fs.unlink(filePath);
                    deletedCount++;
                    deletedSize += stats.size;
                    console.log(`   ✓ Deleted: ${file} (${fileSizeMB} MB, ${Math.floor(fileAge / (24 * 60 * 60 * 1000))} days old)`);
                }
            } catch (err) {
                console.error(`   ✗ Error processing ${file}:`, err.message);
            }
        }
        
        if (deletedCount > 0) {
            const deletedSizeMB = (deletedSize / 1024 / 1024).toFixed(2);
            console.log(`\n✅ Cleanup complete: Deleted ${deletedCount} file(s), freed ${deletedSizeMB} MB`);
        } else {
            console.log(`✅ Cleanup complete: No old files to delete`);
        }
        
        // Log remaining files
        const remainingFiles = await fs.readdir(uploadsDir);
        let totalSize = 0;
        for (const file of remainingFiles) {
            try {
                const stats = await fs.stat(path.join(uploadsDir, file));
                totalSize += stats.size;
            } catch (err) {
                // Ignore errors
            }
        }
        const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);
        console.log(`📊 Current storage: ${remainingFiles.length} files, ${totalSizeMB} MB total`);
        
    } catch (error) {
        console.error('❌ Cleanup error:', error);
    }
}