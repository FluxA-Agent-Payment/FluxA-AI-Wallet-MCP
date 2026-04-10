# Codex Tool Mapping

Skills use Claude Code tool names. When you encounter these in a skill, use your platform equivalent:

| Skill references | Codex equivalent |
|-----------------|------------------|
| `Skill` tool (invoke a skill) | Skills load natively -- just follow the instructions |
| `Read`, `Write`, `Edit` (files) | Use your native file tools |
| `Bash` (run commands) | Use your native shell tools |

## Codex Setup

Add to your Codex config (`~/.codex/config.toml`) if using multi-agent features:

```toml
[features]
multi_agent = true
```
