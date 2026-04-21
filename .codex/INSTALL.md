# Installing Fluxa for Codex

Enable fluxa skills in Codex via native skill discovery. Clone and symlink.

## Installation

1. **Clone the fluxa repository:**
   ```bash
   git clone https://github.com/fluxa-agent-payment/fluxa-ai-wallet-mcp.git ~/.codex/fluxa
   ```

2. **Create the skills symlink:**
   ```bash
   mkdir -p ~/.agents/skills
   ln -s ~/.codex/fluxa/skills ~/.agents/skills/fluxa
   ```

3. **Restart Codex** to discover the skills.

## Verify

```bash
ls -la ~/.agents/skills/fluxa
```

You should see a symlink pointing to your fluxa skills directory.

## Updating

```bash
cd ~/.codex/fluxa && git pull
```

## Uninstalling

```bash
rm ~/.agents/skills/fluxa
rm -rf ~/.codex/fluxa
```
