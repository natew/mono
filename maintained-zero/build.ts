import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2]);
mkdirSync(output, {recursive: true});
const archive = join(output, 'upstream-zero-1.9.0.tgz');
const upstream = await fetch(
  'https://registry.npmjs.org/@rocicorp/zero/-/zero-1.9.0.tgz',
);
if (!upstream.ok)
  throw new Error(`upstream download failed: ${upstream.status}`);
const bytes = new Uint8Array(await upstream.arrayBuffer());
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
if (
  integrity !==
  'sha512-2huSS0rHOEfzjPP5K7SrndBuJfchhBCW3VHiSnPhTpmtH9ivvA44jqbBygCN9/d44pP9T2dzNxghiYiIWGMn5A=='
) {
  throw new Error('upstream tarball integrity changed');
}
writeFileSync(archive, bytes);
const stage = join(output, 'stage');
mkdirSync(stage);
execFileSync('tar', ['-xzf', archive, '-C', stage]);
const pkg = join(stage, 'package');
execFileSync('git', ['apply', join(here, 'zero-1.9.0.patch')], {cwd: pkg});
for (const relative of [
  'out/replicache/src/replicache-impl.js',
  'out/replicache/src/persist/collect-idb-databases.js',
]) {
  const filename = join(pkg, relative);
  // the upstream maps describe different code. ship the actual javascript as debug source.
  writeFileSync(
    filename,
    readFileSync(filename, 'utf8').replace(
      /\n\/\/# sourceMappingURL=.*\s*$/,
      '\n',
    ),
  );
  rmSync(`${filename}.map`);
}
const source = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: here,
  encoding: 'utf8',
}).trim();
const manifestPath = join(pkg, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.name = '@natew/zero';
manifest.version = '1.9.0-orez.1';
manifest.description =
  'Maintained Zero 1.9.0 with database handle and closed-client snapshot cleanup';
manifest.repository = {
  type: 'git',
  url: 'git+https://github.com/natew/mono.git',
  directory: 'maintained-zero',
};
manifest.bugs = {url: 'https://github.com/natew/mono/issues'};
manifest.releaseSourceCommit = source;
manifest.upstreamVersion = '1.9.0';
manifest.upstreamIntegrity = integrity;
manifest.files.push('LICENSE', 'MAINTAINED.md');
if (process.argv.includes('--client')) {
  const {clientPackage} = await import('./client-package.ts');
  console.error(JSON.stringify(clientPackage(pkg, manifest)));
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(here, '..', 'LICENSE'), join(pkg, 'LICENSE'));
copyFileSync(join(here, 'README.md'), join(pkg, 'MAINTAINED.md'));
const result = JSON.parse(
  execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', output],
    {cwd: pkg, encoding: 'utf8'},
  ),
);
console.log(
  JSON.stringify({
    package: manifest.name,
    version: manifest.version,
    source,
    filename: join(output, result[0].filename),
    integrity: result[0].integrity,
  }),
);
