// Run with: node tests/package.test.cjs
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

test('release ZIP includes all runtime modules, license and docs from this checkout', () => {
    const root = path.resolve(__dirname, '..');
    const output = mkdtempSync(path.join(tmpdir(), 'awl-package-test-'));
    try {
        execFileSync('bash', [path.join(root, 'scripts/pack.sh'), output]);
        const result = JSON.parse(execFileSync('python3', ['-c', `
import json, pathlib, sys, zipfile
root, output = map(pathlib.Path, sys.argv[1:])
archives = list(output.glob('*.zip'))
assert len(archives) == 1
with zipfile.ZipFile(archives[0]) as archive:
    names = sorted(archive.namelist())
    print(json.dumps({
        'names': names,
        'metadata': json.loads(archive.read('metadata.json')),
        'identical': all(archive.read(name) == (root / name).read_bytes() for name in names)
    }))
`, root, output], {encoding: 'utf8'}));
        assert.deepEqual(result.names, ['LICENSE', 'README.md', 'extension.js',
            'history.js', 'layout.js', 'metadata.json']);
        assert.deepEqual(result.metadata['shell-version'], ['50']);
        assert.equal(result.identical, true);
    } finally {
        rmSync(output, {recursive: true, force: true});
    }
});
