#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackagePath = path.join(repoDir, "package.json");
const daemonPackagePath = path.join(repoDir, "daemon", "package.json");
const cargoTomlPath = path.join(repoDir, "cli", "Cargo.toml");
const cliDaemonPath = path.join(repoDir, "cli", "src", "daemon.rs");
const embeddedDaemonPath = path.join(repoDir, "daemon", "src", "daemon.ts");
const expectedPnpmPackageManager = "pnpm@10.33.0";
const runtimeDependencyNames = ["patchright", "patchright-core", "quickjs-emscripten"];
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const forbiddenLifecycleScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
  "prepack",
  "postpack",
];

function fail(message) {
  console.error(`- ${message}`);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function findTomlString(source, key) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  return match?.[1];
}

function hasTomlBoolean(source, key, expected) {
  return new RegExp(`^${key}\\s*=\\s*${expected ? "true" : "false"}\\s*$`, "m").test(source);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findEmbeddedDependencyVersion(source, packageName) {
  const escapedPackageName = escapeRegExp(packageName);
  const match = source.match(new RegExp(`"?${escapedPackageName}"?\\s*:\\s*"([^"]+)"`));
  return match?.[1];
}

function collectLifecycleErrors(pkg, packagePath, errors) {
  const scripts = pkg.scripts ?? {};
  for (const name of forbiddenLifecycleScripts) {
    if (Object.hasOwn(scripts, name)) {
      errors.push(`${packagePath} must not define npm lifecycle script "${name}"`);
    }
  }
}

async function main() {
  const [rootPackageRaw, daemonPackageRaw, cargoToml, cliDaemonSource, embeddedDaemonSource] = await Promise.all([
    readFile(rootPackagePath, "utf8"),
    readFile(daemonPackagePath, "utf8"),
    readFile(cargoTomlPath, "utf8"),
    readFile(cliDaemonPath, "utf8"),
    readFile(embeddedDaemonPath, "utf8"),
  ]);

  const rootPackage = JSON.parse(rootPackageRaw);
  const daemonPackage = JSON.parse(daemonPackageRaw);
  const errors = [];

  if (rootPackage.private !== true) {
    errors.push("package.json must remain private");
  }

  if (daemonPackage.private !== true) {
    errors.push("daemon/package.json must remain private");
  }

  if (rootPackage.engines?.node !== ">=22") {
    errors.push("package.json engines.node must be >=22");
  }

  if (rootPackage.engines?.pnpm !== ">=10") {
    errors.push("package.json engines.pnpm must document the required pnpm major version");
  }

  if (rootPackage.packageManager !== expectedPnpmPackageManager) {
    errors.push(`package.json packageManager must stay pinned to ${expectedPnpmPackageManager}`);
  }

  if (daemonPackage.packageManager !== expectedPnpmPackageManager) {
    errors.push(`daemon/package.json packageManager must stay pinned to ${expectedPnpmPackageManager}`);
  }

  if (rootPackage.repository?.url !== "git+https://github.com/johnkozaris/web-interact.git") {
    errors.push("package.json repository.url must point at the GitHub repository");
  }

  if (rootPackage.homepage !== "https://github.com/johnkozaris/web-interact") {
    errors.push("package.json homepage must point at the GitHub repository");
  }

  if (rootPackage.version !== findTomlString(cargoToml, "version")) {
    errors.push("package.json version must stay in sync with cli/Cargo.toml");
  }

  collectLifecycleErrors(rootPackage, "package.json", errors);
  collectLifecycleErrors(daemonPackage, "daemon/package.json", errors);

  for (const [scriptName, scriptBody] of Object.entries(rootPackage.scripts ?? {})) {
    if (/\bnpm\b/.test(scriptBody)) {
      errors.push(`package.json script "${scriptName}" must not call npm directly`);
    }
  }

  if (findTomlString(cargoToml, "repository") !== "https://github.com/johnkozaris/web-interact") {
    errors.push("cli/Cargo.toml repository must point at the GitHub repository");
  }

  if (await fileExists(path.join(repoDir, "scripts", "postinstall.js"))) {
    errors.push("scripts/postinstall.js must not exist in the source repo");
  }

  if (await fileExists(path.join(repoDir, "bin", "web-interact.js"))) {
    errors.push("bin/web-interact.js must not exist in the source repo");
  }

  if (await fileExists(path.join(repoDir, "package-lock.json"))) {
    errors.push("package-lock.json must not exist; use pnpm lockfiles only");
  }

  for (const dependencyName of runtimeDependencyNames) {
    const daemonVersion = daemonPackage.dependencies?.[dependencyName];
    if (typeof daemonVersion !== "string" || !exactVersionPattern.test(daemonVersion)) {
      errors.push(`daemon/package.json must pin ${dependencyName} to an exact version`);
      continue;
    }

    const cliEmbeddedVersion = findEmbeddedDependencyVersion(cliDaemonSource, dependencyName);
    if (cliEmbeddedVersion !== daemonVersion) {
      errors.push(`cli/src/daemon.rs must embed ${dependencyName}@${daemonVersion}`);
    }

    const daemonEmbeddedVersion = findEmbeddedDependencyVersion(embeddedDaemonSource, dependencyName);
    if (daemonEmbeddedVersion !== daemonVersion) {
      errors.push(`daemon/src/daemon.ts must embed ${dependencyName}@${daemonVersion}`);
    }
  }

  if (errors.length > 0) {
    console.error("Repo policy check failed:");
    for (const error of errors) {
      fail(error);
    }
    process.exit(1);
  }

  console.log("Repo policy OK");
}

await main();
