# Dokploy Deployment

Deploy Elapse on [Dokploy](https://dokploy.com), an open-source self-hosted PaaS.

## Prerequisites

- Dokploy installed on your server
- A domain pointed to your Dokploy server

## Quick Start

1. **Create a new project** in Dokploy

2. **Add a Compose service**:
   - Type: Docker Compose
   - Source: Git
   - Repository: `https://github.com/kdcokenny/elapse`
   - Branch: `main`
   - Compose file: `deploy/dokploy/compose.yml`

3. **Configure environment variables** in Dokploy:
   ```
   GOOGLE_GENERATIVE_AI_API_KEY=your-api-key
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```

4. **Configure domain**:
   - Add a domain in Dokploy's Domains tab
   - Point it to the `elapse` service on port `3000`

5. **Deploy**

## GitHub App Setup

1. After deployment, visit your Elapse URL
2. Complete the GitHub App setup wizard
3. Copy the credentials shown in the success page
4. Add them to Dokploy environment variables:
   ```
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY=<base64-encoded-key>
   GITHUB_WEBHOOK_SECRET=your-secret
   ```
5. Redeploy in Dokploy

The private key shown in the wizard is already base64-encoded for Docker compatibility.

## Why a Separate Compose File?

Dokploy uses Traefik for routing and requires `ports` instead of `expose` for proper service discovery. This compose file is configured specifically for Dokploy's requirements.

## Updating

In Dokploy:
1. Go to your Elapse service
2. Click "Redeploy"

Or enable auto-deploy from the Deployments tab.

## Verifying Your Setup

Run the doctor command to verify all components are configured correctly:

```bash
# From Dokploy terminal or SSH into your server
docker exec -it <elapse-container-name> bun run doctor
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

### Service Not Accessible
- Check domain configuration in Dokploy
- Verify Traefik is routing to the correct port (3000)
- Check service logs in Dokploy's Logs tab

### Redis Connection Failed
The Redis service is included in the compose file. If it fails:
- Check Redis container logs
- Verify the `elapse-network` network exists

### Webhook Errors
- Ensure your domain has valid HTTPS (Dokploy handles this via Traefik)
- Check the webhook URL in your GitHub App settings matches your Dokploy domain
