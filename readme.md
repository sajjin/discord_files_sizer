# Discord File Upload System

**Bypass Discord's file size limits by hosting files on your private server!**

Upload files of **any size** to Discord and automatically store them on your own server. Bot creates beautiful rich embeds with download links.

---

## Features

- **Unlimited file sizes** - No Discord limits! (configurable, default 5GB)
- **Rich embeds** - Professional looking file cards in Discord
- **Dual upload methods** - Normal Discord upload OR `/upload` command
- **Image previews** - Thumbnails show inline
- **Video support** - One-click to view
- **Automatic cleanup** - Files auto-delete after 30 days (configurable)
- **Private server** - Your files, your control
- **Docker deployment** - Easy setup with Docker Compose
- **Apache Server** - Secure public access
- **Automatic processing** - Intercepts normal Discord uploads
- **Direct upload** - Web interface bypasses Discord entirely

---

## How It Works

### Method 1: Normal Discord Upload (Automatic)
```
User drags file to Discord → Bot intercepts → Uploads to YOUR server
→ Bot posts rich embed with download link → File stays on your server
```

### Method 2: `/upload` Command (Direct)
```
User types /upload → Bot sends private link → User uploads via web page
→ Bypasses Discord completely → Bot posts rich embed in channel
```

## Method A: if file is less than 100MB
The file will upload in whole all at once


## Method B: if file is more than 100MB
The file will be seperated into 50MB and sent in chunks and then reassebled by the server after a chunks received this is to get by the 100 second timer for cloudflares zero trust tunnel on the free tier.

---

## What You Get

### File Server
- Hosts your uploaded files
- Serves files with proper headers for Discord
- API for bot to upload files
- Health monitoring
- CORS enabled

### Discord Bot
- Intercepts file uploads
- Creates rich embeds
- `/upload` command for direct uploads
- Web interface for file uploads
- Automatic file processing

---

## Quick Start

### Prerequisites
- Server with Docker & Docker Compose
- Cloudflare account
- Discord bot
- Domain name

### Installation (5 minutes)

```bash
# 1. Configure Cloudflare tunnel hostnames
docker compose -f .\docker-compose.yml up -d

# 2. Run setup
docker compose -f .\docker-compose.yml up -d

# 3. Test in Discord
# Type: /upload
```

**That's it!**

---

## Project Structure

```
discord-file-server/
├── docker-compose.yml      # Docker orchestration
├── setup.sh                # Automated setup script
├── manage.sh               # Management tools
├── .env                    # Your configuration
│
├── server/                 # File server
│   ├── server.js
│   ├── package.json
│   └── Dockerfile
│
├── bot/                    # Discord bot
│   ├── bot.js
│   ├── package.json
│   └── Dockerfile
│
└── uploads/                # Your files stored here
```

---

## Usage Examples

### Upload via Discord (Automatic) currently not working

```
User: [Drags video.mp4 (500MB) to Discord]

Bot: (reaction)

Bot posts:
┌─────────────────────────┐
│ 🎬 video.mp4            │
│ [⬇️ Click to View]      │
│                         │
│ Type: Video             │
│ Size: 500 MB            │
│ 🔒 Private server       │
└─────────────────────────┘

Bot: ✅ (reaction)
```

### Upload via Command (Direct)

```
User: /upload

Bot: 🔗 Direct Upload Link
     https://upload.yourdomain.com/abc123
     Link expires in 15 minutes

User: [Opens link, uploads 2GB file]

Bot posts in channel:
┌─────────────────────────┐
│ 🎬 largefile.mp4        │
│ [⬇️ Click to View]      │
│                         │
│ Type: Video             │
│ Size: 2000 MB           │
│ 🔒 Private server       │
└─────────────────────────┘
```

---

### Quick Commands

```bash
# View logs
docker-compose logs -f

# Restart everything
docker-compose restart

# Check status
docker-compose ps

# Backup
tar -czf backup.tar.gz uploads/
```

---

## Configuration

### `.env` File

```env
# Required
API_KEY=your-generated-api-key
DISCORD_BOT_TOKEN=your-bot-token
DOMAIN=https://files.yourdomain.com
PUBLIC_UPLOAD_URL=https://upload.yourdomain.com
TUNNEL_TOKEN=your-cloudflare-token

# Optional
DELETE_ORIGINAL=false        # Delete Discord messages after processing
ADD_REACTION=true            # Add reaction emojis
MAX_FILE_SIZE=5000           # Max file size in MB
FILE_RETENTION_DAYS=30       # Auto-delete files after 30 days (0=never)
MONITORED_CHANNELS=          # Specific channels (empty = all)
MONITORED_USERS=             # Specific users (empty = all)
```

### Cloudflare Tunnel Setup

**Two public hostnames needed:**

1. **File Server** (`files.yourdomain.com`)
   - Service: `http://file-server:3000`

2. **Upload Page** (`upload.yourdomain.com`)
   - Service: `http://discord-bot:8080`

---

## Architecture

```
┌─────────────────┐
│   Discord User  │
└────────┬────────┘
         │
    [Upload File]
         │
         ▼
┌─────────────────┐       ┌──────────────────┐
│  Discord Bot    │◄─────►│  File Server     │
│  - Intercepts   │       │  - Stores files  │
│  - Creates      │       │  - Serves files  │
│    embeds       │       └────────┬─────────┘
│  - /upload cmd  │                │
└────────┬────────┘                │
         │                         │
         └────────────┬────────────┘
                      │
              ┌───────▼────────┐
              │   Cloudflare   │
              │     Tunnel     │
              │  (Zero Trust)  │
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │    Internet    │
              │  (Public URLs) │
              └────────────────┘
```

---

## Security Features

**Cloudflare Zero Trust** - No open ports, secure tunnels  
**API Key Authentication** - Secure file uploads  
**HTTPS Automatic** - Cloudflare provides SSL  
**DDoS Protection** - Cloudflare's network  
**Rate Limiting** - Built-in and configurable  
**Private Uploads** - `/upload` links are private  
**Token Expiration** - Upload links expire in 15 min  

---

## Use Cases

### Perfect For:

- **Large video files** - Share without compression
- **Game recordings** - High quality, no limits
- **Design files** - PSD, AI, large assets
- **Backups** - Share team backups
- **Media libraries** - High-res photos/videos
- **Educational content** - Course materials
- **Development** - Large builds, datasets
- **Any files** - Literally anything!

### Not Limited By:

- Discord's 25MB free limit
- Discord's 500MB Nitro limit
- Upload speed restrictions
- Storage quotas

### You Control:

- File size limits (default 5GB, configurable)
- Storage duration (your server, your rules)
- Who can upload (channel/user filters)
- What gets deleted (original messages)
- Everything!

---

## Performance

**Tested with:**
- 5GB files - Works perfectly
- Multiple simultaneous uploads
- Mobile uploads
- Desktop uploads

**Resource Usage:**
- CPU: Low (mostly idle)
- RAM: ~500MB total
- Disk: Your files + ~100MB system
- Network: Depends on usage

---

## Troubleshooting

### Bot Not Responding
```bash
# Check logs
docker-compose logs discord-bot

# Restart
docker-compose restart discord-bot
```

### Files Not Accessible
```bash
# Test file server
curl https://files.yourdomain.com/health

# Check tunnel
docker-compose logs cloudflared
```

### `/upload` Not Working
```bash
# Verify command registered
docker-compose logs discord-bot | grep "command registered"
```

**See [DEPLOYMENT.md](DEPLOYMENT.md) for complete troubleshooting guide.**

---

## Documentation

- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Complete setup guide
- **[.env.example](.env.example)** - Configuration reference
- **setup.sh** - Automated setup
- **manage.sh** - Management tools

---

## Updates

```bash
# Pull latest changes
git pull

# Rebuild
docker-compose up -d --build

# Or use management script
./manage.sh
# Select: Update and rebuild
```

---

## Backups

### Automatic Backups

```bash
# Add to crontab
crontab -e

# Daily backup at 2 AM
0 2 * * * cd /path/to/discord-file-server && tar -czf backups/upload_$(date +\%Y\%m\%d).tar.gz uploads/
```

---

## Contributing

Found a bug? Have a feature request? 

1. Check existing issues
2. Create a new issue with details
3. Or submit a pull request

---

## License

This project is open source and available for personal and commercial use.

---

## Show Your Support

If this project helped you bypass Discord's file limits, give it a star!

---

## Features Roadmap

- [x] Automatic upload interception
- [x] Rich embeds
- [x] `/upload` command
- [x] Direct upload web page
- [x] Cloudflare Zero Trust integration
- [x] Docker deployment
- [ ] Thumbnail generation for videos
- [ ] File compression options
- [ ] User upload quotas
- [ ] Upload analytics
- [ ] Multiple storage backends

---

**No more file size limits. Your files. Your server. Your control.**
