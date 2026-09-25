/**
 * 安全校验：确认改过的桌面 profile 清单文件能被真实解析器解析。
 * 用法: node test/verify-manifests.mjs <profileDir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const profileDir = process.argv[2] ?? 'C:/Users/ROG/.dsh-community/profiles/desktop';
const appModules = 'C:/Users/ROG/AppData/Local/Programs/DeepSeek Harness Desktop/resources/app.asar.unpacked/node_modules/';
const profileModules = 'C:/Users/ROG/.dsh-community/profiles/node_modules/';

let failures = 0;
const ok = (label, detail) => console.log(`   PASS  ${label}${detail === undefined ? '' : `  (${detail})`}`);
const bad = (label, detail) => {
  failures += 1;
  console.log(`   FAIL  ${label}  ${detail}`);
};

// --- package.json ----------------------------------------------------------
const manifestPath = join(profileDir, 'package.json');
const raw = readFileSync(manifestPath);
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) bad('package.json has no BOM', 'found UTF-8 BOM (JSON.parse would throw)');
else ok('package.json has no BOM');
try {
  const manifest = JSON.parse(raw.toString('utf8'));
  const deps = Object.keys(manifest.dependencies ?? {});
  ok('package.json parses', `${deps.length} dependencies`);
  const ours = manifest.dependencies?.['@linxin666/dsh-prompt-enhancer'];
  if (ours === undefined) bad('prompt-enhancer dependency present', 'missing');
  else ok('prompt-enhancer dependency present', ours);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) bad('dsh.profile.bundles intact', 'not an array');
  else ok('dsh.profile.bundles intact', `${manifest.dsh.profile.bundles.length} bundles`);
} catch (error) {
  bad('package.json parses', error.message);
}

// --- cordis.patch.yml ------------------------------------------------------
const patchPath = join(profileDir, 'cordis.patch.yml');
const patchText = readFileSync(patchPath, 'utf8');
let yaml = null;
for (const anchor of [appModules, profileModules]) {
  try {
    const require = createRequire(anchor);
    yaml = require('js-yaml');
    break;
  } catch {
    try {
      const require = createRequire(anchor);
      yaml = require('yaml');
      break;
    } catch {
      /* try next anchor */
    }
  }
}
if (yaml === null) {
  console.log('   SKIP  yaml parser not found in app/profile node_modules');
} else {
  try {
    const parsed = typeof yaml.load === 'function' ? yaml.load(patchText) : yaml.parse(patchText);
    if (!Array.isArray(parsed)) bad('cordis.patch.yml parses to an array', `got ${typeof parsed}`);
    else {
      ok('cordis.patch.yml parses to an array', `${parsed.length} entries`);
      const hit = JSON.stringify(parsed).includes('prompt-enhancer');
      if (hit) ok('patch contains the prompt-enhancer insert');
      else bad('patch contains the prompt-enhancer insert', 'not found in parsed tree');
    }
  } catch (error) {
    bad('cordis.patch.yml parses', error.message.split('\n')[0]);
  }
}

console.log(failures === 0 ? '\n   ALL MANIFEST CHECKS PASSED' : `\n   ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
