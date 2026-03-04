# claude-code-proxy

## Security / Secrets
- **Never commit real tokens.**
- `proxy.config.json` in this repo is **sanitized** (token fields empty).
- Inject tokens locally using one of the following:
  1) **Env override**: set `WORKERS` to a JSON array of worker objects (see `secrets.example`).
  2) **Local config**: edit your local `proxy.config.json` (keep it private/untracked).

## Runtime artifacts
The following are runtime-only and should never be committed:
- `proxy.log`, `proxy.err`
- `data/metrics.jsonl`, `data/tokens.json`
- `token_labels.json`
- `proxy.config.json.bak.*`, `proxy.config.json.tmp`

## Quick start (local)
```bash
npm install
# Inject tokens (see secrets.example), then:
node server.mjs
```
