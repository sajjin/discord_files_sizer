const { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const http = require('http');
const https = require('https');
const { google } = require('googleapis');

// Configuration
const config = {
    botToken: process.env.DISCORD_BOT_TOKEN,
    fileServerUrl: process.env.FILE_SERVER_URL || 'http://file-server:51424',
    apiKey: process.env.FILE_SERVER_API_KEY,
    uploadPort: process.env.UPLOAD_PORT || 8458,
    publicUploadUrl: process.env.PUBLIC_UPLOAD_URL || 'http://localhost:8458',
    
    chunkSize: 50 * 1024 * 1024, // 50MB chunks (safe for Cloudflare)
    chunkThreshold: 100 * 1024 * 1024, // Use chunks for files > 100MB
    
    monitoredChannels: process.env.MONITORED_CHANNELS?.split(',') || [],
    monitoredUsers: process.env.MONITORED_USERS?.split(',') || [],
    deleteOriginal: process.env.DELETE_ORIGINAL === 'true',
    addReaction: process.env.ADD_REACTION !== 'false',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 5000,

    youtubeEnabled: process.env.YOUTUBE_UPLOAD_ENABLED === 'true',
    youtubeClientId: process.env.YOUTUBE_CLIENT_ID,
    youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    youtubeRefreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
    youtubePrivacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || 'unlisted',
    youtubeCategoryId: process.env.YOUTUBE_CATEGORY_ID || '22'
};

const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.mpeg', '.mpg', '.3gp'
]);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message]
});

const tempDir = path.join(__dirname, 'temp');
const uploadDir = path.join(__dirname, 'direct-uploads');

// Web server for direct uploads
const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Upload-ID, X-Chunk-Index, X-Total-Chunks');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

app.use((req, res, next) => {
    req.setTimeout(300000); // 5 minutes
    res.setTimeout(300000);
    next();
});

const upload = multer({
    dest: uploadDir,
    limits: {
        fileSize: 10 * 1024 * 1024 * 1024, // 10GB
        fieldSize: 10 * 1024 * 1024 * 1024
    }
});

const uploadTokens = new Map();
const pluginUploads = new Map();

const getPluginUploaderName = (payloadName) => {
    if (typeof payloadName !== 'string') return 'Plugin Upload';
    const trimmed = payloadName.trim();
    return trimmed || 'Plugin Upload';
};

const requireApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || apiKey !== config.apiKey) {
        return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    }

    next();
};

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        botReady: client.isReady()
    });
});

// Initialize
async function init() {
    try {
        await fs.mkdir(tempDir, { recursive: true });
        await fs.mkdir(uploadDir, { recursive: true });
        console.log('✅ Directories created');
    } catch (error) {
        console.error('Error creating directories:', error);
    }
}

// Upload page with chunked upload support
app.get('/upload/:token', (req, res) => {
    const token = req.params.token;
    const uploadInfo = uploadTokens.get(token);
    
    if (!uploadInfo) {
        return res.status(404).send('Invalid or expired upload link');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Upload Files</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Arial, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .container {
                    background: white;
                    border-radius: 16px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    padding: 40px;
                    max-width: 500px;
                    width: 100%;
                }
                h1 { color: #5865f2; margin-bottom: 10px; font-size: 28px; }
                .info { color: #666; margin-bottom: 30px; font-size: 14px; }
                .upload-area {
                    border: 3px dashed #ddd;
                    border-radius: 12px;
                    padding: 40px;
                    text-align: center;
                    margin-bottom: 20px;
                    cursor: pointer;
                    transition: all 0.3s;
                }
                .upload-area:hover { border-color: #5865f2; background: #f8f9ff; }
                .upload-area.dragover { border-color: #5865f2; background: #f0f2ff; }
                input[type="file"] { display: none; }
                .file-icon { font-size: 48px; margin-bottom: 10px; }
                .upload-text { color: #333; font-size: 16px; margin-bottom: 5px; }
                .upload-hint { color: #999; font-size: 13px; }
                .selected-files {
                    margin: 20px 0;
                    padding: 15px;
                    background: #f5f5f5;
                    border-radius: 8px;
                    display: none;
                }
                .file-item {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 8px 0;
                    border-bottom: 1px solid #ddd;
                }
                .file-item:last-child { border-bottom: none; }
                .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .file-size { color: #999; font-size: 12px; margin-left: 10px; }
                button {
                    width: 100%;
                    padding: 15px;
                    background: #5865f2;
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 16px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                }
                button:hover:not(:disabled) { background: #4752c4; transform: translateY(-2px); }
                button:disabled { background: #ccc; cursor: not-allowed; }
                .progress { display: none; margin-top: 20px; }
                .progress-bar {
                    width: 100%;
                    height: 8px;
                    background: #e0e0e0;
                    border-radius: 4px;
                    overflow: hidden;
                }
                .progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #5865f2, #764ba2);
                    width: 0%;
                    transition: width 0.3s;
                }
                .status { margin-top: 10px; text-align: center; color: #666; }
                .success { color: #43b581; font-weight: 600; }
                .error { color: #f04747; font-weight: 600; }
                .chunk-info {
                    margin-top: 5px;
                    font-size: 12px;
                    color: #999;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📤 Upload Files</h1>
                <div class="info">
                    Channel: <strong>${uploadInfo.channelName}</strong><br>
                    Max size: ${config.maxFileSize}MB per file<br>
                    <strong>⏰ Takes approximately 1-2 minutes per file</strong>
                </div>
                
                <form id="uploadForm">
                    <div class="upload-area" id="uploadArea">
                        <div class="file-icon">📁</div>
                        <div class="upload-text">Click to select files</div>
                        <div class="upload-hint">or drag and drop here</div>
                    </div>
                    <input type="file" id="fileInput" multiple>
                    
                    <div class="selected-files" id="selectedFiles"></div>
                    
                    <button type="submit" id="uploadBtn">Upload Files</button>
                </form>
                
                <div class="progress" id="progress">
                    <div class="progress-bar">
                        <div class="progress-fill" id="progressFill"></div>
                    </div>
                    <div class="status" id="status">Uploading...</div>
                    <div class="chunk-info" id="chunkInfo"></div>
                </div>
            </div>

            <script>
                const uploadArea = document.getElementById('uploadArea');
                const fileInput = document.getElementById('fileInput');
                const selectedFiles = document.getElementById('selectedFiles');
                const uploadForm = document.getElementById('uploadForm');
                const uploadBtn = document.getElementById('uploadBtn');
                const progress = document.getElementById('progress');
                const progressFill = document.getElementById('progressFill');
                const status = document.getElementById('status');
                const chunkInfo = document.getElementById('chunkInfo');
                
                const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB
                const CHUNK_THRESHOLD = 100 * 1024 * 1024; // 100MB

                uploadArea.addEventListener('click', () => fileInput.click());
                
                uploadArea.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    uploadArea.classList.add('dragover');
                });
                
                uploadArea.addEventListener('dragleave', () => {
                    uploadArea.classList.remove('dragover');
                });
                
                uploadArea.addEventListener('drop', (e) => {
                    e.preventDefault();
                    uploadArea.classList.remove('dragover');
                    fileInput.files = e.dataTransfer.files;
                    displayFiles();
                });
                
                fileInput.addEventListener('change', displayFiles);
                
                function displayFiles() {
                    const files = Array.from(fileInput.files);
                    if (files.length === 0) return;
                    
                    selectedFiles.style.display = 'block';
                    selectedFiles.innerHTML = files.map(file => {
                        const sizeMB = (file.size / 1024 / 1024).toFixed(2);
                        const chunked = file.size > CHUNK_THRESHOLD;
                        return \`
                            <div class="file-item">
                                <span class="file-name">\${file.name} \${chunked ? '📦' : ''}</span>
                                <span class="file-size">\${sizeMB} MB</span>
                            </div>
                        \`;
                    }).join('');
                }
                
                async function uploadChunked(file) {
                    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                    
                    status.textContent = \`Initializing chunked upload...\`;
                    
                    // Initialize upload
                    const initResponse = await fetch('/upload/${token}/init', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fileName: file.name,
                            fileSize: file.size,
                            totalChunks: totalChunks
                        })
                    });
                    
                    const { uploadId } = await initResponse.json();
                    
                    // Upload chunks
                    for (let i = 0; i < totalChunks; i++) {
                        const start = i * CHUNK_SIZE;
                        const end = Math.min(start + CHUNK_SIZE, file.size);
                        const chunk = file.slice(start, end);
                        
                        const formData = new FormData();
                        formData.append('chunk', chunk);
                        
                        status.textContent = \`Uploading \${file.name}...\`;
                        chunkInfo.textContent = \`Chunk \${i + 1}/\${totalChunks}\`;
                        
                        const chunkResponse = await fetch('/upload/${token}/chunk', {
                            method: 'POST',
                            body: formData,
                            headers: {
                                'X-Upload-ID': uploadId,
                                'X-Chunk-Index': i,
                                'X-Total-Chunks': totalChunks
                            }
                        });
                        
                        const chunkResult = await chunkResponse.json();
                        progressFill.style.width = \`\${chunkResult.progress}%\`;
                    }
                    
                    // Finalize
                    status.textContent = \`Assembling file...\`;
                    chunkInfo.textContent = 'Merging chunks...';
                    
                    const finalizeResponse = await fetch('/upload/${token}/finalize', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ uploadId })
                    });
                    
                    return await finalizeResponse.json();
                }
                
                async function uploadRegular(file) {
                    const formData = new FormData();
                    formData.append('file', file);
                    
                    const response = await fetch('/upload/${token}/submit-regular', {
                        method: 'POST',
                        body: formData
                    });
                    
                    return await response.json();
                }
                
                uploadForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    
                    if (fileInput.files.length === 0) {
                        alert('Please select files to upload');
                        return;
                    }
                    
                    uploadBtn.disabled = true;
                    progress.style.display = 'block';
                    
                    try {
                        const files = Array.from(fileInput.files);
                        
                        for (let i = 0; i < files.length; i++) {
                            const file = files[i];
                            status.textContent = \`Uploading \${file.name} (\${i + 1}/\${files.length})...\`;
                            
                            if (file.size > CHUNK_THRESHOLD) {
                                await uploadChunked(file);
                            } else {
                                await uploadRegular(file);
                            }
                            
                            const fileProgress = ((i + 1) / files.length) * 100;
                            progressFill.style.width = \`\${fileProgress}%\`;
                        }
                        
                        status.textContent = '✅ All files uploaded successfully!';
                        status.className = 'status success';
                        chunkInfo.textContent = '';
                        
                        setTimeout(() => window.close(), 2000);
                    } catch (error) {
                        status.textContent = '❌ Upload failed: ' + error.message;
                        status.className = 'status error';
                        uploadBtn.disabled = false;
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// Handle chunked upload initialization
app.post('/plugin-upload/init', requireApiKey, async (req, res) => {
    try {
        const response = await axios.post(`${config.fileServerUrl}/upload/init`, req.body, {
            headers: {
                'X-API-Key': config.apiKey,
                'Content-Type': 'application/json'
            }
        });

        const uploadId = response.data?.uploadId;
        if (uploadId) {
            pluginUploads.set(uploadId, {
                originalName: req.body?.fileName,
                uploaderName: getPluginUploaderName(req.body?.uploaderName),
                createdAt: Date.now()
            });
        }

        res.json(response.data);
    } catch (error) {
        console.error('Plugin init error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/plugin-upload/chunk', requireApiKey, upload.single('chunk'), async (req, res) => {
    try {
        const form = new FormData();
        form.append('chunk', fsSync.createReadStream(req.file.path));

        const response = await axios.post(`${config.fileServerUrl}/upload/chunk`, form, {
            headers: {
                ...form.getHeaders(),
                'X-API-Key': config.apiKey,
                'X-Upload-ID': req.headers['x-upload-id'],
                'X-Chunk-Index': req.headers['x-chunk-index'],
                'X-Total-Chunks': req.headers['x-total-chunks']
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        await fs.unlink(req.file.path).catch(() => {});
        res.json(response.data);
    } catch (error) {
        console.error('Plugin chunk error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/plugin-upload/finalize', requireApiKey, async (req, res) => {
    try {
        const response = await axios.post(`${config.fileServerUrl}/upload/finalize`, req.body, {
            headers: {
                'X-API-Key': config.apiKey,
                'Content-Type': 'application/json'
            }
        });

        const uploadId = req.body?.uploadId;
        const pluginUpload = uploadId ? pluginUploads.get(uploadId) : null;
        const fileInfo = await mapServerFinalizeResultToTarget(
            response.data,
            pluginUpload?.uploaderName || 'Plugin Upload'
        );

        if (uploadId) {
            pluginUploads.delete(uploadId);
        }

        res.json({
            success: true,
            ...fileInfo
        });
    } catch (error) {
        console.error('Plugin finalize error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/plugin-upload', requireApiKey, upload.single('file'), async (req, res) => {
    try {
        const uploaderName = getPluginUploaderName(req.body?.uploaderName);
        const fileData = await uploadFileWithRouting(
            req.file.path,
            req.file.originalname,
            req.file.size,
            uploaderName
        );

        await fs.unlink(req.file.path).catch(() => {});

        res.json({
            success: true,
            ...fileData
        });
    } catch (error) {
        console.error('Plugin upload error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/upload/:token/init', async (req, res) => {
    const token = req.params.token;
    const uploadInfo = uploadTokens.get(token);
    
    if (!uploadInfo) {
        return res.status(404).json({ success: false, error: 'Invalid token' });
    }
    
    try {
        const response = await axios.post(`${config.fileServerUrl}/upload/init`, req.body, {
            headers: {
                'X-API-Key': config.apiKey,
                'Content-Type': 'application/json'
            }
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Init error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Handle chunk upload
app.post('/upload/:token/chunk', upload.single('chunk'), async (req, res) => {
    const token = req.params.token;
    const uploadInfo = uploadTokens.get(token);
    
    if (!uploadInfo) {
        return res.status(404).json({ success: false, error: 'Invalid token' });
    }
    
    try {
        const form = new FormData();
        form.append('chunk', fsSync.createReadStream(req.file.path));
        
        const response = await axios.post(`${config.fileServerUrl}/upload/chunk`, form, {
            headers: {
                ...form.getHeaders(),
                'X-API-Key': config.apiKey,
                'X-Upload-ID': req.headers['x-upload-id'],
                'X-Chunk-Index': req.headers['x-chunk-index'],
                'X-Total-Chunks': req.headers['x-total-chunks']
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        // Clean up temp file
        await fs.unlink(req.file.path).catch(() => {});
        
        res.json(response.data);
    } catch (error) {
        console.error('Chunk error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Handle finalization
app.post('/upload/:token/finalize', async (req, res) => {
    const token = req.params.token;
    const uploadInfo = uploadTokens.get(token);
    
    if (!uploadInfo) {
        return res.status(404).json({ success: false, error: 'Invalid token' });
    }
    
    try {
        console.log(`🔗 Finalizing chunked upload...`);
        const response = await axios.post(`${config.fileServerUrl}/upload/finalize`, req.body, {
            headers: {
                'X-API-Key': config.apiKey,
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`✅ Server finalized upload successfully`);
        console.log(`📋 Server response:`, JSON.stringify(response.data, null, 2));
        
        // Send to Discord
        const channel = await client.channels.fetch(uploadInfo.channelId);
        const user = await client.users.fetch(uploadInfo.userId).catch(() => null);
        const uploaderName = user ? user.tag : 'Unknown';
        const fileInfo = await mapServerFinalizeResultToTarget(response.data, uploaderName);

        console.log(`📨 Sending to Discord channel: ${uploadInfo.channelId}`);
        await sendFilesToDiscord(channel, [fileInfo], []);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Finalize error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Handle regular upload
app.post('/upload/:token/submit-regular', upload.single('file'), async (req, res) => {
    const token = req.params.token;
    const uploadInfo = uploadTokens.get(token);
    
    if (!uploadInfo) {
        return res.status(404).json({ success: false, error: 'Invalid token' });
    }
    
    try {
        console.log(`📤 Processing regular upload: ${req.file.originalname}`);
        const user = await client.users.fetch(uploadInfo.userId).catch(() => null);
        const uploaderName = user ? user.tag : 'Unknown';
        const fileData = await uploadFileWithRouting(req.file.path, req.file.originalname, req.file.size, uploaderName);
        await fs.unlink(req.file.path).catch(() => {});

        const fileInfo = {
            ...fileData,
            uploaderName
        };

        const channel = await client.channels.fetch(uploadInfo.channelId);
        await sendFilesToDiscord(channel, [fileInfo], []);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bot ready
client.once('clientReady', async () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log(`📦 Chunked uploads enabled for files > ${(config.chunkThreshold / 1024 / 1024).toFixed(0)}MB`);
    console.log(`🔧 File server: ${config.fileServerUrl}`);
    if (config.youtubeEnabled) {
        console.log('🎥 YouTube upload mode is enabled for video files');
    }
    
    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('upload')
            .setDescription('Get a direct upload link (bypass Discord limits)')
            .toJSON()
    ];
    
    const rest = new REST({ version: '10' }).setToken(config.botToken);
    
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('✅ /upload command registered');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
    
    // Start upload server
    const server = app.listen(config.uploadPort, '0.0.0.0', () => {
        console.log(`✅ Upload server running on port ${config.uploadPort}`);
        console.log(`🔗 Public URL: ${config.publicUploadUrl}`);
    });
    
    // Configure server socket settings for keep-alive
    server.keepAliveTimeout = 65000; // 65 seconds
    server.headersTimeout = 66000; // 66 seconds - must be > keepAliveTimeout
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('\n🔴 SIGTERM received, shutting down gracefully...');
        server.close(() => {
            console.log('✅ Server closed');
            client.destroy();
            process.exit(0);
        });
        // Force close after 30 seconds
        setTimeout(() => {
            console.error('❌ Forced shutdown');
            process.exit(1);
        }, 30000);
    });
    
    process.on('SIGINT', () => {
        console.log('\n🔴 SIGINT received, shutting down gracefully...');
        server.close(() => {
            console.log('✅ Server closed');
            client.destroy();
            process.exit(0);
        });
    });
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    if (interaction.commandName === 'upload') {
        const token = require('crypto').randomBytes(16).toString('hex');
        
        uploadTokens.set(token, {
            channelId: interaction.channelId,
            channelName: interaction.channel.name,
            userId: interaction.user.id,
            createdAt: Date.now()
        });
        
        setTimeout(() => uploadTokens.delete(token), 15 * 60 * 1000);
        
        const uploadUrl = `${config.publicUploadUrl}/upload/${token}`;
        
        await interaction.reply({
            content: `🔗 **Direct Upload Link**\n\nUpload files up to ${config.maxFileSize}MB each:\n${uploadUrl}\n\n_📦 Large files automatically use chunked uploads_\n_⏰ Link expires in 15 minutes_`,
            flags: 64
        });
    }
});

// Handle regular attachments
client.on('messageCreate', async (message) => {
    try {
        if (message.author.id === client.user.id) return;
        if (message.attachments.size === 0) return;
        
        if (config.monitoredChannels.length > 0 && 
            !config.monitoredChannels.includes(message.channel.id)) {
            return;
        }
        
        if (config.monitoredUsers.length > 0 && 
            !config.monitoredUsers.includes(message.author.id)) {
            return;
        }
        
        console.log(`\n📎 Processing ${message.attachments.size} attachment(s) from ${message.author.tag}`);
        
        if (config.addReaction) {
            await message.react('⏳').catch(() => {});
        }
        
        const uploadedFiles = [];
        const errors = [];
        
        for (const [, attachment] of message.attachments) {
            try {
                const fileSizeMB = attachment.size / 1024 / 1024;
                
                console.log(`📥 Downloading: ${attachment.name} (${fileSizeMB.toFixed(2)}MB)`);
                
                const tempFilePath = path.join(tempDir, `${Date.now()}_${attachment.name}`);
                await downloadFile(attachment.url, tempFilePath);
                
                const fileData = await uploadFileWithRouting(
                    tempFilePath,
                    attachment.name,
                    attachment.size,
                    message.author.tag
                );

                uploadedFiles.push(fileData);

                console.log(`✅ Uploaded: ${fileData.url || fileData.youtubeUrl || fileData.fileUrl}`);
                
                await fs.unlink(tempFilePath).catch(() => {});
                
            } catch (error) {
                console.error(`❌ Error processing ${attachment.name}:`, error.message);
                errors.push(`${attachment.name}: ${error.message}`);
            }
        }
        
        if (config.addReaction) {
            await message.reactions.removeAll().catch(() => {});
            if (uploadedFiles.length > 0) {
                await message.react('✅').catch(() => {});
            } else {
                await message.react('❌').catch(() => {});
            }
        }
        
        if (uploadedFiles.length > 0) {
            console.log(`\n📤 Sending ${uploadedFiles.length} file(s) to Discord...`);
            
            try {
                await sendFilesToDiscord(message.channel, uploadedFiles, errors, message.author.tag);
                
                if (config.deleteOriginal && message.deletable) {
                    setTimeout(() => {
                        message.delete().catch(err => 
                            console.error('Could not delete original:', err.message)
                        );
                    }, 2000);
                }
            } catch (sendError) {
                console.error('❌ Failed to send to Discord:', sendError);
                await message.reply('⚠️ Files uploaded but failed to post to Discord. Check bot logs.').catch(() => {});
            }
        } else if (errors.length > 0) {
            await message.reply(`❌ Failed to upload files:\n${errors.join('\n')}`);
        }
        
    } catch (error) {
        console.error('Error handling message:', error);
        await message.reply('❌ An error occurred while processing your files.').catch(() => {});
    }
});

async function sendFilesToDiscord(channel, files, errors) {
    try {
        console.log(`\n⏳ Waiting 2 minutes before posting to Discord...`);

        // Wait 2 minutes
        await new Promise(resolve => setTimeout(resolve, 120000));
        
        console.log(`💬 Sending to Discord channel: ${channel.name}`);
        console.log(`   Files to send: ${files.length}`);
        
        // Send each file URL with uploader name (automatically included in file object)
        for (const file of files) {
            console.log(`   📨 Sending URL for: ${file.name}`);
            const messageLines = [];

            if (file.uploaderName) {
                messageLines.push(`**Uploaded by:** ${file.uploaderName}`);
            }

            if (file.platform === 'youtube') {
                messageLines.push('Watch on YouTube:');
                messageLines.push(file.youtubeUrl || file.fileUrl || file.url);
            } else {
                const previewLink = file.url || file.previewUrl || file.fileUrl;
                const fullLink = file.fileUrl || file.url;

                if (file.previewUrl || file.url) {
                    messageLines.push('This is a preview:');
                    messageLines.push(previewLink);
                }

                if (fullLink) {
                    messageLines.push('Full version:');
                    messageLines.push(fullLink);
                }
            }

            const message = messageLines.join('\n');
            await channel.send(message);
            console.log(`   ✅ Sent URL for: ${file.name}`);
        }
        
        if (errors.length > 0) {
            await channel.send(`⚠️ **Some files failed:**\n${errors.join('\n')}`);
        }
        
        console.log(`✅ Successfully sent all URLs to Discord\n`);
    } catch (error) {
        console.error(`❌ Error sending to Discord:`, error);
        throw error;
    }
}

function isVideoFile(fileName, mimeType) {
    if (mimeType && String(mimeType).startsWith('video/')) {
        return true;
    }

    const ext = path.extname(fileName || '').toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
}

function buildYouTubeClient() {
    if (!config.youtubeClientId || !config.youtubeClientSecret || !config.youtubeRefreshToken) {
        throw new Error('YouTube upload is enabled but OAuth credentials are missing');
    }

    const oauth2Client = new google.auth.OAuth2(
        config.youtubeClientId,
        config.youtubeClientSecret,
        'https://developers.google.com/oauthplayground'
    );

    oauth2Client.setCredentials({
        refresh_token: config.youtubeRefreshToken
    });

    return google.youtube({ version: 'v3', auth: oauth2Client });
}

function buildYouTubeTitle(originalName) {
    const base = path.basename(originalName, path.extname(originalName));
    const cleaned = base.replace(/[\r\n\t]+/g, ' ').trim() || 'Discord Upload';
    return cleaned.slice(0, 100);
}

async function uploadVideoToYouTube(filePath, originalName, uploaderName) {
    const youtube = buildYouTubeClient();
    const stats = await fs.stat(filePath);
    const title = buildYouTubeTitle(originalName);
    const description = `Game clips by ${uploaderName || 'Unknown'} on ${new Date().toISOString()}.`;

    console.log(`🎥 Uploading video to YouTube: ${originalName}`);

    const response = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
            snippet: {
                title,
                description,
                categoryId: config.youtubeCategoryId
            },
            status: {
                privacyStatus: config.youtubePrivacyStatus,
                selfDeclaredMadeForKids: false
            }
        },
        media: {
            body: fsSync.createReadStream(filePath)
        }
    });

    const videoId = response?.data?.id;
    if (!videoId) {
        throw new Error('YouTube API did not return a video ID');
    }

    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const shortUrl = `https://youtu.be/${videoId}`;

    return {
        platform: 'youtube',
        youtubeUrl: watchUrl,
        url: shortUrl,
        fileUrl: watchUrl,
        previewUrl: null,
        name: originalName,
        size: stats.size,
        mimeType: 'video/youtube'
    };
}

async function deleteFromFileServer(filename) {
    if (!filename) return;

    await axios.delete(`${config.fileServerUrl}/api/files/${encodeURIComponent(filename)}`, {
        headers: {
            'X-API-Key': config.apiKey
        }
    });
}

function normalizeServerFileData(fileData, fallbackName, fallbackSize, uploaderName) {
    return {
        platform: 'file-server',
        url: fileData.url,
        fileUrl: fileData.fileUrl,
        previewUrl: fileData.previewUrl,
        name: fileData.originalName || fallbackName,
        size: fileData.size || fallbackSize,
        uploaderName,
        mimeType: fileData.mimeType
    };
}

async function mapServerFinalizeResultToTarget(serverData, uploaderName) {
    const sourceName = serverData.originalName || serverData.filename || 'uploaded-file';

    if (config.youtubeEnabled && isVideoFile(sourceName, serverData.mimeType)) {
        if (!serverData.fileUrl) {
            throw new Error('Expected fileUrl from server finalize response');
        }

        const tempYoutubePath = path.join(tempDir, `yt_${Date.now()}_${sourceName}`);
        await downloadFile(serverData.fileUrl, tempYoutubePath);

        try {
            const youtubeData = await uploadVideoToYouTube(tempYoutubePath, sourceName, uploaderName);
            youtubeData.uploaderName = uploaderName;
            await deleteFromFileServer(serverData.filename).catch(() => {});
            return youtubeData;
        } finally {
            await fs.unlink(tempYoutubePath).catch(() => {});
        }
    }

    return normalizeServerFileData(serverData, sourceName, serverData.size, uploaderName);
}

async function uploadFileWithRouting(filePath, originalName, fileSize, uploaderName) {
    if (config.youtubeEnabled && isVideoFile(originalName)) {
        return uploadVideoToYouTube(filePath, originalName, uploaderName);
    }

    console.log(`📤 Uploading to private server...`);

    let fileData;
    if (fileSize > config.chunkThreshold) {
        console.log(`📦 Using chunked upload (${Math.ceil(fileSize / config.chunkSize)} chunks)`);
        fileData = await uploadChunkedToServer(filePath, originalName, fileSize);
        console.log(`📋 Chunked upload response:`, JSON.stringify(fileData, null, 2));
    } else {
        fileData = await uploadToPrivateServer(filePath, originalName);
    }

    return normalizeServerFileData(fileData, originalName, fileSize, uploaderName);
}

async function downloadFile(url, filePath) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    
    const writer = fsSync.createWriteStream(filePath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function uploadChunkedToServer(filePath, originalName, fileSize) {
    console.log(`\n📦 uploadChunkedToServer called with:`);
    console.log(`   filePath: ${filePath}`);
    console.log(`   originalName: ${originalName}`);
    console.log(`   fileSize: ${fileSize}`);
    console.log(`   Types: ${typeof filePath}, ${typeof originalName}, ${typeof fileSize}`);
    console.log(`\n📦 Starting chunked upload`);
    console.log(`   File: ${originalName}`);
    console.log(`   Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    
    const totalChunks = Math.ceil(fileSize / config.chunkSize);
    console.log(`   Total chunks: ${totalChunks}`);
    
    try {
        // STEP 1: Initialize - CRITICAL: Create data object FIRST
        const initData = {
            fileName: originalName,
            fileSize: fileSize,
            totalChunks: totalChunks
        };
        
        console.log(`\n🔧 Initializing with data:`, JSON.stringify(initData));
        
        const initResponse = await axios.post(
            `${config.fileServerUrl}/upload/init`,
            initData,  // Data as second parameter
            {
                headers: {
                    'X-API-Key': config.apiKey,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log(`   Server response:`, JSON.stringify(initResponse.data));
        
        // Validate response
        if (!initResponse.data || !initResponse.data.uploadId) {
            throw new Error('No uploadId in response: ' + JSON.stringify(initResponse.data));
        }
        
        const uploadId = initResponse.data.uploadId;
        console.log(`   ✅ Upload ID: ${uploadId}\n`);
        
        // STEP 2: Upload chunks
        console.log(`🔧 Uploading chunks...`);
        const fileHandle = await fs.open(filePath, 'r');
        
        try {
            for (let i = 0; i < totalChunks; i++) {
                const start = i * config.chunkSize;
                const length = Math.min(config.chunkSize, fileSize - start);
                const buffer = Buffer.allocUnsafe(length);
                
                await fileHandle.read(buffer, 0, length, start);
                
                console.log(`   Uploading chunk ${i + 1}/${totalChunks}...`);
                
                // Retry logic for chunk uploads
                let chunkResponse;
                let retries = 0;
                const maxRetries = 3;
                
                while (retries < maxRetries) {
                    try {
                        const form = new FormData();
                        form.append('chunk', buffer, { filename: `chunk_${i}` });
                        
                        chunkResponse = await axios({
                            method: 'post',
                            url: `${config.fileServerUrl}/upload/chunk`,
                            headers: {
                                ...form.getHeaders(),
                                'X-API-Key': config.apiKey,
                                'X-Upload-ID': uploadId,
                                'X-Chunk-Index': String(i),
                                'X-Total-Chunks': String(totalChunks),
                                'Connection': 'keep-alive'
                            },
                            data: form,
                            maxContentLength: Infinity,
                            maxBodyLength: Infinity,
                            timeout: 600000,  // 10 minutes
                            httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 10000 }),
                            httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 10000 })
                        });
                        
                        if (!chunkResponse.data || !chunkResponse.data.success) {
                            throw new Error(`Chunk ${i} failed: ${JSON.stringify(chunkResponse.data)}`);
                        }
                        
                        console.log(`   ✓ Chunk ${i + 1}/${totalChunks} (${chunkResponse.data.progress}%)`);
                        break; // Success, exit retry loop
                    } catch (error) {
                        retries++;
                        if (retries >= maxRetries) {
                            throw new Error(`Chunk ${i} failed after ${maxRetries} retries: ${error.message}`);
                        }
                        console.warn(`   ⚠️  Chunk ${i + 1} failed, retrying (${retries}/${maxRetries})...`);
                        await new Promise(resolve => setTimeout(resolve, 2000 * retries)); // Exponential backoff
                    }
                }
            }
        } finally {
            await fileHandle.close();
        }
        
        // STEP 3: Finalize
        console.log(`\n🔧 Finalizing...`);
        
        const finalData = { uploadId: uploadId };
        console.log(`   Sending finalize with:`, JSON.stringify(finalData));
        
        const finalResponse = await axios({
            method: 'post',
            url: `${config.fileServerUrl}/upload/finalize`,
            headers: {
                'X-API-Key': config.apiKey,
                'Content-Type': 'application/json',
                'Connection': 'keep-alive'
            },
            data: finalData,
            timeout: 300000
        });
        
        console.log(`   Finalize response:`, JSON.stringify(finalResponse.data));
        
        if (!finalResponse.data || !finalResponse.data.success) {
            throw new Error('Finalize failed: ' + JSON.stringify(finalResponse.data));
        }
        
        console.log(`   ✅ Complete!\n`);
        return finalResponse.data;
        
    } catch (error) {
        console.error(`\n❌ Chunked upload failed for ${originalName}:`);
        console.error(`   Error: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Data: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
    }
}

async function uploadToPrivateServer(filePath, originalName) {
    const form = new FormData();
    form.append('file', fsSync.createReadStream(filePath), originalName);
    
    const response = await axios.post(`${config.fileServerUrl}/upload`, form, {
        headers: {
            ...form.getHeaders(),
            'X-API-Key': config.apiKey
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 300000
    });
    
    return response.data;
}

client.on('error', (error) => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    
    try {
        const files = await fs.readdir(tempDir);
        for (const file of files) {
            await fs.unlink(path.join(tempDir, file));
        }
        console.log('✅ Temp files cleaned up');
    } catch (error) {
        console.error('Error cleaning temp files:', error);
    }
    
    client.destroy();
    process.exit(0);
});

init().then(() => {
    client.login(config.botToken).catch((error) => {
        console.error('❌ Failed to login:', error.message);
        process.exit(1);
    });
});