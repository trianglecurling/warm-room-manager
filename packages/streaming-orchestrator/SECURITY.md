# Security Configuration

## Public Access Restrictions

The streaming orchestrator supports IP-based access control to restrict which endpoints are accessible from the public internet vs. internal networks.

### Overview

When enabled, this security feature:
- **Allows** internal/trusted IPs to access ALL endpoints
- **Restricts** external IPs to only access designated public endpoints
- Works with reverse proxies that set `X-Forwarded-For` or `X-Real-IP` headers
- Protects sensitive administrative and agent endpoints from public access

### Configuration

Enable public access restrictions by setting the environment variable:

```bash
ENABLE_PUBLIC_ACCESS_RESTRICTIONS=true
```

### Public Endpoints

The following endpoints are accessible from any IP address (internal or external):

#### HTTP Endpoints
- `GET /status` - Returns JSON with current stream status
- `GET /healthz` - Health check endpoint

#### WebSocket Endpoints
- `ws://<host>/status-ws` - Real-time stream status updates

### Private Endpoints (Internal Only)

All other endpoints require access from a trusted IP:

#### HTTP Endpoints (Examples)
- `GET /v1/agents` - Agent management
- `GET /v1/jobs` - Job management
- `POST /v1/jobs` - Create new jobs
- `PUT /v1/teamnames` - Update team names
- `GET /oauth/*` - OAuth management
- All other `/v1/*` endpoints

#### WebSocket Endpoints
- `ws://<host>/agent` - Agent connections
- `ws://<host>/ui` - UI client connections
- `ws://<host>/teamnames-ws` - Team name updates for OBS

### Trusted IP Addresses

The following IP ranges are considered trusted (internal):

1. **Localhost (IPv4)**: `127.0.0.0/8`
   - `127.0.0.1`, `127.0.0.2`, etc.

2. **Localhost (IPv6)**: 
   - `::1`
   - `::ffff:127.0.0.1`

3. **Private Network (Class A)**: `10.0.0.0/8`
   - `10.0.0.0` - `10.255.255.255`

4. **Private Network (Class B)**: `172.16.0.0/12`
   - `172.16.0.0` - `172.31.255.255`

5. **Private Network (Class C)**: `192.168.0.0/16`
   - `192.168.0.0` - `192.168.255.255`

### Reverse Proxy Configuration

When running behind a reverse proxy (recommended for production), ensure the proxy sets one of these headers:

#### Nginx Example

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    # SSL configuration
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        
        # Forward real client IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

#### Apache Example

```apache
<VirtualHost *:443>
    ServerName your-domain.com
    
    # SSL configuration
    SSLEngine on
    SSLCertificateFile /path/to/cert.pem
    SSLCertificateKeyFile /path/to/key.pem
    
    ProxyPreserveHost On
    ProxyPass / http://localhost:8080/
    ProxyPassReverse / http://localhost:8080/
    
    # Forward real client IP
    RequestHeader set X-Forwarded-For "%{REMOTE_ADDR}s"
    RequestHeader set X-Real-IP "%{REMOTE_ADDR}s"
    
    # WebSocket support
    RewriteEngine on
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteRule /(.*) ws://localhost:8080/$1 [P,L]
</VirtualHost>
```

### Firewall Configuration

When exposing the orchestrator to the internet:

1. **Only forward the necessary port** (default: 8080) to the orchestrator server
2. **Always use a reverse proxy** with SSL/TLS termination
3. **Enable public access restrictions** with `ENABLE_PUBLIC_ACCESS_RESTRICTIONS=true`

Example firewall rule (iptables):
```bash
# Allow external traffic to reverse proxy (port 443)
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# Block direct external access to orchestrator port
iptables -A INPUT -p tcp --dport 8080 -s 192.168.1.0/24 -j ACCEPT
iptables -A INPUT -p tcp --dport 8080 -j DROP
```

### Testing Access Control

#### From Internal Network

All endpoints should be accessible:

```bash
# Should work
curl http://localhost:8080/status
curl http://localhost:8080/v1/agents
curl http://localhost:8080/v1/jobs

# WebSocket should connect
wscat -c ws://localhost:8080/status-ws
wscat -c ws://localhost:8080/ui
```

#### From External Network (When Enabled)

Only public endpoints should be accessible:

```bash
# Should work
curl https://your-domain.com/status

# Should return 403 Forbidden
curl https://your-domain.com/v1/agents
curl https://your-domain.com/v1/jobs

# WebSocket should connect
wscat -c wss://your-domain.com/status-ws

# Should be rejected with 403
wscat -c wss://your-domain.com/ui
```

### Logging

When public access restrictions are enabled, the orchestrator logs:

**Startup:**
```
🔒 Public access restrictions ENABLED
   Public HTTP endpoints: /status, /healthz
   Public WS paths: /status-ws
```

**Access Attempts:**
```
✅ Allowed public access from 203.0.113.42 to /status
⚠️  Blocked external access attempt from 203.0.113.42 to /v1/agents
❌ Rejected external access from 203.0.113.42 to non-public endpoint: /v1/jobs
❌ Rejected external WebSocket connection from 203.0.113.42 to /ui
```

### Development vs Production

**Development (Default):**
```bash
# Access restrictions disabled - all endpoints accessible
# Useful for local development and testing
ENABLE_PUBLIC_ACCESS_RESTRICTIONS=false
```

**Production (Recommended):**
```bash
# Access restrictions enabled - only public endpoints from external IPs
ENABLE_PUBLIC_ACCESS_RESTRICTIONS=true
NODE_ENV=production
```

### Environment Variables Summary

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_PUBLIC_ACCESS_RESTRICTIONS` | `false` | Enable IP-based access control |
| `PORT` | `8080` | Port to listen on |
| `NODE_ENV` | - | Set to `production` for production mode |

### Security Best Practices

1. ✅ **Always enable restrictions in production**: `ENABLE_PUBLIC_ACCESS_RESTRICTIONS=true`
2. ✅ **Use HTTPS/WSS**: Run behind a reverse proxy with SSL/TLS
3. ✅ **Set proper firewall rules**: Block direct access to the orchestrator port
4. ✅ **Monitor logs**: Watch for suspicious access attempts
5. ✅ **Keep software updated**: Regularly update dependencies
6. ✅ **Use strong tokens**: Set a strong `AGENT_TOKEN` for agent authentication

### Troubleshooting

**Problem: Internal services getting blocked**

**Solution:** Ensure your reverse proxy or load balancer's IP is in the trusted range (usually `10.x.x.x`, `172.16-31.x.x`, or `192.168.x.x`). If using a cloud provider's internal network, you may need to modify the `isTrustedIP()` function to include their IP ranges.

**Problem: External access to /status is blocked**

**Solution:** Verify that `ENABLE_PUBLIC_ACCESS_RESTRICTIONS=true` is set and the reverse proxy is properly forwarding the `X-Forwarded-For` header.

**Problem: WebSocket connections failing from external clients**

**Solution:** Ensure your reverse proxy supports WebSocket upgrades and is forwarding the necessary headers. Check the "Reverse Proxy Configuration" section above.

