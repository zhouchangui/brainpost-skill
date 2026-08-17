#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const maxContentBytes = 262_144;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^ikt1_[A-Za-z0-9_-]{43}$/;
const captureStatuses = new Set([
  "accepted",
  "processing",
  "ready",
  "partial",
  "failed",
]);

class BrainPostError extends Error {
  constructor(code, message, exitCode = 1, details) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function usage() {
  return `Usage:
  node brainpost.mjs configure [--api URL] [--project UUID] < token.txt
  node brainpost.mjs projects
  node brainpost.mjs capture (--url URL | --file PATH | --stdin) [--project UUID] [--idempotency-key UUID] [--cloud]
`;
}

function options(args, allowed, booleans = new Set()) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name?.startsWith("--") || !allowed.has(name) || result.has(name)) {
      throw new BrainPostError("usage_error", `Invalid option: ${name ?? ""}`, 2);
    }
    if (booleans.has(name)) {
      result.set(name, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new BrainPostError("usage_error", `${name} requires a value.`, 2);
    }
    result.set(name, value);
    index += 1;
  }
  return result;
}

function apiBase(value) {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    ) {
      throw new Error("unsafe");
    }
    return url.href.replace(/\/$/, "");
  } catch {
    throw new BrainPostError(
      "configuration_error",
      "BrainPost URL must use HTTPS, or HTTP localhost for development.",
      3,
    );
  }
}

function project(value) {
  if (!uuid.test(value)) {
    throw new BrainPostError("configuration_error", "Project must be a UUID.", 3);
  }
  return value;
}

function identityToken(value) {
  if (!tokenPattern.test(value)) {
    throw new BrainPostError(
      "configuration_error",
      "BrainPost Identity Token is invalid.",
      3,
    );
  }
  return value;
}

async function readStdin(maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new BrainPostError(
        "input_error",
        `Input cannot exceed ${maxBytes.toLocaleString("en-US")} bytes.`,
        4,
      );
    }
    chunks.push(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BrainPostError("input_error", "Input must be valid UTF-8 text.", 4);
  }
}

async function loadConfig(path) {
  try {
    const details = await stat(path);
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
      throw new BrainPostError(
        "configuration_error",
        "BrainPost config permissions are too broad; run chmod 600 on it.",
        3,
      );
    }
    const value = JSON.parse(await readFile(path, "utf8"));
    return {
      apiUrl: apiBase(value?.apiUrl),
      token: identityToken(value?.token),
      projectId: project(value?.projectId),
    };
  } catch (error) {
    if (error instanceof BrainPostError) throw error;
    if (error?.code === "ENOENT") return null;
    throw new BrainPostError(
      "configuration_error",
      "BrainPost config could not be read.",
      3,
    );
  }
}

async function saveConfig(path, config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function openBrowser(url) {
  if (process.env.BRAINPOST_NO_BROWSER === "1") return;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function configurationRequired() {
  const setupUrl = `${apiBase(process.env.BRAINPOST_WEB_URL ?? "https://brainpost.me")}/#account`;
  openBrowser(setupUrl);
  throw new BrainPostError(
    "configuration_required",
    "BrainPost needs the existing shared Identity Token.",
    3,
    {
      setupUrl,
      prompt:
        "请使用 $brainpost 配置我现有的 BrainPost Identity Token，然后继续刚才的提交。Token: <在此粘贴完整的 ikt1_... Token>",
    },
  );
}

async function request(config, path, init = {}) {
  let response;
  try {
    response = await fetch(`${config.apiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...init.headers,
      },
    });
  } catch {
    throw new BrainPostError("network_error", "BrainPost could not be reached.", 5);
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new BrainPostError(
      value?.error?.code ?? "api_error",
      value?.error?.message ?? "BrainPost rejected the request.",
      5,
      value?.error?.details,
    );
  }
  return value;
}

async function targets(config) {
  const value = await request(config, "/v1/targets");
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !uuid.test(typeof item?.id === "string" ? item.id : "") ||
        typeof item?.name !== "string" ||
        item.status !== "active",
    )
  ) {
    throw new BrainPostError(
      "invalid_response",
      "BrainPost returned invalid Vault targets.",
      5,
    );
  }
  return value.map(({ id, name }) => ({ id, name }));
}

async function configure(args, configPath) {
  const parsed = options(args, new Set(["--api", "--project"]));
  const apiUrl = apiBase(
    parsed.get("--api") ??
      process.env.BRAINPOST_API_URL ??
      "https://brainpost.me/api",
  );
  const token = identityToken((await readStdin(512)).trim());
  const available = await targets({ apiUrl, token });
  const requested = parsed.get("--project");
  const projectId = requested === undefined ? available[0]?.id : project(requested);
  if (
    !projectId ||
    (requested === undefined && available.length !== 1) ||
    !available.some(({ id }) => id === projectId)
  ) {
    throw new BrainPostError(
      "project_required",
      "Choose one activated BrainPost Vault and configure again with --project UUID.",
      3,
      { projects: available },
    );
  }
  await saveConfig(configPath, { apiUrl, token, projectId });
  process.stdout.write(
    `${JSON.stringify({ ok: true, config: { apiUrl, projectId, tokenConfigured: true } })}\n`,
  );
}

async function capture(args, configPath) {
  const parsed = options(
    args,
    new Set([
      "--url",
      "--file",
      "--stdin",
      "--project",
      "--idempotency-key",
      "--cloud",
    ]),
    new Set(["--stdin", "--cloud"]),
  );
  const modes = ["--url", "--file", "--stdin"].filter((name) => parsed.has(name));
  if (modes.length !== 1) {
    throw new BrainPostError(
      "usage_error",
      "Choose exactly one input: --url, --file or --stdin.",
      2,
    );
  }
  const config = (await loadConfig(configPath)) ?? configurationRequired();
  const projectId = parsed.has("--project")
    ? project(parsed.get("--project"))
    : config.projectId;
  const available = await targets(config);
  if (!available.some(({ id }) => id === projectId)) {
    throw new BrainPostError(
      "project_not_activated",
      "Activate the target Vault in Obsidian before submitting.",
      3,
    );
  }

  let body;
  if (parsed.has("--url")) {
    const value = parsed.get("--url");
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw new BrainPostError("input_error", "URL must use HTTP(S).", 4);
    }
    body = { projectId, kind: "url", url: value, client: "skill" };
  } else {
    let content;
    if (parsed.has("--file")) {
      const path = parsed.get("--file");
      let details;
      try {
        details = await stat(path);
      } catch {
        throw new BrainPostError("input_error", "Markdown file could not be read.", 4);
      }
      if (!details.isFile() || details.size > maxContentBytes) {
        throw new BrainPostError(
          "input_error",
          "Markdown must be a regular file no larger than 262,144 bytes.",
          4,
        );
      }
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
      } catch {
        throw new BrainPostError("input_error", "Markdown must be valid UTF-8 text.", 4);
      }
    } else {
      content = await readStdin(maxContentBytes);
    }
    if (!content.trim()) {
      throw new BrainPostError("input_error", "Input content cannot be empty.", 4);
    }
    body = {
      projectId,
      kind: parsed.has("--file") ? "markdown" : "text",
      content,
      client: "skill",
    };
  }
  if (parsed.has("--cloud")) body.processingMode = "cloud";

  const suppliedKey = parsed.get("--idempotency-key");
  if (suppliedKey !== undefined && !uuid.test(suppliedKey)) {
    throw new BrainPostError("usage_error", "Idempotency key must be a UUID.", 2);
  }
  const idempotencyKey = suppliedKey ?? randomUUID();
  let value;
  try {
    value = await request(config, "/v1/captures", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof BrainPostError) {
      error.details = { ...error.details, idempotencyKey };
    }
    throw error;
  }
  if (!uuid.test(value?.id ?? "") || !captureStatuses.has(value?.status)) {
    throw new BrainPostError(
      "invalid_response",
      "BrainPost returned an invalid capture result.",
      5,
      { idempotencyKey },
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, capture: { id: value.id, status: value.status } })}\n`,
  );
}

async function main(args) {
  const configPath =
    process.env.BRAINPOST_CONFIG ??
    join(homedir(), ".config", "brainpost", "config.json");
  const [command, ...rest] = args;
  if (command === "configure") return configure(rest, configPath);
  if (command === "capture") return capture(rest, configPath);
  if (command === "projects" && rest.length === 0) {
    const config = (await loadConfig(configPath)) ?? configurationRequired();
    process.stdout.write(`${JSON.stringify({ ok: true, projects: await targets(config) })}\n`);
    return;
  }
  if (command === "help" || command === "--help" || command === undefined) {
    process.stdout.write(usage());
    return;
  }
  throw new BrainPostError("usage_error", usage().trim(), 2);
}

main(process.argv.slice(2)).catch((error) => {
  const failure =
    error instanceof BrainPostError
      ? error
      : new BrainPostError("unexpected_error", "BrainPost could not complete the request.");
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details === undefined ? {} : { details: failure.details }),
      },
    })}\n`,
  );
  process.exitCode = failure.exitCode;
});
