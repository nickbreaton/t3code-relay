#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import packageJson from "../package.json" with { type: "json" };

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "t3-bin": { type: "string" },
    debug: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "no-focus": { type: "boolean", default: false },
  },
});

// T3's installer doesn't put its CLI on PATH, so its install folder is searched last.
process.env.PATH = [process.env.PATH, join(homedir(), ".t3/bin")].filter(Boolean).join(delimiter);

const T3 = flags["t3-bin"] ?? "t3";
const SCRATCH = real(join(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), "scratch"));

// How many threads to look up at once when matching workspaces.
const SCAN_BATCH = 5;

// How many threads to offer when several match; each one becomes a button in the ACP client.
const MAX_CHOICES = 4;
const DONT_SEND = "dont-send";

// Logs go to stderr; stdout carries the ACP protocol.
const log = (...args: unknown[]) => console.error("[t3code-send]", ...args);

// threadId is the thread the user chose for this chat, when they had to choose.
const sessions = new Map<string, { cwd: string; threadId?: string }>();

type T3Thread = {
  threadId: string;
  title: string;
  link?: string;
  parentThreadId: string | null;
  settled: boolean;
  updatedAt: string;
  providerInstanceId?: string | null;
  model?: string | null;
};

// Run a command to completion and capture its output.
function run(command: string, args: string[], options: { cwd?: string; stdin?: string } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd });

    let out = "";
    let err = "";

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));

    // A child that exits without reading stdin surfaces through its exit code,
    // so the resulting EPIPE must not take the agent down.
    child.stdin.on("error", (e) => log("stdin write failed:", e));
    child.stdin.end(options.stdin);
  });
}

async function t3(args: string[], cwd: string, stdin?: string) {
  const { code, out, err } = await run(T3, args, { cwd, stdin });

  if (code !== 0) throw new Error(`t3 ${args.join(" ")} failed (${code}): ${err.trim() || out.trim()}`);

  return out;
}

function real(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const contains = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const newestFirst = (a: T3Thread, b: T3Thread) => b.updatedAt.localeCompare(a.updatedAt);

// Nearest existing directory for a file or directory path.
function existingDir(p: string): string | undefined {
  for (let d = p; ; d = dirname(d)) {
    try {
      return real(statSync(d).isDirectory() ? d : dirname(d));
    } catch {}

    if (dirname(d) === d) return undefined;
  }
}

async function git(dir: string, args: string[]) {
  const { code, out } = await run("git", ["-C", dir, ...args]);

  return code === 0 && out.trim() ? out.trim() : undefined;
}

// For a path in a git checkout: the main checkout, and whether the path is in a linked worktree.
async function gitInfo(dir: string) {
  const [top, common] = await Promise.all([
    git(dir, ["rev-parse", "--show-toplevel"]),
    git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);

  const main = common?.endsWith("/.git") ? real(dirname(common)) : undefined;

  return { main, inLinkedWorktree: !!top && !!main && real(top) !== main };
}

// A thread's worktreePath rarely changes, so cache it briefly to keep sends fast.
const worktreeCache = new Map<string, { at: number; path: string | null }>();

async function worktreeOf(t: T3Thread): Promise<string | null> {
  const hit = worktreeCache.get(t.threadId);

  if (hit && Date.now() - hit.at < 60_000) return hit.path;
  const { thread } = JSON.parse(await t3(["thread", "show", t.threadId, "--messages", "0", "--json"], homedir()));
  const path = thread.worktreePath ? real(thread.worktreePath) : null;
  worktreeCache.set(t.threadId, { at: Date.now(), path });

  return path;
}

type Match = { thread: T3Thread; reason: string };

// Find the threads whose workspace contains the given paths (quoted files first,
// then the ACP client's cwd), newest first. The first path with any match decides.
// A path in a T3 worktree or scratch folder matches the thread working there;
// a path in the main checkout matches threads without a worktree.
// Workspace matching only considers open (non-settled) threads.
// No match returns an empty list, so a new thread can start in the project
// folder. The t3 CLI can't start one in an existing worktree, so that's an error.
async function findThreads(paths: string[]): Promise<{ matches: Match[]; projectDir: string; latest?: T3Thread }> {
  let lastError: unknown;
  let firstProject: { dir: string; projectDir: string; inLinkedWorktree: boolean; latest?: T3Thread } | undefined;
  const seen = new Set<string>();

  for (const raw of paths) {
    const dir = existingDir(raw);

    if (!dir || seen.has(dir)) continue;
    seen.add(dir);

    const { main, inLinkedWorktree } = await gitInfo(dir);
    let threads: T3Thread[] | undefined;
    let projectDir: string | undefined;

    for (const p of new Set([dir, main].filter((x): x is string => !!x))) {
      try {
        threads = JSON.parse(await t3(["thread", "list", "--project", p, "--json"], p));
        projectDir = p;
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!threads || !projectDir) continue;
    const candidates = threads.filter((t) => !t.parentThreadId).sort(newestFirst);

    firstProject ??= { dir, projectDir, inLinkedWorktree, latest: candidates[0] };

    // Scratch folders are named "<date>-<slug>-<last 8 chars of the thread id>".
    const suffix = t3ScratchSuffix(dir);
    const owner = suffix && candidates.find((t) => t.threadId.endsWith(suffix));

    if (owner) return { matches: [{ thread: owner, reason: `owns scratch folder …-${suffix}` }], projectDir };

    // Only open (non-settled) threads are matched by workspace.
    const scan = candidates.filter((t) => !t.settled);
    const matches: Match[] = [];

    for (let i = 0; i < scan.length; i += SCAN_BATCH) {
      const batch = scan.slice(i, i + SCAN_BATCH);
      const wts = await Promise.all(batch.map((t) => worktreeOf(t).catch(() => undefined)));

      batch.forEach((thread, idx) => {
        const wt = wts[idx];

        if (wt ? contains(wt, dir) : wt === null && !inLinkedWorktree) {
          matches.push({ thread, reason: wt ? `works in ${wt}` : "works in the main checkout" });
        }
      });
    }

    if (matches.length > 0) return { matches, projectDir };
  }

  // No project at all (or T3 isn't running): surface the t3 error itself.
  if (!firstProject && lastError) throw lastError;

  if (firstProject?.inLinkedWorktree) {
    throw new Error(`No open T3 thread is working in ${firstProject.dir}, and t3 can't start one in an existing worktree.`);
  }

  if (firstProject) return { matches: [], projectDir: firstProject.projectDir, latest: firstProject.latest };

  throw new Error(`No T3 thread is working in ${[...seen].join(" or ") || "these paths"}.`);
}

function t3ScratchSuffix(dir: string) {
  if (!contains(SCRATCH, dir) || dir === SCRATCH) return undefined;
  const folder = dir.slice(SCRATCH.length + 1).split(sep)[0]!;

  return /-([0-9a-f]{8})$/.exec(folder)?.[1];
}

// Bring the T3 Code desktop app to the thread. Thread links look like
// https://app.t3.codes/threads/<environmentId>/<threadId>, or without the
// /threads prefix on a local server; the app only accepts
// t3code://threads/<environmentId>/<threadId>.
async function openInT3(thread: T3Thread) {
  if (flags["no-focus"] || !thread.link) return;

  const url = `t3code://threads${new URL(thread.link).pathname.replace(/^\/threads(?=\/)/, "")}`;

  // Opening is best effort and runs alongside the send, so it must never reject.
  try {
    const { code } = await run("open", [url]);

    if (code !== 0) log(`couldn't open ${url} (exit ${code})`);
  } catch (e) {
    log(`couldn't open ${url}`, e);
  }
}

async function startThread(projectDir: string, message: string, latest?: T3Thread) {
  const start = (model: string[]) => t3(["thread", "start", ...model, projectDir, "-"], projectDir, message);
  let output: string;

  try {
    output = await start([]);
  } catch (e) {
    // A project with no default model needs one named, so reuse its latest thread's.
    // t3 rejects the start before launching anything, so retrying can't duplicate it.
    if (!String(e).includes("no default model") || !latest?.providerInstanceId || !latest.model) throw e;

    output = await start(["--provider", latest.providerInstanceId, "--model", latest.model]);
  }

  const threadId = output.trim();
  log(`started ${threadId} in ${projectDir}`);

  // The message has already landed, so a failure here must not be reported as a failed send.
  try {
    if (flags["no-focus"]) return;
    const { thread } = JSON.parse(await t3(["thread", "show", threadId, "--messages", "0", "--json"], projectDir));
    await openInT3(thread);
  } catch (e) {
    log(`couldn't open new thread ${threadId}`, e);
  }
}

function filePath(uri: string) {
  return uri.startsWith("file://") ? fileURLToPath(uri.split("#")[0]!) : undefined;
}

function displayPath(uri: string, cwd: string) {
  let path = uri;

  if (uri.startsWith("file://")) {
    const [base, frag] = uri.split("#");
    path = fileURLToPath(base!) + (frag ? `#${frag}` : "");
  }

  return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

// Flatten the prompt's content blocks into one markdown message.
function toMarkdown(blocks: acp.ContentBlock[], cwd: string) {
  const parts: string[] = [];

  for (const b of blocks) {
    switch (b.type) {
      case "text":
        parts.push(b.text);
        break;
      case "resource":
        if ("text" in b.resource) {
          parts.push(`\`${displayPath(b.resource.uri, cwd)}\`\n\`\`\`\n${b.resource.text}\n\`\`\``);
        } else {
          parts.push(`\`${displayPath(b.resource.uri, cwd)}\` (binary)`);
        }

        break;
      case "resource_link":
        parts.push(`\`${displayPath(b.uri, cwd)}\``);
        break;
      default:
        parts.push(`[${b.type} omitted]`);
    }
  }

  return parts.join("\n\n").trim();
}

const app = acp
  .agent({ name: "t3code-send" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      // Load and resume are accepted so the ACP client can reopen old chats after a restart.
      // The agent keeps no history, so nothing is replayed and they reopen empty.
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { embeddedContext: true, image: false, audio: false },
    },
    agentInfo: { name: "t3code-send", title: "t3code-send", version: packageJson.version },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cwd: params.cwd });

    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, ({ params }) => {
    sessions.set(params.sessionId, { cwd: params.cwd });

    return {};
  })
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    sessions.set(params.sessionId, { cwd: params.cwd });

    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    // A chat the ACP client reopened without loading it first still works; the
    // ACP client starts the agent in the project folder, so that stands in for
    // the chat's cwd.
    const session = sessions.get(params.sessionId) ?? { cwd: process.cwd() };
    sessions.set(params.sessionId, session);

    if (flags.debug) log("prompt", JSON.stringify(params.prompt));

    const say = (text: string) =>
      client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });

    // ACP has no general "pick one" request that clients reliably support, so
    // the choice is presented as a permission prompt on a placeholder tool call.
    const askWhichThread = async (matches: Match[]) => {
      const toolCallId = crypto.randomUUID();

      // The SDK's method-keyed overload infers this response as unknown, so name the types.
      const { outcome } = await client.request<acp.RequestPermissionResponse, acp.RequestPermissionRequest>(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId,
          title: "Several T3 threads are open in this workspace. Which one should get this?",
          kind: "other",
          status: "pending",
        },
        options: [
          ...matches
            .slice(0, MAX_CHOICES)
            .map((m) => ({ optionId: m.thread.threadId, name: m.thread.title, kind: "allow_once" as const })),
          { optionId: DONT_SEND, name: "Don't send", kind: "reject_once" },
        ],
      });

      const chosen = outcome.outcome === "selected" ? matches.find((m) => m.thread.threadId === outcome.optionId) : undefined;

      // The client leaves the placeholder running until it's told otherwise.
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: chosen ? "completed" : "failed",
          title: chosen ? `Sending to ${chosen.thread.title}` : "Not sent",
        },
      });

      return chosen;
    };

    const message = toMarkdown(params.prompt, session.cwd);

    if (!message) {
      await say("Nothing to send.");

      return { stopReason: "end_turn" };
    }

    const quoted = params.prompt.flatMap((b) => {
      const uri = b.type === "resource" ? b.resource.uri : b.type === "resource_link" ? b.uri : undefined;
      const path = uri && filePath(uri);

      return path ? [path] : [];
    });

    try {
      const { matches, projectDir, latest } = await findThreads([...quoted, session.cwd]);

      if (matches.length === 0) {
        if (flags["dry-run"]) await say(`Would start a new thread in ${projectDir}`);
        else await startThread(projectDir, message, latest);

        return { stopReason: "end_turn" };
      }

      // A choice made earlier in this chat holds for as long as that thread still matches.
      const match =
        matches.length === 1
          ? matches[0]
          : (matches.find((m) => m.thread.threadId === session.threadId) ?? (await askWhichThread(matches)));

      if (!match) return { stopReason: "cancelled" };

      if (matches.length > 1) session.threadId = match.thread.threadId;

      const { thread, reason } = match;

      if (flags["dry-run"]) {
        await say(`Would send to **${thread.title}** (${reason})`);
      } else {
        // Jump to the thread as soon as it's known; the message lands a moment later.
        const opening = openInT3(thread);

        await t3(["thread", "send", thread.threadId, "-"], projectDir, message);
        log(`sent to ${thread.title} (${thread.threadId}): ${reason}`);

        await opening;
      }
    } catch (e) {
      // Only failures get a reply, so the message isn't silently lost.
      log(e);
      await say(`Couldn't forward to T3: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {});

const stdout = new WritableStream<Uint8Array>({
  write: (chunk) => new Promise((resolve) => process.stdout.write(chunk, () => resolve())),
});

const stdin = Readable.toWeb(process.stdin)

app.connect(acp.ndJsonStream(stdout, stdin));
