# Deploying Elapse

Elapse requires **long-running processes** and **Redis** for webhook processing and scheduled reports.

## Supported Platforms

| Platform | Type | Redis | Guide |
|----------|------|-------|-------|
| [Docker](./docker/) | Self-hosted | Included | Any server with Docker |
| [Dokploy](./dokploy/) | Self-hosted PaaS | Included | Open-source Heroku alternative |

## Quick Start

1. Choose a platform from the table above
2. Copy `.env.example` to configure environment variables
3. Follow the platform-specific guide

## Environment Variables

All platforms use the same environment variables. See [`.env.example`](../.env.example) for the full list.

**Required:**
- `GOOGLE_GENERATIVE_AI_API_KEY` - Gemini API key
- `DISCORD_WEBHOOK_URL` - Discord webhook for reports

**GitHub App** (configured via setup wizard or manually):
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` (base64-encoded for Docker)
- `GITHUB_WEBHOOK_SECRET`

## First-Time Setup

1. Deploy Elapse without GitHub App credentials
2. Visit the deployed URL to see the setup wizard
3. Click "Create GitHub App" and follow the OAuth flow
4. Copy the credentials shown to your platform's environment variables
5. Redeploy

For Docker/Dokploy: The private key shown in the wizard is already base64-encoded for easy copy-paste.
