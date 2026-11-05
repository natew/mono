import {existsSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {isBuiltin} from 'node:module';
import {join, posix} from 'node:path';
import ts from 'typescript';

// keep the client graph byte-for-byte, including declarations and their imports.
export function clientPackage(root: string, manifest: any) {
  const exports = Object.fromEntries(
    [
      '.',
      './react',
      './solid',
      './react-native',
      './expo-sqlite',
      './op-sqlite',
      './sqlite',
      './change-protocol/v0',
      './bindings',
      './server',
    ].map(name => [name, manifest.exports[name]]),
  );
  const files = new Set<string>();
  const external = new Set<string>();
  function visit(file: string) {
    if (files.has(file)) return;
    files.add(file);
    if (existsSync(join(root, `${file}.map`))) files.add(`${file}.map`);
    if (!/\.(js|ts)$/.test(file)) return;
    const source = ts.preProcessFile(
      readFileSync(join(root, file), 'utf8'),
      true,
      true,
    );
    for (const {fileName: specifier} of [
      ...source.importedFiles,
      ...source.referencedFiles,
    ]) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) {
        external.add(
          specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0],
        );
        continue;
      }
      let target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (file.endsWith('.d.ts') && /\.[jt]sx?$/.test(target)) {
        const declaration = target.replace(/\.[jt]sx?$/, '.d.ts');
        if (existsSync(join(root, declaration))) target = declaration;
      }
      if (!target.startsWith('out/') || !existsSync(join(root, target))) {
        throw new Error(`unresolved client import: ${file} -> ${specifier}`);
      }
      visit(target);
    }
    for (const {fileName} of source.typeReferenceDirectives)
      external.add(fileName);
  }
  for (const entry of Object.values(exports)) {
    for (const file of Object.values(entry as Record<string, string>))
      visit(file.replace(/^\.\//, ''));
  }
  function prune(directory: string) {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) prune(file);
      else if (!files.has(file)) rmSync(join(root, file));
    }
    if (!readdirSync(join(root, directory)).length)
      rmSync(join(root, directory), {recursive: true});
  }
  const adapters: Record<string, string> = {
    'react': '^19.0.0',
    'solid-js': '^1.9.0',
    'expo-sqlite': '>=15',
    '@op-engineering/op-sqlite': '>=15',
  };
  const dependencies: Record<string, string> = {};
  const peers: Record<string, string> = {};
  for (const name of [...external].sort()) {
    if (manifest.dependencies[name])
      dependencies[name] = manifest.dependencies[name];
    else if (adapters[name]) peers[name] = adapters[name];
    else throw new Error(`unclassified client dependency: ${name}`);
  }
  prune('out');
  manifest.name = '@natew/zero-client';
  manifest.version = '1.9.0-orez.2-client.1';
  manifest.description =
    'Maintained Zero 1.9.0 client without server dependencies';
  manifest.exports = exports;
  manifest.dependencies = dependencies;
  manifest.peerDependencies = peers;
  manifest.peerDependenciesMeta = Object.fromEntries(
    Object.keys(peers).map(name => [name, {optional: true}]),
  );
  manifest.files = ['out', 'LICENSE', 'MAINTAINED.md'];
  for (const name of [
    'bin',
    'scripts',
    'devDependencies',
    'optionalDependencies',
    'packageManager',
  ])
    delete manifest[name];
  return {files: files.size, dependencies: Object.keys(dependencies).length};
}
