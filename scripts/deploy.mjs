// A játék feltöltése a felhős gépre (Oracle). A felho-frissites.bat hívja.
//
// 1. összeállítja a játékot és a szervert a .deploy/ mappába (a futó otthoni szerver dist/ mappáját nem bántja),
// 2. becsomagolja, és SSH-n feltölti a gépre (a gép címe a felho.txt első sorában: pl. ubuntu@1.2.3.4),
// 3. a gépen kicseréli a régi változatot az újra, és újraindítja a szervert.
//
// A fiókok, a nyitott játékok és a statisztika a gépen külön mappában vannak (/opt/tank/data, /opt/tank/logs),
// a frissítés nem nyúl hozzájuk.
//
// Használat: node scripts/deploy.mjs [--setup]
//   --setup: a szolgáltatás (deploy/tank.service) telepítése is (első alkalommal, vagy ha a fájl változott)

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.deploy');
const ARCHIVE = path.join(ROOT, '.deploy.tgz');
const KEY = path.join(homedir(), '.ssh', 'oracle_tank');
const setup = process.argv.includes('--setup');

const hostFile = path.join(ROOT, 'felho.txt');
if (!existsSync(hostFile)) {
  console.error('Hiányzik a felho.txt (első sorában a gép címe, pl. ubuntu@1.2.3.4).');
  process.exit(1);
}
const HOST = readFileSync(hostFile, 'utf8').split(/\r?\n/)[0].trim();
if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(HOST)) {
  console.error('A felho.txt első sora nem jó cím: ' + HOST);
  process.exit(1);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
const ssh = (script) => run('ssh', ['-i', KEY, '-o', 'BatchMode=yes', HOST, 'bash -se'], { input: script, stdio: ['pipe', 'inherit', 'inherit'] });
const scp = (from, to) => run('scp', ['-i', KEY, '-o', 'BatchMode=yes', '-q', from, `${HOST}:${to}`]);

console.log('1/3 A játék és a szerver összeállítása...');
run('node', ['scripts/version.mjs']);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'dist-server'), { recursive: true });
mkdirSync(path.join(OUT, 'assets/maps/processed'), { recursive: true });
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', '.deploy/dist', '--emptyOutDir', '--logLevel', 'warn']);
run(process.execPath, ['node_modules/esbuild/bin/esbuild', 'server/main.ts', '--bundle', '--platform=node', '--format=esm', '--target=node20', '--outfile=.deploy/dist-server/server.mjs', '--external:ws', '--log-level=warning']);
copyFileSync(path.join(ROOT, 'assets/maps/processed/misleny-kozpont.json'), path.join(OUT, 'assets/maps/processed/misleny-kozpont.json'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ name: pkg.name, private: true, type: 'module', dependencies: { ws: pkg.dependencies.ws } }, null, 2));
const version = JSON.parse(readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;

console.log('2/3 Feltöltés: ' + HOST);
rmSync(ARCHIVE, { force: true });
// a Windows saját tar-ja (System32) kell: a Git Bash-é a C: meghajtót távoli gépnek nézné
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
run(tar, ['-czf', ARCHIVE, '-C', OUT, '.']);
// relatív utak: a scp a 'C:' előtagot gépnévnek nézhetné
scp('.deploy.tgz', '/tmp/tank-release.tgz');
if (setup) {
  scp('deploy/tank.service', '/tmp/tank.service');
  scp('deploy/tank-mentes', '/tmp/tank-mentes');
}
// a szolgáltatás és a napi mentés telepítése (a Windows-os sorvégeket levágja)
const SETUP = String.raw`sed -i "s/\r$//" /tmp/tank.service /tmp/tank-mentes
sudo install -m 644 /tmp/tank.service /etc/systemd/system/tank.service
sudo install -m 755 /tmp/tank-mentes /etc/cron.daily/tank-mentes
rm -f /tmp/tank.service /tmp/tank-mentes
sudo systemctl daemon-reload
sudo systemctl enable tank >/dev/null 2>&1`;

console.log('3/3 Csere és újraindítás a gépen...');
ssh(`set -e
sudo mkdir -p /opt/tank/data /opt/tank/logs
sudo chmod 755 /opt/tank
sudo chown tank:tank /opt/tank/data /opt/tank/logs
sudo chmod 750 /opt/tank/data /opt/tank/logs
sudo rm -rf /opt/tank/app-new && sudo mkdir -p /opt/tank/app-new
sudo tar -xzf /tmp/tank-release.tgz -C /opt/tank/app-new --no-same-owner
sudo chmod -R u=rwX,go=rX /opt/tank/app-new
rm -f /tmp/tank-release.tgz
sudo npm --prefix /opt/tank/app-new install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
sudo chown -R root:root /opt/tank/app-new
${setup ? SETUP : ''}
sudo rm -rf /opt/tank/app-old
if sudo test -d /opt/tank/app; then sudo mv /opt/tank/app /opt/tank/app-old; fi
sudo mv /opt/tank/app-new /opt/tank/app
sudo systemctl restart tank
sleep 2
if systemctl is-active --quiet tank && curl -fsS -o /dev/null http://127.0.0.1:8787/; then
  echo "A szerver fut."
else
  echo "HIBA: a szerver nem indult el. Napló:"; sudo journalctl -u tank -n 30 --no-pager
  if sudo test -d /opt/tank/app-old; then
    echo "Visszaállás az előző változatra..."
    sudo rm -rf /opt/tank/app-failed && sudo mv /opt/tank/app /opt/tank/app-failed && sudo mv /opt/tank/app-old /opt/tank/app && sudo systemctl restart tank
  fi
  exit 1
fi
`);
rmSync(ARCHIVE, { force: true });

// biztonsági másolat a felhős adatokról ide, a saját gépre is (mentes/, git-ből kihagyva)
try {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  mkdirSync(path.join(ROOT, 'mentes'), { recursive: true });
  ssh('sudo tar -czf /tmp/tank-adatok.tgz -C /opt/tank data logs && sudo chown "$(id -u)" /tmp/tank-adatok.tgz');
  run('scp', ['-i', KEY, '-o', 'BatchMode=yes', '-q', `${HOST}:/tmp/tank-adatok.tgz`, `mentes/felho-${stamp}.tgz`]);
  ssh('rm -f /tmp/tank-adatok.tgz');
  console.log(`Az adatok másolata: mentes\\felho-${stamp}.tgz`);
} catch {
  console.log('Az adatok másolatát most nem sikerült letölteni.');
}
console.log(`Kész: a ${version} verzió fut a felhőben.`);
