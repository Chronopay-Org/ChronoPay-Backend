const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err && err.stack ? err.stack : err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
  process.exit(1);
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PR_NUMBER = process.env.PR_NUMBER;
const BASE_SHA = process.env.BASE_SHA;
const HEAD_SHA = process.env.HEAD_SHA;
const REPO = process.env.GITHUB_REPOSITORY;

async function fetchOSV(pkgName, version) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      version: version,
      package: { name: pkgName, ecosystem: 'npm' }
    });

    const req = https.request('https://api.osv.dev/v1/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({});
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getPackageName(key) {
  if (key === '') return '';
  const parts = key.split('node_modules/');
  return parts.pop();
}

async function run() {
  if (!GITHUB_TOKEN || !PR_NUMBER || !BASE_SHA || !HEAD_SHA || !REPO) {
    console.log("Missing required environment variables for dep-alerter.");
    return;
  }

  let baseLock, headLock;
  try {
    execSync(`git checkout ${BASE_SHA} -- package-lock.json`);
    baseLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  } catch (e) {
    baseLock = { packages: {} };
  }

  try {
    execSync(`git checkout ${HEAD_SHA} -- package-lock.json`);
    headLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  } catch (e) {
    headLock = { packages: {} };
  }

  // Restore working tree state
  try {
    execSync(`git checkout HEAD -- package-lock.json`);
  } catch (e) {}

  const baseDeps = baseLock.packages || baseLock.dependencies || {};
  const headDeps = headLock.packages || headLock.dependencies || {};

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, value] of Object.entries(headDeps)) {
    if (key === "") continue;
    const pkgName = getPackageName(key);
    if (!pkgName) continue;
    
    if (!baseDeps[key]) {
      added.push({ name: pkgName, version: value.version });
    } else if (baseDeps[key].version !== value.version) {
      changed.push({ name: pkgName, old: baseDeps[key].version, new: value.version });
    }
  }

  for (const [key, value] of Object.entries(baseDeps)) {
    if (key === "") continue;
    const pkgName = getPackageName(key);
    if (!pkgName) continue;
    
    if (!headDeps[key]) {
      removed.push({ name: pkgName, version: value.version });
    }
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log("No dependency changes.");
    return;
  }

  let comment = '## Dependency Graph Changes\n\n';

  if (added.length > 0) {
    comment += '### Added\n';
    for (const pkg of added) {
      const osv = await fetchOSV(pkg.name, pkg.version);
      const isRisky = osv.vulns && osv.vulns.length > 0;
      const tag = isRisky ? ' 🚨 **RISKY**' : '';
      comment += `- \`${pkg.name}@${pkg.version}\`${tag}\n`;
      if (isRisky) {
        for (const vuln of osv.vulns) {
          comment += `  - [${vuln.id}](https://osv.dev/vulnerability/${vuln.id})\n`;
        }
      }
    }
    comment += '\n';
  }

  if (changed.length > 0) {
    comment += '### Changed\n';
    for (const pkg of changed) {
      const osv = await fetchOSV(pkg.name, pkg.new);
      const isRisky = osv.vulns && osv.vulns.length > 0;
      const tag = isRisky ? ' 🚨 **RISKY**' : '';
      comment += `- \`${pkg.name}\` (\`${pkg.old}\` -> \`${pkg.new}\`)${tag}\n`;
      if (isRisky) {
        for (const vuln of osv.vulns) {
          comment += `  - [${vuln.id}](https://osv.dev/vulnerability/${vuln.id})\n`;
        }
      }
    }
    comment += '\n';
  }

  if (removed.length > 0) {
    comment += '### Removed\n';
    for (const pkg of removed) {
      comment += `- \`${pkg.name}@${pkg.version}\`\n`;
    }
    comment += '\n';
  }

  const postData = JSON.stringify({ body: comment });
  const req = https.request(`https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'Node.js',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, (res) => {
    console.log('Comment posted. Status:', res.statusCode);
  });
  
  req.on('error', (e) => {
    console.error('Error posting comment:', e);
  });
  req.write(postData);
  req.end();
}

run().catch(console.error);
