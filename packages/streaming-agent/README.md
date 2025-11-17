# Streaming Agent

The streaming agent connects to the orchestrator and manages OBS streaming jobs.

## Configuration

### Environment Variables

- `ORCHESTRATOR_URL` - WebSocket URL for the orchestrator (default: `ws://localhost:8080/agent`)
- `AGENT_TOKEN` - Authentication token (must match orchestrator's `AGENT_TOKEN`)
- `AGENT_ID` - Unique identifier for this agent (default: `agent-<hostname>`)
- `AGENT_NAME` - Display name for this agent (default: `<hostname>`)

## Running the Agent

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Agent Reboot Configuration

All agent reboots are performed via SSH from the orchestrator. To enable reboot functionality, you must configure SSH settings in the agent's metadata.

### Windows SSH Setup

Since streaming agents run on Windows, you need to set up SSH on Windows:

#### 1. Enable OpenSSH Server on Windows

1. Open PowerShell as Administrator
2. Check if OpenSSH Server is installed:
   ```powershell
   Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
   ```
3. Install OpenSSH Server if not installed:
   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   ```
4. Start and enable the SSH service:
   ```powershell
   Start-Service sshd
   Set-Service -Name sshd -StartupType 'Automatic'
   ```
5. Configure Windows Firewall to allow SSH:
   ```powershell
   New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
   ```

#### 2. Configure SSH Authentication

**Option A: Password Authentication (Less Secure)**
- Ensure password authentication is enabled in `C:\ProgramData\ssh\sshd_config`
- Set `PasswordAuthentication yes`
- Restart SSH service: `Restart-Service sshd`

**Option B: SSH Key Authentication (Recommended)**
1. On the orchestrator machine, generate an SSH key pair:
   ```bash
   ssh-keygen -t rsa -b 4096 -f ~/.ssh/streaming_agent_key
   ```
2. Copy the public key to the Windows agent:
   ```bash
   # On orchestrator
   scp ~/.ssh/streaming_agent_key.pub Administrator@<agent-ip>:C:\Users\Administrator\.ssh\authorized_keys
   ```
3. On the Windows agent, ensure the `.ssh` directory exists and has correct permissions:
   ```powershell
   mkdir C:\Users\Administrator\.ssh -Force
   icacls C:\Users\Administrator\.ssh /grant Administrator:F /inheritance:r
   ```
4. Copy the public key content to `C:\Users\Administrator\.ssh\authorized_keys`
5. Ensure the file has correct permissions:
   ```powershell
   icacls C:\Users\Administrator\.ssh\authorized_keys /grant Administrator:F
   ```

#### 3. Configure Agent Metadata in Orchestrator

Once SSH is set up, configure the agent's SSH settings via the orchestrator API:

```bash
curl -X PUT http://localhost:8080/v1/agents/<agent-id>/meta \
  -H "Content-Type: application/json" \
  -d '{
    "meta": {
      "ssh": {
        "host": "192.168.1.100",
        "user": "Administrator",
        "keyPath": "C:\\Users\\orchestrator\\.ssh\\streaming_agent_key",
        "rebootCommand": "shutdown /r /f /t 0"
      }
    }
  }'
```

**SSH Configuration Options:**
- `host` (required): IP address or hostname of the Windows agent machine
- `user` (optional): Windows username (default: `Administrator`)
- `keyPath` (optional): Path to SSH private key file on orchestrator machine. If not provided, uses default SSH keys (`~/.ssh/id_rsa` or `~/.ssh/id_ed25519`)
- `rebootCommand` (optional): Custom reboot command (default: `shutdown /r /f /t 0`)

**Note:** The `keyPath` should be the path on the orchestrator machine, not the agent machine.

#### 4. Test SSH Connection

Test SSH access from the orchestrator machine:

```bash
# With key file
ssh -i ~/.ssh/streaming_agent_key Administrator@<agent-ip> "whoami"

# With default keys
ssh Administrator@<agent-ip> "whoami"
```

#### 5. Test Reboot Command

Test the reboot command via SSH:

```bash
# Test reboot (will actually reboot the machine!)
ssh Administrator@<agent-ip> "shutdown /r /f /t 0"
```

### Reboot Command Options

The default reboot command is `shutdown /r /f /t 0` which:
- `/r` - Reboots the computer
- `/f` - Forces running applications to close
- `/t 0` - Sets timeout to 0 seconds (immediate)

You can customize this in the SSH metadata if needed:
- `shutdown /r /f /t 10` - Reboots after 10 seconds
- `shutdown /r /t 0` - Reboots without forcing apps (may prompt for save)

## Security Considerations

- **SSH Keys**: Store SSH private keys securely on the orchestrator machine. Use strong passphrases.
- **Network Security**: Ensure SSH access is restricted to trusted networks or use VPN.
- **Windows Firewall**: Only allow SSH (port 22) from the orchestrator's IP address.
- **User Permissions**: Use a dedicated service account with minimal required permissions.
- **Agent Token**: Keep `AGENT_TOKEN` secret and use strong, unique tokens in production.

## Troubleshooting

### SSH Connection Fails

1. Verify SSH service is running:
   ```powershell
   Get-Service sshd
   ```
2. Check Windows Firewall rules:
   ```powershell
   Get-NetFirewallRule -Name sshd
   ```
3. Verify SSH port is listening:
   ```powershell
   netstat -an | findstr :22
   ```
4. Check SSH logs:
   ```powershell
   Get-Content C:\ProgramData\ssh\logs\sshd.log -Tail 50
   ```

### Reboot Command Fails

1. Test the reboot command manually via SSH
2. Verify the user has permission to execute shutdown commands
3. Check if Group Policy restricts shutdown commands
4. Try running the command interactively first to see error messages
