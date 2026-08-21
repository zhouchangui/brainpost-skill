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

function membershipFixture(overrides = {}) {
  return {
    tier: "pro",
    policyVersion: "membership-v2",
    allowanceState: "sufficient",
    usageMultiplier: 5,
    termStartsAt: "2026-08-01T00:00:00.000Z",
    termExpiresAt: "2026-08-31T00:00:00.000Z",
    fileIntakeEnabled: true,
    maxFileBytes: 52_428_800,
    purchase: {
      enabled: true,
      termDays: 30,
      plans: [
        { tier: "premium", amountCents: 3900, action: null },
        { tier: "pro", amountCents: 9900, action: null },
      ],
    },
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

test("BrainPost Skill reports Platform membership capabilities", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-capabilities-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const platformMembership = membershipFixture({
    tier: "premium",
    usageMultiplier: 1,
    fileIntakeEnabled: false,
  });
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/account/capabilities");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        membership: {
          ...platformMembership,
          signedUrl: "https://private.example.test/capability",
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

  const result = await run(["capabilities"], { BRAINPOST_CONFIG: config });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    membership: {
      tier: "premium",
      allowanceState: "sufficient",
      usageMultiplier: 1,
      fileIntakeEnabled: false,
      maxFileBytes: 52_428_800,
      termExpiresAt: "2026-08-31T00:00:00.000Z",
      purchaseEnabled: true,
    },
  });
  assert.doesNotMatch(result.stdout, /allowanceLimit|completed|remaining|policyVersion/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("free membership rejects a document before reading or uploading it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-free-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const documentPath = join(directory, "private.docx");
  await writeFile(documentPath, "not-read");
  const calls = [];
  const server = createServer(async (request, response) => {
    calls.push(request.url);
    if (request.url !== "/v1/account/capabilities") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unexpected_request" } }));
      return;
    }
    await rm(documentPath);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        membership: membershipFixture({
          tier: "free",
          usageMultiplier: null,
          termStartsAt: null,
          termExpiresAt: null,
          fileIntakeEnabled: false,
        }),
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

  const result = await run(["capture", "--file", documentPath], {
    BRAINPOST_CONFIG: config,
  });

  assert.equal(result.code, 5);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, "membership_file_not_supported");
  assert.equal(failure.error.details.membership.tier, "free");
  assert.equal(failure.error.details.membership.fileIntakeEnabled, false);
  assert.equal("allowanceLimit" in failure.error.details.membership, false);
  assert.equal(failure.error.details.idempotencyKey.length, 36);
  assert.deepEqual(calls, ["/v1/account/capabilities"]);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test("document preflight uses the Platform file limit before reading", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-file-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const documentPath = join(directory, "large.pdf");
  await writeFile(documentPath, "12345");
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/account/capabilities");
    await rm(documentPath);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        membership: membershipFixture({ maxFileBytes: 4 }),
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

  const result = await run(["capture", "--file", documentPath], {
    BRAINPOST_CONFIG: config,
  });

  assert.equal(result.code, 4);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, "file_too_large");
  assert.equal(failure.error.details.membership.maxFileBytes, 4);
});

test("allowance rejections use tier-aware recovery without daily reset details", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-rejections-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const cases = [
    { code: "task_allowance_exhausted", tier: "free", action: "open" },
    { code: "task_allowance_exhausted", tier: "premium", action: "upgrade" },
    { code: "task_allowance_exhausted", tier: "pro", action: "reopen" },
    { code: "daily_task_limit_reached", tier: "free", action: "open" },
    { code: "recent_failure_limit_reached" },
    { code: "global_queue_full" },
    { code: "file_too_large" },
    { code: "processing_deadline_exceeded" },
  ];
  let requestIndex = 0;
  const server = createServer((request, response) => {
    if (request.url === "/v1/account/capabilities") {
      const current = cases[requestIndex - 1];
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          membership: membershipFixture({
            tier: current.tier,
            allowanceState: "exhausted",
            usageMultiplier:
              current.tier === "free" ? null : current.tier === "premium" ? 1 : 5,
            fileIntakeEnabled: current.tier === "pro",
            purchase: {
              enabled: true,
              termDays: 30,
              plans: [
                {
                  tier: "premium",
                  amountCents: 3900,
                  action: current.tier === "free" ? "open" : null,
                },
                {
                  tier: "pro",
                  amountCents: 9900,
                  action:
                    current.tier === "free"
                      ? "open"
                      : current.tier === "premium"
                        ? "upgrade"
                        : "reopen",
                },
              ],
            },
          }),
        }),
      );
      return;
    }
    const current = cases[requestIndex++];
    response.writeHead(429, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          code: current.code,
          message: "https://private.example.test/untrusted-message",
          details: {
            resetAt: "2026-08-20T16:00:00.000Z",
            timezone: "Asia/Shanghai",
            signedUrl: "https://private.example.test/signed-source",
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

  for (const item of cases) {
    const result = await run(
      ["capture", "--url", `https://example.com/${item.code}`],
      { BRAINPOST_CONFIG: config },
    );
    assert.equal(result.code, 5);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error.code, item.code);
    assert.equal("resetAt" in failure.error.details, false);
    assert.equal("timezone" in failure.error.details, false);
    assert.equal("signedUrl" in failure.error.details, false);
    assert.equal(failure.error.details.idempotencyKey.length, 36);
    if (item.action) {
      assert.equal(failure.error.details.membership.tier, item.tier);
      assert.equal(failure.error.details.recovery.action, item.action);
      assert.equal(
        failure.error.details.recovery.url,
        "https://brainpost.me/account.html#membership",
      );
      assert.match(failure.error.message, /brainpost\.me\/account\.html#membership/u);
    }
    assert.doesNotMatch(
      result.stderr,
      /private\.example|signed-source|untrusted-message|Today|reset/u,
    );
  }
});

test("allowance rejection omits recovery when membership purchase is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "brainpost-no-purchase-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/account/capabilities") {
      response.end(
        JSON.stringify({
          membership: membershipFixture({
            allowanceState: "exhausted",
            purchase: {
              enabled: false,
              termDays: 30,
              plans: [
                { tier: "premium", amountCents: 3900, action: null },
                { tier: "pro", amountCents: 9900, action: null },
              ],
            },
          }),
        }),
      );
      return;
    }
    response.writeHead(429);
    response.end(
      JSON.stringify({
        error: { code: "task_allowance_exhausted", message: "exhausted" },
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

  const result = await run(
    ["capture", "--url", "https://example.com/no-purchase"],
    { BRAINPOST_CONFIG: config },
  );
  assert.equal(result.code, 5);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.details.recovery, undefined);
  assert.doesNotMatch(failure.error.message, /brainpost\.me|Open|Upgrade|Reopen/u);
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

test("Premium rejects documents before reading while Pro uses File Intake", async (t) => {
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
  let capabilityCalls = 0;
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
    if (request.method === "GET" && request.url === "/v1/account/capabilities") {
      capabilityCalls += 1;
      response.end(
        JSON.stringify({
          membership: membershipFixture({
            tier: capabilityCalls === 1 ? "premium" : "pro",
            usageMultiplier: capabilityCalls === 1 ? 1 : 5,
            fileIntakeEnabled: capabilityCalls !== 1,
          }),
        }),
      );
      return;
    }
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

  const premium = await run(
    ["capture", "--file", documentPath, "--idempotency-key", idempotencyKey],
    { BRAINPOST_CONFIG: config },
  );
  const proKey = "80000000-0000-4000-8000-000000000002";
  const pro = await run(
    ["capture", "--file", documentPath, "--idempotency-key", proKey],
    { BRAINPOST_CONFIG: config },
  );

  assert.equal(premium.code, 5);
  assert.equal(pro.code, 0, pro.stderr);
  assert.equal(
    JSON.parse(premium.stderr).error.code,
    "membership_file_not_supported",
  );
  assert.deepEqual(JSON.parse(pro.stdout), {
    ok: true,
    file: { captureId, filename: "report.docx", status: "accepted" },
  });
  assert.equal(JSON.parse(calls[2].body).filename, "report.docx");
  assert.deepEqual(calls[3].body, document);
  assert.equal(calls[2].idempotencyKey, proKey);
  assert.equal(calls[4].idempotencyKey, proKey);
  assert.equal(capabilityCalls, 2);
  assert.ok(calls.every((call) => call.authorization === `Bearer ${token}`));
  assert.doesNotMatch(
    premium.stdout + premium.stderr + pro.stdout + pro.stderr,
    new RegExp(token),
  );
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
