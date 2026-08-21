#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

const maxContentBytes = 262_144;
const membershipUrl = "https://brainpost.me/account.html#membership";
const documentExtensions = new Set([
  ".csv",
  ".doc",
  ".docm",
  ".docx",
  ".epub",
  ".odp",
  ".ods",
  ".odt",
  ".pdf",
  ".pot",
  ".pps",
  ".ppsm",
  ".ppsx",
  ".ppt",
  ".pptm",
  ".pptx",
  ".rtf",
  ".xls",
  ".xlsb",
  ".xlsm",
  ".xlsx",
]);
const mediaTypes = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^ikt1_[A-Za-z0-9_-]{43}$/;
const captureStatuses = new Set([
  "received",
  "planning",
  "accepted",
  "processing",
  "ready",
  "success",
  "partial",
  "refused",
  "failed",
]);
const intakeStatuses = new Set([
  ...captureStatuses,
  "rate_limited",
  "capacity_limited",
]);
const deliveryStatuses = new Set([
  "processing",
  "awaiting_vault",
  "awaiting_sync",
  "synced",
  "not_applicable",
]);
const stableFailureReasons = new Set([
  "daily_task_limit_reached",
  "task_allowance_exhausted",
  "document_output_limit_exceeded",
  "document_page_limit_exceeded",
  "file_too_large",
  "global_queue_full",
  "membership_file_not_supported",
  "processing_deadline_exceeded",
  "processing_failed",
  "rate_limited",
  "capacity_limited",
  "recent_failure_limit_reached",
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
  node brainpost.mjs configure [--api URL] < token.txt
  node brainpost.mjs capabilities
  node brainpost.mjs status (--intake UUID | --capture UUID)
  node brainpost.mjs capture (--url URL | --file PATH | --stdin) [--idempotency-key UUID]
`;
}

function options(args, allowed, booleans = new Set()) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name?.startsWith("--") || !allowed.has(name) || result.has(name)) {
      throw new BrainPostError(
        "usage_error",
        `Invalid option: ${name ?? ""}`,
        2,
      );
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
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new BrainPostError(
      "input_error",
      "Input must be valid UTF-8 text.",
      4,
    );
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

function safeErrorDetails(value) {
  if (!value || typeof value !== "object") return undefined;
  const details = {};
  if (Number.isSafeInteger(value.maxFileBytes) && value.maxFileBytes >= 0) {
    details.maxFileBytes = value.maxFileBytes;
  }
  return Object.keys(details).length ? details : undefined;
}

function safeErrorMessage(code) {
  return (
    {
      daily_task_limit_reached: `BrainPost allowance is exhausted. Open membership: ${membershipUrl}`,
      task_allowance_exhausted: `BrainPost allowance is exhausted. Open membership: ${membershipUrl}`,
      file_too_large: "The file exceeds the current BrainPost limit.",
      global_queue_full: "BrainPost is currently at processing capacity.",
      membership_file_not_supported: `File organization is a Pro benefit. Open membership: ${membershipUrl}`,
      processing_deadline_exceeded:
        "BrainPost processing exceeded its deadline.",
      recent_failure_limit_reached:
        "BrainPost temporarily paused new tasks after repeated failures.",
    }[code] ?? "BrainPost rejected the request."
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
    throw new BrainPostError(
      "network_error",
      "BrainPost could not be reached.",
      5,
    );
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const code = value?.error?.code ?? "api_error";
    throw new BrainPostError(
      code,
      safeErrorMessage(code),
      [
        "invalid_file_artifact",
        "file_artifact_mismatch",
        "file_artifact_expired",
      ].includes(code)
        ? 4
        : 5,
      safeErrorDetails(value?.error?.details),
    );
  }
  return value;
}

async function defaultVault(config) {
  const value = await request(config, "/v1/default-vault");
  if (value?.defaultVault === null) return null;
  const vault = value?.defaultVault;
  if (
    !vault ||
    !uuid.test(typeof vault.projectId === "string" ? vault.projectId : "") ||
    typeof vault.projectName !== "string" ||
    vault.projectStatus !== "active"
  ) {
    throw new BrainPostError(
      "invalid_response",
      "BrainPost returned an invalid default Vault.",
      5,
    );
  }
  return {
    projectId: vault.projectId,
    projectName: vault.projectName,
    defaultVersion: vault.defaultVersion,
  };
}

async function membershipCapabilities(config) {
  const value = await request(config, "/v1/account/capabilities");
  const membership = value?.membership;
  const purchase = membership?.purchase;
  const plans = purchase?.plans;
  if (
    !["free", "premium", "pro"].includes(membership?.tier) ||
    typeof membership?.policyVersion !== "string" ||
    !membership.policyVersion ||
    !["sufficient", "running_low", "exhausted"].includes(
      membership?.allowanceState,
    ) ||
    (membership.usageMultiplier !== null &&
      (!Number.isSafeInteger(membership.usageMultiplier) ||
        membership.usageMultiplier < 1)) ||
    typeof membership.legacyTerm !== "boolean" ||
    typeof membership.fileIntakeEnabled !== "boolean" ||
    !Number.isSafeInteger(membership.maxFileBytes) ||
    membership.maxFileBytes < 1 ||
    (membership.termExpiresAt !== null &&
      (typeof membership.termExpiresAt !== "string" ||
        Number.isNaN(Date.parse(membership.termExpiresAt)))) ||
    typeof purchase?.enabled !== "boolean" ||
    !Array.isArray(plans) ||
    plans.length !== 2 ||
    !plans.every(
      (plan) =>
        ["premium", "pro"].includes(plan?.tier) &&
        Number.isSafeInteger(plan.amountCents) &&
        plan.amountCents > 0 &&
        (plan.action === null ||
          ["open", "upgrade", "reopen", "renew", "resume"].includes(
            plan.action,
          )),
    )
  ) {
    throw new BrainPostError(
      "invalid_response",
      "BrainPost returned invalid membership capabilities.",
      5,
    );
  }
  const recoveryPlan = purchase.enabled
    ? plans.find((plan) => plan.action !== null)
    : null;
  const recovery =
    membership.allowanceState === "exhausted" && recoveryPlan
      ? { action: recoveryPlan.action, url: membershipUrl }
      : null;
  return {
    tier: membership.tier,
    allowanceState: membership.allowanceState,
    usageMultiplier: membership.usageMultiplier,
    legacyTerm: membership.legacyTerm,
    fileIntakeEnabled: membership.fileIntakeEnabled,
    maxFileBytes: membership.maxFileBytes,
    termExpiresAt: membership.termExpiresAt,
    purchaseEnabled: purchase.enabled,
    ...(recovery ? { recovery } : {}),
  };
}

async function enrichAllowanceError(error, config) {
  if (
    !(error instanceof BrainPostError) ||
    !["daily_task_limit_reached", "task_allowance_exhausted"].includes(
      error.code,
    )
  ) {
    return error;
  }
  const membership = await membershipCapabilities(config).catch(() => null);
  if (!membership) return error;
  error.details = {
    ...error.details,
    membership,
    ...(membership.recovery ? { recovery: membership.recovery } : {}),
  };
  error.message = membership.recovery
    ? membership.tier === "free"
      ? `BrainPost trial allowance is exhausted. Open Advanced or Pro: ${membershipUrl}`
      : membership.tier === "premium"
        ? `BrainPost Advanced allowance is exhausted. Upgrade to Pro: ${membershipUrl}`
        : `BrainPost Pro allowance is exhausted. Reopen Pro: ${membershipUrl}`
    : "BrainPost allowance is exhausted. Membership purchase is currently unavailable.";
  return error;
}

async function showCapabilities(configPath) {
  const config = (await loadConfig(configPath)) ?? configurationRequired();
  process.stdout.write(
    `${JSON.stringify({ ok: true, membership: await membershipCapabilities(config) })}\n`,
  );
}

function stableReason(value, fallback) {
  return value === null
    ? null
    : typeof value === "string" && stableFailureReasons.has(value)
      ? value
      : fallback;
}

async function showStatus(args, configPath) {
  const parsed = options(args, new Set(["--intake", "--capture"]));
  const modes = ["--intake", "--capture"].filter((name) => parsed.has(name));
  if (modes.length !== 1 || !uuid.test(parsed.get(modes[0]) ?? "")) {
    throw new BrainPostError(
      "usage_error",
      "Choose one valid Intake or Capture UUID.",
      2,
    );
  }
  const kind = modes[0] === "--capture" ? "capture" : "intake";
  const id = parsed.get(modes[0]);
  const config = (await loadConfig(configPath)) ?? configurationRequired();
  const value = await request(config, `/v1/${kind}s/${id}`);
  if (kind === "capture") {
    if (value?.id !== id || !captureStatuses.has(value?.status)) {
      throw new BrainPostError(
        "invalid_response",
        "BrainPost returned an invalid Capture status.",
        5,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        capture: {
          id,
          status: value.status,
          failureReason: stableReason(value.failureReason, "processing_failed"),
        },
      })}\n`,
    );
    return;
  }
  if (
    value?.id !== id ||
    !intakeStatuses.has(value?.status) ||
    !deliveryStatuses.has(value?.deliveryStatus) ||
    typeof value?.retryable !== "boolean"
  ) {
    throw new BrainPostError(
      "invalid_response",
      "BrainPost returned an invalid Intake status.",
      5,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      intake: {
        id,
        status: value.status,
        failureReason: stableReason(value.failureReason, "processing_failed"),
        refusalReason: stableReason(value.refusalReason, "refused"),
        deliveryStatus: value.deliveryStatus,
        retryable: value.retryable,
      },
    })}\n`,
  );
}

async function configure(args, configPath) {
  const parsed = options(args, new Set(["--api"]));
  const apiUrl = apiBase(
    parsed.get("--api") ??
      process.env.BRAINPOST_API_URL ??
      "https://brainpost.me/api",
  );
  const token = identityToken((await readStdin(512)).trim());
  const vault = await defaultVault({ apiUrl, token });
  await saveConfig(configPath, { apiUrl, token });
  process.stdout.write(
    `${JSON.stringify({ ok: true, config: { apiUrl, defaultVault: vault?.projectName ?? null, pendingDelivery: !vault, tokenConfigured: true } })}\n`,
  );
}

async function submitDocumentFile(config, path, idempotencyKey) {
  if (!isAbsolute(path)) {
    throw new BrainPostError(
      "input_error",
      "Document path must be absolute.",
      4,
    );
  }
  const filename = basename(path);
  const extension = extname(filename).toLowerCase();
  if (!documentExtensions.has(extension)) {
    throw new BrainPostError(
      "input_error",
      "File type is not supported for document conversion.",
      4,
    );
  }
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new BrainPostError("input_error", "Document could not be read.", 4);
  }
  if (!details.isFile() || details.size < 1) {
    throw new BrainPostError(
      "input_error",
      "Document must be a non-empty regular file.",
      4,
    );
  }
  const mediaType = mediaTypes[extension] ?? "application/octet-stream";
  try {
    const membership = await membershipCapabilities(config);
    if (!membership.fileIntakeEnabled) {
      throw new BrainPostError(
        "membership_file_not_supported",
        `File organization is a Pro benefit. Open membership: ${membershipUrl}`,
        5,
        { membership },
      );
    }
    if (details.size > membership.maxFileBytes) {
      throw new BrainPostError(
        "file_too_large",
        "Document exceeds the current BrainPost file limit.",
        4,
        { membership },
      );
    }
    const bytes = await readFile(path).catch(() => {
      throw new BrainPostError("input_error", "Document could not be read.", 4);
    });
    const authorization = await request(config, "/v1/file-intakes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        filename,
        mediaType,
        byteSize: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    });
    if (
      !uuid.test(authorization?.id ?? "") ||
      authorization?.uploadPath !== `/v1/file-uploads/${authorization.id}`
    ) {
      throw new BrainPostError(
        "invalid_response",
        "BrainPost returned an invalid file authorization.",
        5,
      );
    }
    await request(config, authorization.uploadPath, {
      method: "PUT",
      headers: { "content-type": mediaType },
      body: bytes,
    });
    const capture = await request(
      config,
      `/v1/file-intakes/${authorization.id}/commit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ client: "skill" }),
      },
    );
    if (
      !uuid.test(capture?.id ?? "") ||
      !captureStatuses.has(capture?.status)
    ) {
      throw new BrainPostError(
        "invalid_response",
        "BrainPost returned an invalid file Capture.",
        5,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, file: { captureId: capture.id, filename, status: capture.status } })}\n`,
    );
  } catch (error) {
    error = await enrichAllowanceError(error, config);
    if (error instanceof BrainPostError) {
      error.details = { ...error.details, idempotencyKey };
    }
    throw error;
  }
}

async function capture(args, configPath) {
  const parsed = options(
    args,
    new Set(["--url", "--file", "--stdin", "--idempotency-key"]),
    new Set(["--stdin"]),
  );
  const modes = ["--url", "--file", "--stdin"].filter((name) =>
    parsed.has(name),
  );
  if (modes.length !== 1) {
    throw new BrainPostError(
      "usage_error",
      "Choose exactly one input: --url, --file or --stdin.",
      2,
    );
  }
  const config = (await loadConfig(configPath)) ?? configurationRequired();
  const suppliedKey = parsed.get("--idempotency-key");
  if (suppliedKey !== undefined && !uuid.test(suppliedKey)) {
    throw new BrainPostError(
      "usage_error",
      "Idempotency key must be a UUID.",
      2,
    );
  }
  const idempotencyKey = suppliedKey ?? randomUUID();

  let body;
  if (parsed.has("--url")) {
    const value = parsed.get("--url");
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error();
    } catch {
      throw new BrainPostError("input_error", "URL must use HTTP(S).", 4);
    }
    body = { url: value, client: "skill" };
  } else {
    let content;
    if (parsed.has("--file")) {
      const path = parsed.get("--file");
      if (documentExtensions.has(extname(path).toLowerCase())) {
        return submitDocumentFile(config, path, idempotencyKey);
      }
      if (!isAbsolute(path)) {
        throw new BrainPostError(
          "input_error",
          "Markdown path must be absolute.",
          4,
        );
      }
      if (![".md", ".markdown"].includes(extname(path).toLowerCase())) {
        throw new BrainPostError(
          "input_error",
          "Use --file with Markdown or a supported document type.",
          4,
        );
      }
      let details;
      try {
        details = await stat(path);
      } catch {
        throw new BrainPostError(
          "input_error",
          "Markdown file could not be read.",
          4,
        );
      }
      if (!details.isFile() || details.size > maxContentBytes) {
        throw new BrainPostError(
          "input_error",
          "Markdown must be a regular file no larger than 262,144 bytes.",
          4,
        );
      }
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          await readFile(path),
        );
      } catch {
        throw new BrainPostError(
          "input_error",
          "Markdown must be valid UTF-8 text.",
          4,
        );
      }
    } else {
      content = await readStdin(maxContentBytes);
    }
    if (!content.trim()) {
      throw new BrainPostError(
        "input_error",
        "Input content cannot be empty.",
        4,
      );
    }
    body = {
      content,
      client: "skill",
    };
  }

  let value;
  try {
    value = await request(config, "/v1/intakes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    error = await enrichAllowanceError(error, config);
    if (error instanceof BrainPostError) {
      error.details = { ...error.details, idempotencyKey };
    }
    throw error;
  }
  if (
    !uuid.test(value?.intakeId ?? "") ||
    !captureStatuses.has(value?.status)
  ) {
    throw new BrainPostError(
      "invalid_response",
      "BrainPost returned an invalid Intake result.",
      5,
      { idempotencyKey },
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, intake: { id: value.intakeId, status: value.status, statusUrl: value.statusUrl } })}\n`,
  );
}

async function main(args) {
  const configPath =
    process.env.BRAINPOST_CONFIG ??
    join(homedir(), ".config", "brainpost", "config.json");
  const [command, ...rest] = args;
  if (command === "configure") return configure(rest, configPath);
  if (command === "capabilities" && rest.length === 0)
    return showCapabilities(configPath);
  if (command === "status") return showStatus(rest, configPath);
  if (command === "capture") return capture(rest, configPath);
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
      : new BrainPostError(
          "unexpected_error",
          "BrainPost could not complete the request.",
        );
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
