import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../brainpost/scripts/brainpost.mjs", import.meta.url),
);
const token = `ikt1_${"A".repeat(43)}`;
const projectId = "20000000-0000-4000-8000-000000000001";

async function run(args, env, stdin = "") {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("BrainPost Skill submits a complete Markdown file without exposing its token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-skill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const markdown = join(directory, "note.md");
  const content = "# 完整 Markdown\n\n正文保持不变。\n";
  await writeFile(markdown, content, "utf8");

  let captureRequest;
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/targets") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify([
          { id: projectId, name: "Work", status: "active" },
        ]),
      );
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    captureRequest = {
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      body: JSON.parse(body),
    };
    response.writeHead(202, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "50000000-0000-4000-8000-000000000001",
        status: "accepted",
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(
    config,
    `${JSON.stringify({ apiUrl, token, projectId })}\n`,
    { mode: 0o600 },
  );

  const result = await run(["capture", "--file", markdown], {
    BRAINPOST_CONFIG: config,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    capture: {
      id: "50000000-0000-4000-8000-000000000001",
      status: "accepted",
    },
  });
  assert.deepEqual(captureRequest.body, {
    projectId,
    kind: "markdown",
    content,
    client: "skill",
  });
  assert.equal(captureRequest.authorization, `Bearer ${token}`);
  assert.match(captureRequest.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("BrainPost Skill configures the shared token and submits stdin or a URL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const captureRequests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const path = new URL(request.url, "http://local.test").pathname;
    response.setHeader("content-type", "application/json");
    if (path === "/v1/targets") {
      response.end(
        JSON.stringify([
          { id: projectId, name: "Work", status: "active" },
        ]),
      );
      return;
    }
    captureRequests.push(JSON.parse(body));
    response.writeHead(202);
    response.end(
      JSON.stringify({
        id: "50000000-0000-4000-8000-000000000002",
        status: "accepted",
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}`;

  const env = { BRAINPOST_API_URL: apiUrl, BRAINPOST_CONFIG: config };
  const configured = await run(["configure"], env, `${token}\n`);
  const text = await run(["capture", "--stdin"], env, "一段正文\n");
  const url = await run(
    ["capture", "--url", "https://example.com/article"],
    env,
  );

  assert.equal(configured.code, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout), {
    ok: true,
    config: { apiUrl, projectId, tokenConfigured: true },
  });
  assert.equal(text.code, 0, text.stderr);
  assert.equal(url.code, 0, url.stderr);
  assert.deepEqual(captureRequests, [
    { projectId, kind: "text", content: "一段正文\n", client: "skill" },
    {
      projectId,
      kind: "url",
      url: "https://example.com/article",
      client: "skill",
    },
  ]);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
    apiUrl,
    token,
    projectId,
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(config)).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(
    configured.stdout + configured.stderr + text.stdout + url.stdout,
    new RegExp(token),
  );
});

test("BrainPost Skill opens account setup and returns an Agent prompt when unconfigured", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "missing.json");
  const result = await run(
    ["capture", "--url", "https://example.com/article"],
    {
      BRAINPOST_CONFIG: config,
      BRAINPOST_NO_BROWSER: "1",
      BRAINPOST_WEB_URL: "https://brainpost.me",
    },
  );

  assert.equal(result.code, 3);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, "configuration_required");
  assert.equal(failure.error.details.setupUrl, "https://brainpost.me/#account");
  assert.match(failure.error.details.prompt, /Identity Token/);
  assert.match(failure.error.details.prompt, /\$brainpost/);
  assert.match(failure.error.details.prompt, /继续刚才的提交/);
});
