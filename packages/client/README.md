# TNP Client

The TNP client is a lightweight DNS resolver daemon that runs on your machine. It resolves TNP domains (like `nate.ox`, `studio.app`) by querying the TNP API, while forwarding all other DNS queries to 1.1.1.1 (or your configured upstream).

Built with TypeScript and compiled to a standalone binary via Bun.

## Install (end users)

**macOS / Linux:**

```
curl -fsSL https://get.tnp.network | sh
```

**Windows (PowerShell as Administrator):**

```
irm https://get.tnp.network/install.ps1 | iex
```

## How it works

1. The daemon runs as a background service (launchd on macOS, systemd on Linux, Scheduled Task on Windows)
2. It listens for DNS queries on `127.0.0.1:5354`
3. For TNP TLDs (.ox, .app, .com, etc.), it resolves records via the TNP API and caches them locally
4. For everything else, it forwards to 1.1.1.1 untouched
5. Your system DNS is configured to route TNP TLD queries to the local resolver

## CLI

```
tnp run              Start the resolver in the foreground
tnp install          Install as a system service and configure DNS
tnp uninstall        Remove the service and restore DNS
tnp status           Check if the resolver is running
tnp test <domain>    Test resolving a TNP domain via the API
tnp version          Print version
tnp help             Show help
```

## Platform support

| Platform | Service | DNS config |
|---|---|---|
| macOS | launchd daemon | /etc/resolver/<tld> files |
| Linux | systemd unit | systemd-resolved drop-in |
| Windows | Scheduled Task | DNS adapter settings via PowerShell |

## Development

```bash
# Install deps
bun install

# Run in dev mode (auto-restart on changes)
bun run dev

# Build standalone binary for current platform
bun run build

# Build for all platforms
make build-all
```

## Config

Config file location:
- macOS: `/usr/local/etc/tnp/config.json`
- Linux: `/etc/tnp/config.json`
- Windows: `C:\ProgramData\tnp\config.json`

```json
{
  "listenAddr": "127.0.0.1",
  "listenPort": 5354,
  "apiBaseUrl": "https://tnp.network/api",
  "upstreamDns": "1.1.1.1",
  "cacheTtlSeconds": 300
}
```
