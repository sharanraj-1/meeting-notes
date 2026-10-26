// Reads the running local Supabase's URL and secret key from
// `supabase status` and writes them into .env (creating it from
// .env.example if needed). Run after `npm run db:start`.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

let status;
try {
  const out = execFileSync('npx', ['--no-install', 'supabase', 'status', '-o', 'json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  status = JSON.parse(out.slice(out.indexOf('{')));
} catch (err) {
  console.error("Couldn't read Supabase status. Is it running? Try `npm run db:start` first.");
  console.error(err.stderr?.toString() || err.message);
  process.exit(1);
}

const url = status.API_URL;
const key = status.SECRET_KEY || status.SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Supabase status did not include API_URL and a secret/service role key:', Object.keys(status));
  process.exit(1);
}

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.readFileSync(examplePath, 'utf8');
const set = (name, value) => {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
};
set('SUPABASE_URL', url);
set('SUPABASE_SECRET_KEY', key);
fs.writeFileSync(envPath, env);

console.log(`Wrote SUPABASE_URL=${url} and SUPABASE_SECRET_KEY to .env`);
console.log(`Studio (database UI): ${status.STUDIO_URL ?? 'http://127.0.0.1:54323'}`);
