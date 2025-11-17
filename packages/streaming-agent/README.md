# Streaming Agent

The streaming agent connects to the orchestrator and manages OBS streaming jobs.

## Configuration

### Environment Variables

- `ORCHESTRATOR_URL` - WebSocket URL for the orchestrator (default: `ws://localhost:8080/agent`)
- `AGENT_TOKEN` - Authentication token (must match orchestrator's `AGENT_TOKEN`)
- `AGENT_ID` - Unique identifier for this agent (default: `agent-<hostname>`)
- `AGENT_NAME` - Display name for this agent (default: `<hostname>`)
- `OBS_PATH` - Full path to OBS executable (default: `obs64.exe`)
- `OBS_USER` - Windows username to run OBS as (optional, auto-detected if not set)

## Running the Agent

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Running with PM2 (Windows Service)

When using [pm2-installer](https://github.com/jessety/pm2-installer), PM2 runs as the "Local Service" account, which cannot launch GUI applications like OBS. The agent automatically detects this and uses Windows Task Scheduler to launch OBS in the interactive user session.

### Configuration for PM2 Service

**Option 1: Auto-detect logged-in user (Recommended)**
- The agent will automatically detect the logged-in user
- Ensure a user is logged in when streams start
- No additional configuration needed

**Option 2: Specify user explicitly**
- Set the `OBS_USER` environment variable to the Windows username that should run OBS:
  ```powershell
  # In PM2 ecosystem file or environment
  OBS_USER=tcc
  ```

**Option 3: Configure PM2 to run as a specific user**
- Instead of Local Service, configure PM2 to run as a user account
- This requires modifying the PM2 service configuration
- See pm2-installer documentation for details

### Troubleshooting OBS Launch Issues

If OBS fails to start when running as a PM2 service:

1. **Check if user is logged in**:
   ```powershell
   quser
   ```
   At least one user must be logged in for OBS to launch.

2. **Verify OBS_USER is set correctly** (if using Option 2):
   ```powershell
   # Check PM2 environment
   pm2 env <process-id>
   ```

3. **Check Task Scheduler permissions**:
   - The PM2 service (Local Service) needs permission to create scheduled tasks
   - Ensure the Local Service account has "Create scheduled tasks" permission
   - Or run PM2 as a user account instead of Local Service

4. **Check OBS path**:
   ```powershell
   # Verify OBS_PATH environment variable
   echo $env:OBS_PATH
   # Or check if obs64.exe is in PATH
   where.exe obs64.exe
   ```

5. **Test OBS launch manually**:
   ```powershell
   # Try launching OBS manually to verify it works
   & "C:\Program Files\obs-studio\bin\64bit\obs64.exe" --websocket_port=4455 --websocket_password=randompassword123
   ```

6. **Test scheduled task launch** (simulates how the agent launches OBS):
   
   **Note**: The agent now creates a temporary batch file to avoid quote escaping issues.
   
   **Manual test** (create a batch file and run it via schtasks):
   ```powershell
   # Create test batch file
   $batchFile = "$env:TEMP\test_obs.bat"
   @"
   @echo off
   cd /d "C:\Program Files\obs-studio\bin\64bit"
   "C:\Program Files\obs-studio\bin\64bit\obs64.exe" --websocket_port=4455 --websocket_password=randompassword123
   "@ | Out-File -FilePath $batchFile -Encoding ASCII
   
   # Create and run scheduled task
   schtasks /Create /TN "TestOBS" /TR $batchFile /SC ONCE /ST 23:59 /F /RU "tcc" /RL HIGHEST /IT
   schtasks /Run /TN "TestOBS"
   
   # Cleanup
   schtasks /Delete /TN "TestOBS" /F
   Remove-Item $batchFile
   ```

7. **Check agent logs**:
   - Look for messages about "Launching OBS in interactive session"
   - Check for Task Scheduler errors
   - Verify the scheduled task is created and executed

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
   Or on Windows PowerShell:
   ```powershell
   ssh-keygen -t rsa -b 4096 -f C:\Users\tcc\.ssh\streaming_agent_key
   ```

2. **On the Windows agent machine**, ensure the `.ssh` directory exists:
   ```powershell
   mkdir C:\Users\tcc\.ssh -Force
   ```

3. **Determine which authorized_keys location to use**:
   - Check `C:\ProgramData\ssh\sshd_config` for the `AuthorizedKeysFile` setting
   - If it shows `__PROGRAMDATA__/ssh/administrators_authorized_keys`, use the system location (step 3a)
   - If it shows `.ssh/authorized_keys`, use the user profile location (step 3b)

   **Option 3a: System location** (most common on Windows):
   ```powershell
   # On the agent machine, create the administrators_authorized_keys file
   New-Item -Path C:\ProgramData\ssh\administrators_authorized_keys -ItemType File -Force
   
   # Copy the public key content from orchestrator's streaming_agent_key.pub
   # Replace with your actual public key content
   $pubKey = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ... (paste full key here)"
   Set-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value $pubKey -Encoding UTF8
   
   # Set permissions (CRITICAL - only Administrators and SYSTEM should have access)
   icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r
   icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "Administrators:F"
   icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "SYSTEM:F"
   
   # Verify permissions
   icacls C:\ProgramData\ssh\administrators_authorized_keys
   ```

   **Option 3b: User profile location**:
   ```powershell
   # On the agent machine, ensure .ssh directory exists
   mkdir C:\Users\tcc\.ssh -Force
   
   # Create authorized_keys file
   New-Item -Path C:\Users\tcc\.ssh\authorized_keys -ItemType File -Force
   
   # Copy the public key content from orchestrator's streaming_agent_key.pub
   $pubKey = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ... (paste full key here)"
   Set-Content -Path C:\Users\tcc\.ssh\authorized_keys -Value $pubKey -Encoding UTF8
   
   # Set permissions (CRITICAL)
   icacls C:\Users\tcc\.ssh\authorized_keys /inheritance:r
   icacls C:\Users\tcc\.ssh\authorized_keys /grant "${env:USERNAME}:F"
   
   # Set permissions on .ssh directory
   icacls C:\Users\tcc\.ssh /inheritance:r
   icacls C:\Users\tcc\.ssh /grant "${env:USERNAME}:F"
   
   # Verify permissions
   icacls C:\Users\tcc\.ssh\authorized_keys
   ```

6. **Configure SSH service to use authorized_keys**:
   - Open `C:\ProgramData\ssh\sshd_config` as Administrator
   - Check the `AuthorizedKeysFile` setting. Windows OpenSSH Server may use:
     - `AuthorizedKeysFile .ssh/authorized_keys` (user profile location: `C:\Users\<username>\.ssh\authorized_keys`)
     - `AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys` (system location: `C:\ProgramData\ssh\administrators_authorized_keys`)
   
   - **If using the system location** (recommended for Windows):
     ```powershell
     # Create the administrators_authorized_keys file
     New-Item -Path C:\ProgramData\ssh\administrators_authorized_keys -ItemType File -Force
     
     # Copy public key content to the file (replace with your actual public key)
     $pubKey = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ... (paste full key here)"
     Set-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value $pubKey -Encoding UTF8
     
     # Set permissions (only Administrators group should have access)
     icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r
     icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "Administrators:F"
     icacls C:\ProgramData\ssh\administrators_authorized_keys /grant "SYSTEM:F"
     ```
   
   - **If using the user profile location**:
     - Ensure `AuthorizedKeysFile .ssh/authorized_keys` is set
     - Place the key in `C:\Users\<username>\.ssh\authorized_keys`
     - Set permissions as shown in step 4 above
   
   - Ensure `PubkeyAuthentication yes` is enabled
   - Restart SSH service:
     ```powershell
     Restart-Service sshd
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

1. **Verify SSH service is running**:
   ```powershell
   Get-Service sshd
   ```

2. **Check Windows Firewall rules**:
   ```powershell
   Get-NetFirewallRule -Name sshd
   ```

3. **Verify SSH port is listening**:
   ```powershell
   netstat -an | findstr :22
   ```

4. **Check SSH logs on the agent machine** (most important for debugging):
   ```powershell
   Get-Content C:\ProgramData\ssh\logs\sshd.log -Tail 50
   ```
   Look for messages about key authentication failures.

5. **Verify authorized_keys file permissions**:
   - **If using system location** (`C:\ProgramData\ssh\administrators_authorized_keys`):
     ```powershell
     icacls C:\ProgramData\ssh\administrators_authorized_keys
     ```
     Should show only `Administrators` and `SYSTEM` groups.
   
   - **If using user profile location** (`C:\Users\tcc\.ssh\authorized_keys`):
     ```powershell
     icacls C:\Users\tcc\.ssh\authorized_keys
     ```
     Should show only your user account, no other users or groups.

6. **Verify the public key matches the private key**:
   On the orchestrator machine, get the public key fingerprint:
   ```powershell
   ssh-keygen -lf C:\Users\tcc\.ssh\streaming_agent_key.pub
   ```
   This should show: `SHA256:43wnjeddOMxCf6oGznobGSTcOiNJGsERLMau+KCiYYg` (or similar)
   
   On the agent machine, verify the public key in `authorized_keys` matches:
   ```powershell
   # Check which location is configured in sshd_config
   Get-Content C:\ProgramData\ssh\sshd_config | Select-String -Pattern "AuthorizedKeysFile"
   
   # View the authorized_keys file (use the location from above)
   # If using system location:
   Get-Content C:\ProgramData\ssh\administrators_authorized_keys
   
   # If using user profile location:
   Get-Content C:\Users\tcc\.ssh\authorized_keys
   ```
   The key should start with `ssh-rsa` and match the content of `streaming_agent_key.pub` exactly

7. **Test SSH key authentication manually from orchestrator**:
   ```bash
   ssh -i "C:/Users/tcc/.ssh/streaming_agent_key" -v tcc@192.168.0.204 "whoami"
   ```
   The `-v` flag shows verbose output. Look for:
   - `Offering public key` - confirms key is being sent
   - `Authentications that can continue: publickey` - means server rejected the key
   - Check the server logs for why it was rejected

8. **Common issues**:
   - **Key mismatch**: Public key in `authorized_keys` must match the private key. Verify with:
     ```powershell
     # On orchestrator - get fingerprint
     ssh-keygen -lf C:\Users\tcc\.ssh\streaming_agent_key.pub
     
     # On agent - check authorized_keys content matches streaming_agent_key.pub
     ```
   - **Wrong permissions**: `authorized_keys` must be readable only by the user (no inheritance)
   - **Wrong file location**: Must be in `C:\Users\<username>\.ssh\authorized_keys`
   - **Public key format**: Must be a single line starting with `ssh-rsa` or `ssh-ed25519` with no extra spaces or line breaks
   - **SSH service config**: `PubkeyAuthentication yes` must be set in `sshd_config`
   - **File encoding**: `authorized_keys` must be UTF-8 without BOM (use PowerShell `Set-Content -Encoding UTF8`)

### Reboot Command Fails

1. Test the reboot command manually via SSH
2. Verify the user has permission to execute shutdown commands
3. Check if Group Policy restricts shutdown commands
4. Try running the command interactively first to see error messages
