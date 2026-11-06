#!/usr/bin/env bun
// A fake ACP agent: every prompt Zed sends is forwarded to the T3 Code thread
// most likely working on the files involved, via the `t3` CLI.

import * as acp from "@agentclientprotocol/sdk";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const T3 = process.env.T3_BIN ?? join(homedir(), ".t3/bin/t3");
const SCRATCH = real(join(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), "scratch"));

// How many of a project's newest threads to inspect for a worktree match.
const SCAN_LIMIT = 20;
const SCAN_BATCH = 5;

// Logs go to stderr; stdout carries the ACP protocol.
const log = (...args: unknown[]) => console.error("[t3code-relay]", ...args);

const sessions = new Map<string, { cwd: string }>();

type T3Thread = {
  threadId: string;
  title: string;
  link?: string;
  parentThreadId: string | null;
  updatedAt: string;
};

async function t3(args: string[], cwd: string, stdin?: string) {
  const proc = Bun.spawn([T3, ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

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
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();

  return (await proc.exited) === 0 && out ? out : undefined;
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

type Pick = { thread: T3Thread; projectDir: string; reason: string };

// Pick the thread whose checkout contains the given paths (quoted files first,
// then Zed's cwd). A path in a T3 worktree or scratch folder matches the thread
// working there; a path in the main checkout matches threads without a worktree.
// No match is an error: we only send when the target is clear.
async function pickThread(paths: string[]): Promise<Pick> {
  let lastError: unknown;
  let foundProject = false;
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
    foundProject = true;

    const candidates = threads.filter((t) => !t.parentThreadId).sort(newestFirst);

    // Scratch folders are named "<date>-<slug>-<last 8 chars of the thread id>".
    const suffix = scratchSuffix(dir);
    const owner = suffix && candidates.find((t) => t.threadId.endsWith(suffix));

    if (owner) return { thread: owner, projectDir, reason: `owns scratch folder …-${suffix}` };

    const scan = candidates.slice(0, SCAN_LIMIT);

    for (let i = 0; i < scan.length; i += SCAN_BATCH) {
      const batch = scan.slice(i, i + SCAN_BATCH);
      const wts = await Promise.all(batch.map((t) => worktreeOf(t).catch(() => undefined)));
      const idx = wts.findIndex((wt) => (wt ? contains(wt, dir) : wt === null && !inLinkedWorktree));

      if (idx >= 0) {
        const wt = wts[idx];

        return { thread: batch[idx]!, projectDir, reason: wt ? `works in ${wt}` : "works in the main checkout" };
      }
    }
  }

  // No project at all (or T3 isn't running): surface the t3 error itself.
  if (!foundProject && lastError) throw lastError;
  throw new Error(`No T3 thread is working in ${[...seen].join(" or ") || "these paths"}.`);
}

function scratchSuffix(dir: string) {
  if (!contains(SCRATCH, dir) || dir === SCRATCH) return undefined;
  const folder = dir.slice(SCRATCH.length + 1).split(sep)[0]!;

  return /-([0-9a-f]{8})$/.exec(folder)?.[1];
}

// Bring the T3 Code desktop app to the thread. Thread links look like
// http://127.0.0.1:3773/<environmentId>/<threadId>; the app handles the same
// path as t3code://threads/<environmentId>/<threadId>.
async function openInT3(thread: T3Thread) {
  if (!thread.link) return;

  const url = `t3code://threads${new URL(thread.link).pathname}`;
  const code = await Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" }).exited;

  if (code !== 0) log(`couldn't open ${url} (exit ${code})`);
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
  .agent({ name: "t3code-relay" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { embeddedContext: true, image: false, audio: false },
    },
    agentInfo: { name: "t3code-relay", title: "T3 Code Relay", version: "0.1.0" },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cwd: params.cwd });

    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);

    if (!session) throw acp.RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);

    if (process.env.T3_ACP_DEBUG) log("prompt", JSON.stringify(params.prompt));

    const say = (text: string) =>
      client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });

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
      const { thread, projectDir, reason } = await pickThread([...quoted, session.cwd]);

      if (process.env.T3_ACP_DRY_RUN) {
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

app.connect(acp.ndJsonStream(stdout, Bun.stdin.stream()));
