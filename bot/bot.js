const { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const multer = require('multer');

// Configuration
const config = {
    botToken: process.env.DISCORD_BOT_TOKEN,
    fileServerUrl: process.env.FILE_SERVER_URL || 'http://file-server:51424',
    apiKey: process.env.FILE_SERVER_API_KEY,
    uploadPort: process.env.UPLOAD_PORT || 8458,
    publicUploadUrl: process.env.PUBLIC_UPLOAD_URL || 'http://localhost:8458',

    monitoredChannels: process.env.MONITORED_CHANNELS?.split(',') || [],
    monitoredUsers: process.env.MONITORED_USERS?.split(',') || [],
    deleteOriginal: process.env.DELETE_ORIGINAL === 'true',
    addReaction: process.env.ADD_REACTION !== 'false',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 500
};

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
const upload = multer({
    dest: uploadDir,
    limits: {
        fileSize: config.maxFileSize * 1024 * 1024
    }
});

const uploadTokens = new Map();

// Health check endpoint
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

// Upload page
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
                h1 {
                    color: #5865f2;
                    margin-bottom: 10px;
                    font-size: 28px;
                }
                .info {
                    color: #666;
                    margin-bottom: 30px;
                    font-size: 14px;
                }
                .upload-area {
                    border: 3px dashed #ddd;
                    border-radius: 12px;
                    padding: 40px;
                    text-align: center;
                    margin-bottom: 20px;
                    cursor: pointer;
                    transition: all 0.3s;
                }
                .upload-area:hover {
                    border-color: #5865f2;
                    background: #f8f9ff;
                }
                .upload-area.dragover {
                    border-color: #5865f2;
                    background: #f0f2ff;
                }
                input[type="file"] { display: none; }
                .file-icon {
                    font-size: 48px;
                    margin-bottom: 10px;
                }
                .upload-text {
                    color: #333;
                    font-size: 16px;
                    margin-bottom: 5px;
                }
                .upload-hint {
                    color: #999;
                    font-size: 13px;
                }
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
                .file-name {
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .file-size {
                    color: #999;
                    font-size: 12px;
                    margin-left: 10px;
                }
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
                button:hover:not(:disabled) {
                    background: #4752c4;
                    transform: translateY(-2px);
                }
                button:disabled {
                    background: #ccc;
                    cursor: not-allowed;
                }
                .progress {
                    display: none;
                    margin-top: 20px;
                }
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
                .status {
                    margin-top: 10px;
                    text-align: center;
                    color: #666;
                }
                .success {
                    color: #43b581;
                    font-weight: 600;
                }
                .error {
                    color: #f04747;
                    font-weight: 600;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📎 Upload Files</h1>
                <div class="info">
                    Channel: <strong>${uploadInfo.channelName}</strong><br>
                    Max size: ${config.maxFileSize}MB per file<br>
                    <strong>⚡ No Discord limits!</strong>
                </div>
                
                <form id="uploadForm">
                    <div class="upload-area" id="uploadArea">
                        <div class="file-icon">📁</div>
                        <div class="upload-text">Click to select files</div>
                        <div class="upload-hint">or drag and drop here</div>
                    </div>
                    <input type="file" id="fileInput" multiple>
                    
                    <div class="selected-files" id="selectedFiles"></div>
                    
                    <button type="submit" id="uploadBtn">Upload to Your Server</button>
                </form>
                
                <div class="progress" id="progress">
                    <div class="progress-bar">
                        <div class="progress-fill" id="progressFill"></div>
                    </div>
                    <div class="status" id="status">Uploading...</div>
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
                    selectedFiles.innerHTML = files.map(file => \`
                        <div class="file-item">
                            <span class="file-name">\${file.name}</span>
                            <span class="file-size">\${(file.size / 1024 / 1024).toFixed(2)} MB</span>
                        </div>
                    \`).join('');
                }
                
                uploadForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    
                    if (fileInput.files.length === 0) {
                        alert('Please select files to upload');
                        return;
                    }
                    
                    const formData = new FormData();
                    Array.from(fileInput.files).forEach(file => {
                        formData.append('files', file);
                    });
                    
                    uploadBtn.disabled = true;
                    progress.style.display = 'block';
                    
                    try {
                        const response = await fetch('/upload/${token}/submit', {
                            method: 'POST',
                            body: formData
                        });
                        
                        const result = await response.json();
                        
                        progressFill.style.width = '100%';
                        
                        if (result.success) {
                            status.textContent = '✅ Files uploaded successfully!';
                            status.className = 'status success';
                            setTimeout(() => {
                                window.close();
                            }, 2000);
                        } else {
                            status.textContent = '❌ ' + result.error;
                            status.className = 'status error';
                            uploadBtn.disabled = false;
                        }
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

// Handle upload submission
app.post('/upload/:token/submit', upload.array('files'), async (req, res) => {
    const token = req.params.token;
    const uploadInfo = uploadTokens.get(token);
    
    if (!uploadInfo) {
        return res.status(404).json({ success: false, error: 'Invalid or expired token' });
    }
    
    try {
        const uploadedFiles = [];
        
        for (const file of req.files) {
            const fileData = await uploadToPrivateServer(file.path, file.originalname);
            uploadedFiles.push({
                url: fileData.url,
                name: file.originalname,
                size: file.size,
                mimeType: fileData.mimeType
            });
            await fs.unlink(file.path).catch(() => {});
        }
        
        // Send to Discord with rich embeds
        const channel = await client.channels.fetch(uploadInfo.channelId);
        await sendFilesToDiscord(channel, uploadedFiles, []);
        
        uploadTokens.delete(token);
        
        res.json({ success: true, files: uploadedFiles.length });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bot ready
client.once('ready', async () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log(`📡 Rich embeds enabled - bypassing Discord limits!`);
    console.log(`🔧 File server: ${config.fileServerUrl}`);
    
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
    app.listen(config.uploadPort, '0.0.0.0', () => {
        console.log(`✅ Upload server running on port ${config.uploadPort}`);
        console.log(`📡 Public URL: ${config.publicUploadUrl}`);
        console.log(`🔗 Listening on: 0.0.0.0:${config.uploadPort}`);
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
            content: `🔗 **Direct Upload Link**\n\nUpload files up to ${config.maxFileSize}MB each:\n${uploadUrl}\n\n_Link expires in 15 minutes_`,
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
                
                console.log(`📤 Uploading to private server`);
                const fileData = await uploadToPrivateServer(tempFilePath, attachment.name);
                
                uploadedFiles.push({
                    url: fileData.url,
                    name: attachment.name,
                    size: attachment.size,
                    mimeType: fileData.mimeType
                });
                
                console.log(`✅ Uploaded: ${fileData.url}`);
                
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
            await sendFilesToDiscord(message.channel, uploadedFiles, errors);
            
            if (config.deleteOriginal && message.deletable) {
                setTimeout(() => {
                    message.delete().catch(err => 
                        console.error('Could not delete original message:', err.message)
                    );
                }, 2000);
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
    // Create rich embeds for each file
    for (const file of files) {
        const isVideo = file.mimeType.startsWith('video/');
        const isImage = file.mimeType.startsWith('image/');
        const isAudio = file.mimeType.startsWith('audio/');
        
        const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
        
        let emoji = '📄';
        let typeLabel = 'File';
        if (isVideo) { emoji = '🎬'; typeLabel = 'Video'; }
        else if (isImage) { emoji = '🖼️'; typeLabel = 'Image'; }
        else if (isAudio) { emoji = '🎵'; typeLabel = 'Audio'; }
        
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`${emoji} ${file.name}`)
            .setURL(file.url)
            .setDescription(`**[⬇️ Click to Download/View](${file.url})**`)
            .addFields(
                { name: 'Type', value: typeLabel, inline: true },
                { name: 'Size', value: `${fileSizeMB} MB`, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: '🔒 Hosted on your private server • No Discord limits' });
        
        if (isImage) {
            embed.setImage(file.url);
        }
        
        await channel.send({ embeds: [embed] });
    }
    
    if (files.length > 1) {
        const totalSizeMB = (files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(2);
        await channel.send(
            `✅ **${files.length} files uploaded!** Total: ${totalSizeMB} MB`
        );
    }
    
    if (errors.length > 0) {
        await channel.send(`⚠️ **Some files failed:**\n${errors.join('\n')}`);
    }
}

async function downloadFile(url, filePath) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    
    const writer = require('fs').createWriteStream(filePath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function uploadToPrivateServer(filePath, originalName) {
    const form = new FormData();
    form.append('file', require('fs').createReadStream(filePath), originalName);
    
    const response = await axios.post(`${config.fileServerUrl}/upload`, form, {
        headers: {
            ...form.getHeaders(),
            'X-API-Key': config.apiKey
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });
    
    if (!response.data || !response.data.url) {
        throw new Error('Server did not return a URL');
    }
    
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