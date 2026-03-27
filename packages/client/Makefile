VERSION := 0.1.0
DIST := dist

.PHONY: build build-all clean

# Build for current platform
build:
	bun build src/cli.ts --compile --outfile $(DIST)/tnp

# Build for all platforms
build-all:
	bun build src/cli.ts --compile --target=bun-linux-x64 --outfile $(DIST)/tnp-linux-x64
	bun build src/cli.ts --compile --target=bun-linux-arm64 --outfile $(DIST)/tnp-linux-arm64
	bun build src/cli.ts --compile --target=bun-darwin-x64 --outfile $(DIST)/tnp-darwin-x64
	bun build src/cli.ts --compile --target=bun-darwin-arm64 --outfile $(DIST)/tnp-darwin-arm64
	bun build src/cli.ts --compile --target=bun-windows-x64 --outfile $(DIST)/tnp-win32-x64.exe

clean:
	rm -rf $(DIST)
