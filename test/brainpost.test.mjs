import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
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

function pointsFixture(overrides = {}) {
  return {
    available: 20,
    reserved: 0,
    taskCosts: { standard: 1, cloud: 2, file: 6 },
    purchase: { enabled: true, packs: [{ id: "starter", points: 100, amountCents: 900 }] },
    ...overrides,
  };
}

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

async function pointsServer(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-points-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(config, JSON.stringify({ apiUrl: `http://127.0.0.1:${server.address().port}`, token }), { mode: 0o600 });
  return { config, directory };
}

test("BrainPost Skill reports sanitized points capabilities", async (t) => {
  const { config } = await pointsServer(t, (request, response) => {
    assert.equal(request.url, "/v1/account/capabilities");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ points: { ...pointsFixture(), signedUrl: "https://private.example.test/capability" } }));
  });
  const result = await run(["capabilities"], { BRAINPOST_CONFIG: config });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, points: {
    available: 20, reserved: 0, taskCosts: { standard: 1, cloud: 2, file: 6 },
    maxFileBytes: 52_428_800, purchaseEnabled: true,
    recovery: { url: "https://brainpost.me/account.html#points" },
  } });
  assert.doesNotMatch(result.stdout + result.stderr, /signedUrl|private\.example|membership/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("insufficient points reject a document before reading or uploading it", async (t) => {
  let documentPath;
  const calls = [];
  const { config, directory } = await pointsServer(t, async (request, response) => {
    calls.push(request.url);
    assert.equal(request.url, "/v1/account/capabilities");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ points: pointsFixture({ available: 5 }) }));
  });
  documentPath = join(directory, "private.docx");
  await writeFile(documentPath, "not-read");
  const result = await run(["capture", "--file", documentPath], { BRAINPOST_CONFIG: config });
  const failure = JSON.parse(result.stderr);
  assert.equal(result.code, 5);
  assert.equal(failure.error.code, "points_insufficient");
  assert.equal(failure.error.details.points.available, 5);
  assert.equal(failure.error.details.idempotencyKey.length, 36);
  assert.deepEqual(calls, ["/v1/account/capabilities", "/v1/account/capabilities"]);
});

test("document preflight enforces the file size limit before reading", async (t) => {
  let documentPath;
  const { config, directory } = await pointsServer(t, async (request, response) => {
    assert.equal(request.url, "/v1/account/capabilities");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ points: pointsFixture() }));
  });
  documentPath = join(directory, "large.pdf");
  await writeFile(documentPath, "x");
  await truncate(documentPath, 52_428_801);
  const result = await run(["capture", "--file", documentPath], { BRAINPOST_CONFIG: config });
  assert.equal(result.code, 4);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, "file_too_large");
  assert.equal(failure.error.details.points.maxFileBytes, 52_428_800);
});

test("points rejection returns purchase recovery and redacts upstream details", async (t) => {
  const { config } = await pointsServer(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/account/capabilities") {
      response.end(JSON.stringify({ points: pointsFixture({ available: 0 }) }));
      return;
    }
    response.writeHead(402);
    response.end(JSON.stringify({ error: { code: "points_insufficient", message: "https://private.example.test/untrusted", details: { signedUrl: "secret", resetAt: "tomorrow" } } }));
  });
  const result = await run(["capture", "--url", "https://example.com/points"], { BRAINPOST_CONFIG: config });
  const failure = JSON.parse(result.stderr);
  assert.equal(result.code, 5);
  assert.equal(failure.error.code, "points_insufficient");
  assert.equal(failure.error.details.recovery.url, "https://brainpost.me/account.html#points");
  assert.equal(failure.error.details.points.available, 0);
  assert.doesNotMatch(result.stderr, /private\.example|signedUrl|secret|resetAt/);
});

test("legacy upgrade handoff details are no longer exposed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const handoffId = "90000000-0000-4000-8000-000000000001";
  const upgradeUrl = `https://brainpost.me/?upgrade=cloud&handoff=${handoffId}#account`;
  const server = createServer((_request, response) => {
    response.writeHead(402, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          code: "upgrade_required",
          details: {
            estimatedCredits: 1,
            resume: { handoffId },
            upgradeUrl,
            signedUrl: "https://private.example.test/source",
          },
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  await writeFile(
    config,
    `${JSON.stringify({ apiUrl: `http://127.0.0.1:${address.port}`, token })}\n`,
    { mode: 0o600 },
  );

  const result = await run(["capture", "--url", "https://example.com"], {
    BRAINPOST_CONFIG: config,
  });

  const details = JSON.parse(result.stderr).error.details;
  assert.equal("upgradeUrl" in details, false);
  assert.equal("resume" in details, false);
  assert.equal("estimatedCredits" in details, false);
  assert.equal("signedUrl" in details, false);
});

test("status reports Intake capacity and file Capture deadline reasons", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const intakeId = "50000000-0000-4000-8000-000000000008";
  const captureId = "50000000-0000-4000-8000-000000000009";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === `/v1/intakes/${intakeId}`
          ? {
              id: intakeId,
              status: "capacity_limited",
              failureReason: "global_queue_full",
              refusalReason: null,
              deliveryStatus: "not_applicable",
              retryable: false,
              sourceUrl: "https://private.example.test/source",
              content: "private content",
            }
          : {
              id: captureId,
              status: "failed",
              failureReason: "processing_deadline_exceeded",
              sourceUrl: "https://private.example.test/file",
            },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  await writeFile(
    config,
    `${JSON.stringify({ apiUrl: `http://127.0.0.1:${address.port}`, token })}\n`,
    { mode: 0o600 },
  );

  const intake = await run(["status", "--intake", intakeId], {
    BRAINPOST_CONFIG: config,
  });
  const capture = await run(["status", "--capture", captureId], {
    BRAINPOST_CONFIG: config,
  });

  assert.equal(intake.code, 0, intake.stderr);
  assert.deepEqual(JSON.parse(intake.stdout), {
    ok: true,
    intake: {
      id: intakeId,
      status: "capacity_limited",
      failureReason: "global_queue_full",
      refusalReason: null,
      deliveryStatus: "not_applicable",
      retryable: false,
    },
  });
  assert.equal(capture.code, 0, capture.stderr);
  assert.deepEqual(JSON.parse(capture.stdout), {
    ok: true,
    capture: {
      id: captureId,
      status: "failed",
      failureReason: "processing_deadline_exceeded",
    },
  });
  assert.doesNotMatch(
    intake.stdout + capture.stdout,
    /private\.example|private content/u,
  );
});

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

test("documents with enough points use the private File Intake", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-document-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const documentPath = join(directory, "report.docx");
  const document = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml")]);
  await writeFile(documentPath, document);
  const artifactId = "70000000-0000-4000-8000-000000000001";
  const captureId = "50000000-0000-4000-8000-000000000009";
  const key = "80000000-0000-4000-8000-000000000002";
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ method: request.method, url: request.url, body: Buffer.concat(chunks), key: request.headers["idempotency-key"] });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") response.end(JSON.stringify({ points: pointsFixture() }));
    else if (request.method === "POST" && request.url === "/v1/file-intakes") { response.writeHead(201); response.end(JSON.stringify({ id: artifactId, uploadPath: `/v1/file-uploads/${artifactId}` })); }
    else if (request.method === "PUT") response.end(JSON.stringify({ id: artifactId, status: "uploaded" }));
    else if (request.method === "POST" && request.url.endsWith("/commit")) response.end(JSON.stringify({ id: captureId, status: "accepted" }));
    else { response.writeHead(202); response.end(JSON.stringify({ id: captureId, status: "accepted" })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(config, JSON.stringify({ apiUrl: `http://127.0.0.1:${server.address().port}`, token }), { mode: 0o600 });
  const result = await run(["capture", "--file", documentPath, "--idempotency-key", key], { BRAINPOST_CONFIG: config });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, file: { captureId, filename: "report.docx", status: "accepted" } });
  assert.deepEqual(calls.map((call) => call.url), ["/v1/account/capabilities", "/v1/file-intakes", `/v1/file-uploads/${artifactId}`, `/v1/file-intakes/${artifactId}/commit`]);
  assert.equal(calls[1].key, key);
  assert.deepEqual(calls[2].body, document);
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
