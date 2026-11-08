# T3 Code Relay

An ACP agent designed to hand off messages from an ACP client, like [Zed](https://zed.dev/), to an open [T3 Code](https://t3.codes/) thread.

> [!NOTE]
> This is not designed to implement the full Agent Client Protocol. T3 Code responses will not be returned to the client, as the intent is to continue the conversation within T3 Code.

## Setup

Clone this repo, install dependencies, then run it with Node. Here's an example setup for Zed's `settings.json`:

```json
"agent_servers": {
  "T3 Code": {
    "type": "custom",
    "command": "node",
    "args": ["/path/to/t3code-relay/index.ts"]
  }
}
```

### Options

Pass `--t3-bin <path>` to use a specific `t3` CLI.
