# Docker Deployment

Deploy Elapse on any server with Docker installed.

## Prerequisites

- Docker and Docker Compose installed
- A server with a public IP or domain
- Reverse proxy (nginx, Caddy, Traefik) for HTTPS

## Quick Start

```bash
# Clone the repository
git clone https://github.com/kdcokenny/elapse.git
cd elapse/deploy/docker

# Copy and configure environment variables
cp ../../.env.example .env
# Edit .env with your values

# Start Elapse
docker compose up -d
```

## Configuration

Edit your `.env` file with required values:

```bash
GOOGLE_GENERATIVE_AI_API_KEY=your-api-key
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

## Exposing to the Internet

Elapse needs to receive GitHub webhooks, so it must be accessible from the internet.

### Option 1: Reverse Proxy (Recommended)

Use nginx, Caddy, or Traefik to:
1. Handle HTTPS/TLS termination
2. Proxy requests to `localhost:3000`

Example nginx config:
```nginx
server {
    listen 443 ssl;
    server_name elapse.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Option 2: Direct Port Exposure

For testing only (not recommended for production):
```bash
# In compose.yml, the port is already exposed
ports:
  - "${PORT:-3000}:3000"
```

## GitHub App Setup

1. Start Elapse: `docker compose up -d`
2. Visit `https://your-domain.com`
3. Complete the GitHub App setup wizard
4. Copy the credentials to your `.env` file:
   ```bash
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY=base64-encoded-key
   GITHUB_WEBHOOK_SECRET=your-secret
   ```
5. Restart: `docker compose down && docker compose up -d`

## Updating

```bash
docker compose pull
docker compose down
docker compose up -d
```

## Logs

```bash
# View logs
docker compose logs -f elapse

# View Redis logs
docker compose logs -f redis
```

## Verifying Your Setup

Run the doctor command to verify all components are configured correctly:

```bash
docker compose exec -it elapse bun run doctor
```

This checks:
- **Redis connection** - Verifies Redis is reachable
- **Google Gemini AI** - Tests API key and model configuration
- **Discord webhook** - Sends a verification code and prompts you to confirm
- **GitHub App credentials** - Validates JWT generation

Example output:
```
Elapse Doctor
=============

[✓] Redis connection
    Connected to redis://redis:6379

[✓] Google Gemini AI
    API connected
    API key: AIzaSy...
    Model: gemini-flash-latest

[✓] Discord webhook
    Sending verification code to Discord...
    Enter the code you see in Discord: 123456
    Webhook verified!

[✓] GitHub App credentials
    Credentials valid
    App ID: 123456
    Private key: valid

---
4 passed
```

## Troubleshooting

### Redis Connection Issues
```bash
# Check Redis is running
docker compose ps redis

# Test Redis connection
docker compose exec redis redis-cli ping
```

### Webhook Not Receiving
- Verify your domain is accessible from the internet
- Check GitHub App webhook URL matches your domain
- Look for errors in logs: `docker compose logs -f elapse`
