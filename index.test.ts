// High-level happy paths for the relay, driven only through what it exposes:
// the ACP handlers it registers, the flags it accepts, and the commands it runs.
//
// The ACP SDK is mocked to capture those handlers. Everything else is real: git
// runs against a real checkout and worktree, and `t3` and `open` are stand-in
// programs that record how they were called.

import * as acp from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";
import { pathToFileURL } from "node:url";

type FakeThread = {
  threadId: string;
  title: string;
  link: string;
  parentThreadId: string | null;
  settled: boolean;
  updatedAt: string;
  worktreePath: string | null;
};

type Recorded = { program: string; args: string[]; stdin: string };

type Client = {
  notify: (method: string, params: acp.SessionNotification) => Promise<void>;
  request: (method: string, params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
};

type RelayParams = acp.InitializeRequest | acp.NewSessionRequest | acp.LoadSessionRequest | acp.ResumeSessionRequest | acp.PromptRequest;

// `never` because each handler takes its own ACP method's params and returns its own response.
type Handler = (context: { params: never; client: Client }) => Promise<never> | never;

// The relay registers its handlers when it is imported; this keeps the latest set.
let handlers = new Map<string, Handler>();

function fakeAgent() {
  const registered = new Map<string, Handler>();

  const app = {
    onRequest(method: string, handler: Handler) {
      registered.set(method, handler);

      return app;
    },
    onNotification: () => app,
    connect: () => {},
  };

  handlers = registered;

  return app;
}

mock.module("@agentclientprotocol/sdk", { exports: { ...acp, agent: fakeAgent, ndJsonStream: () => ({}) } });

const FAKE_PROGRAM = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { basename, join } = require("node:path");

const home = join(__dirname, "..");
const program = basename(process.argv[1]);
const args = process.argv.slice(2);
const stdin = program === "t3" ? readFileSync(0, "utf8") : "";

appendFileSync(join(home, "calls.jsonl"), JSON.stringify({ program, args, stdin }) + "\\n");

if (program === "t3") {
  const { threads, startedThread } = JSON.parse(readFileSync(join(home, "world.json"), "utf8"));
  const command = args[1];

  if (command === "list") console.log(JSON.stringify(threads));
  if (command === "start") console.log(startedThread.threadId);

  if (command === "show") {
    console.log(JSON.stringify({ thread: [...threads, startedThread].find((t) => t && t.threadId === args[2]) }));
  }
}
`;

// Each import of the relay attaches another reader to stdin.
process.stdin.setMaxListeners(0);

// Those readers keep stdin open, which would stop the test process from exiting.
after(() => {
  process.stdin.destroy();
});

const originalArgv = process.argv;
const originalPath = process.env.PATH;
const originalT3Home = process.env.T3CODE_HOME;

let root: string;
let checkout: string;
let worktree: string;
let scratchFolder: string;
let relayImports = 0;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
  });
}

function installProgram(name: string) {
  const path = join(root, "bin", name);

  writeFileSync(path, FAKE_PROGRAM);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "t3code-relay-test-")));
  checkout = join(root, "project");
  worktree = join(root, "worktrees", "feature");
  scratchFolder = join(root, "t3-home", "scratch", "2026-11-08-notes-aaaa1111");

  mkdirSync(checkout);
  mkdirSync(join(root, "worktrees"));
  mkdirSync(scratchFolder, { recursive: true });
  mkdirSync(join(root, "bin"));

  git(checkout, "init");
  git(checkout, "commit", "--allow-empty", "-m", "init");
  git(checkout, "worktree", "add", "-b", "feature", worktree);

  installProgram("t3");
  installProgram("open");
  writeFileSync(join(root, "calls.jsonl"), "");

  process.env.PATH = [join(root, "bin"), originalPath].join(delimiter);
  process.env.T3CODE_HOME = join(root, "t3-home");
});

afterEach(() => {
  process.argv = originalArgv;
  process.env.PATH = originalPath;

  if (originalT3Home === undefined) delete process.env.T3CODE_HOME;
  else process.env.T3CODE_HOME = originalT3Home;

  rmSync(root, { recursive: true, force: true });
});

function fakeThread(threadId: string, updatedAt = "2026-11-08T10:00:00.000Z"): FakeThread {
  return {
    threadId,
    title: `Title of ${threadId}`,
    link: `https://app.t3.codes/threads/env-1/${threadId}`,
    parentThreadId: null,
    settled: false,
    updatedAt,
    worktreePath: null,
  };
}

function t3Knows(threads: FakeThread[], startedThread?: FakeThread) {
  writeFileSync(join(root, "world.json"), JSON.stringify({ threads, startedThread }));
}

function recordedCalls() {
  return readFileSync(join(root, "calls.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): Recorded => JSON.parse(line));
}

// Calls that change something in T3, leaving out the relay's list and show lookups.
function t3Writes() {
  return recordedCalls()
    .filter((call) => call.program === "t3" && (call.args[1] === "send" || call.args[1] === "start"))
    .map((call) => ({ args: call.args, message: call.stdin }));
}

function openedUrls() {
  return recordedCalls()
    .filter((call) => call.program === "open")
    .map((call) => call.args[0]);
}

function fileUri(...segments: string[]) {
  return pathToFileURL(join(...segments)).href;
}

async function startRelay(...flags: string[]) {
  process.argv = ["node", "index.ts", "--t3-bin", join(root, "bin", "t3"), ...flags];
  relayImports += 1;

  // The relay reads its flags on import, so every test needs a fresh copy of the module.
  await import(`./index.ts?relay=${relayImports}`);

  const relayHandlers = handlers;
  const chatMessages: string[] = [];
  const permissionRequests: acp.RequestPermissionRequest[] = [];
  let answer = "";

  const client: Client = {
    notify: async (_method, params) => {
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
        chatMessages.push(params.update.content.text);
      }
    },
    request: async (_method, params) => {
      permissionRequests.push(params);

      return { outcome: { outcome: "selected", optionId: answer } };
    },
  };

  function call<Response>(method: string, params: RelayParams): Promise<Response> {
    const handler = relayHandlers.get(method);

    assert.ok(handler, `the relay should handle ${method}`);

    // SAFETY: the parameter is `never` only so each call can name its own method's params.
    return Promise.resolve(handler({ params: params as never, client }));
  }

  return {
    chatMessages,
    permissionRequests,
    willAnswerWith: (optionId: string) => {
      answer = optionId;
    },
    initialize: () => call<acp.InitializeResponse>(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION }),
    newSession: (cwd: string) => call<acp.NewSessionResponse>(acp.methods.agent.session.new, { cwd, mcpServers: [] }),
    reopenSession: (method: string, sessionId: string, cwd: string) => call<object>(method, { sessionId, cwd, mcpServers: [] }),
    prompt: (sessionId: string, prompt: acp.ContentBlock[]) =>
      call<acp.PromptResponse>(acp.methods.agent.session.prompt, { sessionId, prompt }),
  };
}

const text = (value: string): acp.ContentBlock => ({ type: "text", text: value });
const fileLink = (uri: string): acp.ContentBlock => ({ type: "resource_link", uri, name: "file" });

describe("ACP sessions", () => {
  test("introduces itself as an ACP agent that accepts files and can reopen chats", async () => {
    const relay = await startRelay();

    const response = await relay.initialize();

    assert.equal(response.protocolVersion, acp.PROTOCOL_VERSION);
    assert.equal(response.agentInfo?.name, "t3code-relay");
    assert.equal(response.agentCapabilities?.loadSession, true);
    assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.resume, {});
    assert.equal(response.agentCapabilities?.promptCapabilities?.embeddedContext, true);
  });

  for (const method of [acp.methods.agent.session.load, acp.methods.agent.session.resume]) {
    test(`a chat reopened with ${method} keeps forwarding prompts`, async () => {
      t3Knows([fakeThread("thread-a")]);
      const relay = await startRelay();

      await relay.reopenSession(method, "chat-from-before-restart", checkout);
      await relay.prompt("chat-from-before-restart", [text("Back again")]);

      assert.deepEqual(t3Writes(), [{ args: ["thread", "send", "thread-a", "-"], message: "Back again" }]);
    });
  }
});

describe("forwarding a prompt", () => {
  test("forwards a prompt to the open thread in the checkout and brings T3 Code to that thread", async () => {
    t3Knows([fakeThread("thread-a")]);
    const relay = await startRelay();
    const { sessionId } = await relay.newSession(checkout);

    const response = await relay.prompt(sessionId, [text("Fix the login bug")]);

    assert.deepEqual(t3Writes(), [{ args: ["thread", "send", "thread-a", "-"], message: "Fix the login bug" }]);
    assert.deepEqual(openedUrls(), ["t3code://threads/env-1/thread-a"]);
    assert.equal(response.stopReason, "end_turn");
    assert.deepEqual(relay.chatMessages, [], "a successful send adds nothing to the ACP client's chat");
  });

  test("flattens text, quoted file contents, and file links into one markdown message", async () => {
    t3Knows([fakeThread("thread-a")]);
    const relay = await startRelay();
    const { sessionId } = await relay.newSession(checkout);

    await relay.prompt(sessionId, [
      text("Compare these"),
      { type: "resource", resource: { uri: fileUri(checkout, "src", "a.ts"), text: "const a = 1;" } },
      fileLink(fileUri(checkout, "src", "b.ts")),
    ]);

    assert.deepEqual(t3Writes(), [
      {
        args: ["thread", "send", "thread-a", "-"],
        message: "Compare these\n\n`src/a.ts`\n```\nconst a = 1;\n```\n\n`src/b.ts`",
      },
    ]);
  });
});

describe("choosing a thread", () => {
  test("routes a prompt quoting a worktree file to the thread in that worktree, ahead of the chat's folder", async () => {
    t3Knows([fakeThread("main-thread"), { ...fakeThread("worktree-thread"), worktreePath: worktree }]);
    const relay = await startRelay();
    const { sessionId } = await relay.newSession(checkout);

    await relay.prompt(sessionId, [text("Look at this"), fileLink(fileUri(worktree, "file.ts"))]);

    assert.deepEqual(
      t3Writes().map((write) => write.args),
      [["thread", "send", "worktree-thread", "-"]],
    );
  });

  test("routes a prompt quoting a scratch file to the thread that owns the scratch folder", async () => {
    t3Knows([fakeThread("other-thread"), fakeThread("thread-aaaa1111")]);
    const relay = await startRelay();
    const { sessionId } = await relay.newSession(checkout);

    await relay.prompt(sessionId, [text("See my notes"), fileLink(fileUri(scratchFolder, "notes.md"))]);

    assert.deepEqual(
      t3Writes().map((write) => write.args),
      [["thread", "send", "thread-aaaa1111", "-"]],
    );
  });

  test("asks which thread to use when several match, then remembers the choice for that chat", async () => {
    t3Knows([fakeThread("older-thread", "2026-11-08T09:00:00.000Z"), fakeThread("newer-thread", "2026-11-08T10:00:00.000Z")]);
    const relay = await startRelay();
    const { sessionId } = await relay.newSession(checkout);
    relay.willAnswerWith("older-thread");

    await relay.prompt(sessionId, [text("First message")]);
    await relay.prompt(sessionId, [text("Second message")]);

    assert.equal(relay.permissionRequests.length, 1, "the ACP client is only asked once");
    assert.deepEqual(
      relay.permissionRequests[0]?.options.map((option) => [option.optionId, option.name]),
      [
        ["newer-thread", "Title of newer-thread"],
        ["older-thread", "Title of older-thread"],
        ["dont-send", "Don't send"],
      ],
    );
    assert.deepEqual(t3Writes(), [
      { args: ["thread", "send", "older-thread", "-"], message: "First message" },
      { args: ["thread", "send", "older-thread", "-"], message: "Second message" },
    ]);
  });

  test("starts a new thread in the project when no open thread matches, and opens it from a local link", async () => {
    t3Knows([{ ...fakeThread("finished-thread"), settled: true }], {
      ...fakeThread("started-thread"),
      link: "http://localhost:3773/env-1/started-thread",
    });
    const relay = await startRelay();
    const { sessionId } = await relay.newSession(checkout);

    await relay.prompt(sessionId, [text("Begin something new")]);

    assert.deepEqual(t3Writes(), [{ args: ["thread", "start", checkout, "-"], message: "Begin something new" }]);
    assert.deepEqual(openedUrls(), ["t3code://threads/env-1/started-thread"]);
  });
});

describe("command line flags", () => {
  test("--no-focus sends the message without bringing T3 Code to the thread", async () => {
    t3Knows([fakeThread("thread-a")]);
    const relay = await startRelay("--no-focus");
    const { sessionId } = await relay.newSession(checkout);

    await relay.prompt(sessionId, [text("Quietly")]);

    assert.deepEqual(t3Writes(), [{ args: ["thread", "send", "thread-a", "-"], message: "Quietly" }]);
    assert.deepEqual(openedUrls(), []);
  });
});
