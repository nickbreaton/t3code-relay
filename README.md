# t3code-relay

A fake ACP agent for Zed. Anything you send to it (including "Add to agent" quotes)
is forwarded with `t3 thread send` to the T3 Code thread most likely working on
those files:

1. Paths come from quoted files first, then Zed's working directory.
2. A path inside a scratch folder goes to the thread whose id ends with the folder's
   8-character suffix. A path inside a T3 worktree goes to the newest thread whose
   `worktreePath` contains it (worktrees map back to their project through git).
3. A path in the project's main checkout goes to the newest thread without a worktree.
4. Otherwise the send fails with an error in Zed; nothing is guessed.

Zed `settings.json`:

```json
"agent_servers": {
  "T3 Code": {
    "type": "custom",
    "command": "/Users/nickbreaton/.bun/bin/bun",
    "args": ["/Users/nickbreaton/Developer/t3code-relay/index.ts"]
  }
}
```

Env: `T3_BIN` overrides the `t3` path (default `~/.t3/bin/t3`); `T3_ACP_DEBUG=1`
logs raw prompts to stderr (visible in Zed's ACP logs);
`T3_ACP_DRY_RUN=1` replies with the chosen thread instead of sending.

Successful sends get no reply in Zed (only errors are shown), and the T3 Code app
opens to the thread via a `t3code://threads/<environment>/<thread>` link.
