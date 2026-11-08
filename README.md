# T3 Code Relay

An ACP agent designed to handoff messages from an ACP client, like [Zed](https://zed.dev/), to an open [T3 Code](https://t3.codes/) thread.

## Setup

Clone this repo, install dependencies, then run it via node. Here's an example setup for Zed's `settings.json`:

```json
"agent_servers": {
  "T3 Code": {
    "type": "custom",
    "command": "bun",
    "args": ["/path/to/t3code-relay/index.ts"]
  }
}
```

### Options

* `--t3-bin <path>`: path to the `t3` CLI (default `~/.t3/bin/t3`).

Successful sends get no reply in Zed (only errors are shown), and the T3 Code app
opens to the thread via a `t3code://threads/<environment>/<thread>` link.
