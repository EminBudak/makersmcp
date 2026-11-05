import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = file => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const { version, mcpName } = read('package.json');

test('every manifest carries the version in package.json', () => {
  assert.equal(read('plugin.json').version, version);
  assert.equal(read('.claude-plugin/marketplace.json').plugins[0].version, version);
  assert.equal(read('.codex-plugin/plugin.json').version, version);
  const server = read('server.json');
  assert.equal(server.version, version);
  assert.equal(server.packages[0].version, version);
  assert.equal(server.name, mcpName);
});

test('the MCP configs and the README run the release in package.json', () => {
  for (const file of ['mcp.json', '.mcp.json']) {
    assert.deepEqual(read(file).mcpServers.makersmcp.args, ['-y', `makersmcp@${version}`], file);
  }
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const pinned = [...readme.matchAll(/makersmcp@([\w.-]*\w)/g)].map(match => match[1]);
  assert.ok(pinned.length > 0);
  assert.deepEqual([...new Set(pinned)], [version]);
  assert.doesNotMatch(readme, /npx -y makersmcp(?!@)/, 'every npx in the README pins the version');
});
