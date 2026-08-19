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
        intakeId: "50000000-0000-4000-8000-000000000001",
        status: "planning",
        statusUrl: "/v1/intakes/50000000-0000-4000-8000-000000000001",
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(config, `${JSON.stringify({ apiUrl, token })}\n`, {
    mode: 0o600,
  });

  const result = await run(["capture", "--file", markdown], {
    BRAINPOST_CONFIG: config,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    intake: {
      id: "50000000-0000-4000-8000-000000000001",
      status: "planning",
      statusUrl: "/v1/intakes/50000000-0000-4000-8000-000000000001",
    },
  });
  assert.deepEqual(captureRequest.body, {
    content,
    client: "skill",
  });
  assert.equal(captureRequest.authorization, `Bearer ${token}`);
  assert.match(captureRequest.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("BrainPost Skill privately uploads a document and returns a bounded Capture receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-document-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const documentPath = join(directory, "report.docx");
  const document = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from("word/document.xml"),
  ]);
  await writeFile(documentPath, document);
  const artifactId = "70000000-0000-4000-8000-000000000001";
  const captureId = "50000000-0000-4000-8000-000000000009";
  const idempotencyKey = "80000000-0000-4000-8000-000000000001";
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({
      authorization: request.headers.authorization,
      body,
      idempotencyKey: request.headers["idempotency-key"],
      method: request.method,
      path: new URL(request.url, "http://local.test").pathname,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/v1/file-intakes") {
      response.writeHead(201);
      response.end(
        JSON.stringify({
          id: artifactId,
          uploadPath: `/v1/file-uploads/${artifactId}`,
        }),
      );
      return;
    }
    if (request.method === "PUT") {
      response.end(JSON.stringify({ id: artifactId, status: "uploaded" }));
      return;
    }
    response.writeHead(202);
    response.end(JSON.stringify({ id: captureId, status: "accepted" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  await writeFile(
    config,
    `${JSON.stringify({ apiUrl: `http://127.0.0.1:${address.port}`, token })}\n`,
    { mode: 0o600 },
  );

  const result = await run(
    ["capture", "--file", documentPath, "--idempotency-key", idempotencyKey],
    { BRAINPOST_CONFIG: config },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    file: { captureId, filename: "report.docx", status: "accepted" },
  });
  assert.equal(JSON.parse(calls[0].body).filename, "report.docx");
  assert.deepEqual(calls[1].body, document);
  assert.equal(calls[0].idempotencyKey, idempotencyKey);
  assert.equal(calls[2].idempotencyKey, idempotencyKey);
  assert.ok(calls.every((call) => call.authorization === `Bearer ${token}`));
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
    if (path === "/v1/default-vault") {
      response.end(
        JSON.stringify({
          defaultVault: {
            projectId,
            projectName: "Work",
            projectStatus: "active",
            defaultVersion: 1,
          },
        }),
      );
      return;
    }
    captureRequests.push(JSON.parse(body));
    response.writeHead(202);
    response.end(
      JSON.stringify({
        intakeId: "50000000-0000-4000-8000-000000000002",
        status: "planning",
        statusUrl: "/v1/intakes/50000000-0000-4000-8000-000000000002",
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
    config: {
      apiUrl,
      defaultVault: "Work",
      pendingDelivery: false,
      tokenConfigured: true,
    },
  });
  assert.equal(text.code, 0, text.stderr);
  assert.equal(url.code, 0, url.stderr);
  assert.deepEqual(captureRequests, [
    { content: "一段正文\n", client: "skill" },
    { url: "https://example.com/article", client: "skill" },
  ]);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
    apiUrl,
    token,
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(config)).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(
    configured.stdout + configured.stderr + text.stdout + url.stdout,
    new RegExp(token),
  );
});

test("BrainPost Skill configures before a Default Vault exists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-pending-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ defaultVault: null, pendingDelivery: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}`;

  const result = await run(
    ["configure"],
    { BRAINPOST_API_URL: apiUrl, BRAINPOST_CONFIG: config },
    `${token}\n`,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).config, {
    apiUrl,
    defaultVault: null,
    pendingDelivery: true,
    tokenConfigured: true,
  });
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
