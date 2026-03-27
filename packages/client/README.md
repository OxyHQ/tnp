# TNP Client

The TNP client is a lightweight DNS resolver daemon that runs on your machine. It resolves TNP domains (like `nate.ox`, `studio.app`) by querying TNP nameservers, while forwarding all other DNS queries to your default resolver.

## Status

This package is a scaffold for future development. The client will be written in Go.

## Planned features

- Local DNS proxy that listens on a configurable port
- Split DNS: resolves TNP TLDs via TNP nameservers, forwards everything else
- Lightweight background service (launchd on macOS, systemd on Linux)
- Local response caching with configurable TTL
- Automatic TLD list updates from the TNP API
- Simple CLI for install, uninstall, and status

## Build instructions

Coming soon. The client will use standard Go tooling:

```
go build -o tnp ./cmd/tnp
```

## Install (end users)

```
curl -fsSL https://get.tnp.network | sh
```
