#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const cliDir = join(projectRoot, 'cli');
const npmDir = join(projectRoot, 'npm');

const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;

console.log(`Syncing all manifests to version ${version}...`);

// 1. Sync cli/Cargo.toml
const cargoTomlPath = join(cliDir, 'Cargo.toml');
let cargoToml = readFileSync(cargoTomlPath, 'utf8');
const versionPattern = /^version\s*=\s*"[^"]*"$/m;
const versionLine = `version = "${version}"`;

if (!cargoToml.includes(versionLine)) {
  cargoToml = cargoToml.replace(versionPattern, versionLine);
  writeFileSync(cargoTomlPath, cargoToml);
  console.log(`  cli/Cargo.toml → ${version}`);
  try {
    execSync('cargo update -p web-interact --offline', { cwd: cliDir, stdio: 'pipe' });
  } catch {
    try { execSync('cargo update -p web-interact', { cwd: cliDir, stdio: 'pipe' }); } catch {}
  }
}

// 2. Sync daemon/package.json
const daemonPkgPath = join(projectRoot, 'daemon', 'package.json');
const daemonPkg = JSON.parse(readFileSync(daemonPkgPath, 'utf8'));
if (daemonPkg.version !== version) {
  daemonPkg.version = version;
  writeFileSync(daemonPkgPath, JSON.stringify(daemonPkg, null, 2) + '\n');
  console.log(`  daemon/package.json → ${version}`);
}

// 3. Sync npm/package.json + optionalDependencies
const npmPkgPath = join(npmDir, 'package.json');
const npmPkg = JSON.parse(readFileSync(npmPkgPath, 'utf8'));
let npmChanged = false;
if (npmPkg.version !== version) {
  npmPkg.version = version;
  npmChanged = true;
}
for (const dep of Object.keys(npmPkg.optionalDependencies || {})) {
  if (npmPkg.optionalDependencies[dep] !== version) {
    npmPkg.optionalDependencies[dep] = version;
    npmChanged = true;
  }
}
if (npmChanged) {
  writeFileSync(npmPkgPath, JSON.stringify(npmPkg, null, 2) + '\n');
  console.log(`  npm/package.json → ${version} (+ optionalDependencies)`);
}

// 4. Sync npm/packages/*/package.json
const platformDir = join(npmDir, 'packages');
for (const platform of readdirSync(platformDir)) {
  const pkgPath = join(platformDir, platform, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== version) {
      pkg.version = version;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`  npm/packages/${platform}/package.json → ${version}`);
    }
  } catch {}
}

console.log('Done.');
