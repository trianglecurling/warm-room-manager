# Setting Up Public Access to Status Endpoints

This guide walks you through exposing the `/status` and `/status-ws` endpoints to the internet while keeping all other endpoints private.

## Quick Start

### Step 1: Enable Access Restrictions

Add to your `.env` file:

```bash
ENABLE_PUBLIC_ACCESS_RESTRICTIONS=true
NODE_ENV=production
```

### Step 2: Configure Reverse Proxy

Set up a reverse proxy (nginx, Apache, etc.) to:
- Terminate SSL/TLS
- Forward requests to the orchestrator
- Set the `X-Forwarded-For` header

#### Nginx Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name streams.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/streams.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/streams.yourdomain.com/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        
        # Required: Forward client IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Timeouts for WebSocket
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name streams.yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

### Step 3: Configure Firewall

Ensure external traffic can reach your reverse proxy but NOT the orchestrator directly:

```bash
# Allow HTTPS traffic to reverse proxy
sudo ufw allow 443/tcp
sudo ufw allow 80/tcp

# Block direct external access to orchestrator port
# (only allow from localhost)
sudo ufw deny 8080/tcp
```

### Step 4: Start the Orchestrator

```bash
cd packages/streaming-orchestrator
npm run build
npm start
```

You should see:
```
🔒 Public access restrictions ENABLED
   Public HTTP endpoints: /status, /healthz
   Public WS paths: /status-ws
```

### Step 5: Test Access

#### Test Public Endpoint (Should Work)

```bash
# HTTP
curl https://streams.yourdomain.com/status

# WebSocket (using wscat: npm install -g wscat)
wscat -c wss://streams.yourdomain.com/status-ws
```

#### Test Private Endpoint (Should Get 403)

```bash
# This should return 403 Forbidden
curl https://streams.yourdomain.com/v1/agents

# This should also be rejected
wscat -c wss://streams.yourdomain.com/ui
```

#### Test Internal Access (Should Work)

From the same machine or local network:

```bash
# All endpoints should work
curl http://localhost:8080/status
curl http://localhost:8080/v1/agents
curl http://localhost:8080/v1/jobs
```

## Architecture

```
┌─────────────────┐
│  Internet       │
└────────┬────────┘
         │
         │ HTTPS (443)
         │
    ┌────▼─────────────────┐
    │  Reverse Proxy       │
    │  (nginx/Apache)      │
    │  - SSL Termination   │
    │  - Sets X-Fwd-For    │
    └────┬─────────────────┘
         │
         │ HTTP (8080)
         │ localhost only
         │
    ┌────▼─────────────────────────┐
    │  Streaming Orchestrator      │
    │                              │
    │  IP-Based Access Control:    │
    │  ✅ /status → Allow all      │
    │  ✅ /status-ws → Allow all   │
    │  ❌ /v1/* → Internal only    │
    │  ❌ /ui → Internal only      │
    └──────────────────────────────┘
```

## Environment Variables

```bash
# Required for public access restrictions
ENABLE_PUBLIC_ACCESS_RESTRICTIONS=true

# Recommended for production
NODE_ENV=production
PORT=8080
AGENT_TOKEN=your-secure-token-here

# YouTube credentials
YOUTUBE_CLIENT_ID=your-client-id
YOUTUBE_CLIENT_SECRET=your-client-secret
YOUTUBE_REFRESH_TOKEN=your-refresh-token
```

## Embedding the Status Feed

Once configured, you can embed the status in any website:

### JavaScript Example

```html
<!DOCTYPE html>
<html>
<head>
    <title>Live Streams</title>
</head>
<body>
    <div id="streams"></div>
    
    <script>
        const ws = new WebSocket('wss://streams.yourdomain.com/status-ws');
        
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'status.update') {
                displayStreams(data.payload.streams);
            }
        };
        
        function displayStreams(streams) {
            const container = document.getElementById('streams');
            container.innerHTML = streams.map(s => `
                <div>
                    <h3>${s.title}</h3>
                    <a href="${s.publicLink}">Watch Live</a>
                </div>
            `).join('');
        }
    </script>
</body>
</html>
```

### React Example

```jsx
import { useEffect, useState } from 'react';

function StreamStatus() {
  const [streams, setStreams] = useState([]);

  useEffect(() => {
    const ws = new WebSocket('wss://streams.yourdomain.com/status-ws');
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'status.update') {
        setStreams(data.payload.streams);
      }
    };

    return () => ws.close();
  }, []);

  return (
    <div>
      {streams.map((stream, i) => (
        <div key={i}>
          <h3>{stream.title}</h3>
          <p>{stream.team1} vs {stream.team2}</p>
          <a href={stream.publicLink}>Watch Live</a>
        </div>
      ))}
    </div>
  );
}
```

## Troubleshooting

### Issue: 403 errors on /status

**Cause:** Access restrictions are enabled but the orchestrator isn't receiving the real client IP.

**Fix:** Ensure your reverse proxy sets `X-Forwarded-For` or `X-Real-IP` headers.

### Issue: Internal services can't access private endpoints

**Cause:** Your internal network IP range isn't in the trusted list.

**Fix:** Check if your internal IPs are in these ranges:
- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`

If using a different range, modify the `isTrustedIP()` function in `src/index.ts`.

### Issue: WebSocket connections fail

**Cause:** Reverse proxy doesn't support WebSocket upgrades.

**Fix:** Add these headers to your proxy config:
```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

## Security Checklist

- [ ] `ENABLE_PUBLIC_ACCESS_RESTRICTIONS=true` in production
- [ ] Reverse proxy configured with SSL/TLS
- [ ] Firewall blocks direct access to port 8080
- [ ] Strong `AGENT_TOKEN` configured
- [ ] Reverse proxy sets `X-Forwarded-For` header
- [ ] Regular security updates applied
- [ ] Monitoring/logging enabled
- [ ] Access logs reviewed periodically

## Next Steps

- See [SECURITY.md](./SECURITY.md) for detailed security documentation
- See [example-status-client.html](./example-status-client.html) for a complete client example
- Configure monitoring and alerting for suspicious access attempts

