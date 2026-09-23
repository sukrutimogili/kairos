import * as assert from 'assert';
import * as vscode from 'vscode';
import { getImpactData } from '../../data/getImpactData';
import { isImpactError } from '../../types';

async function activateExtension() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'kairos');
  if (ext && !ext.isActive) {
    await ext.activate();
  }
}

suite('Kairos Extension', () => {
  test('commands are registered', async () => {
    await activateExtension();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('kairos.analyzeCodebase'));
    assert.ok(commands.includes('kairos.showImpact'));
  });

  test('getImpactData returns mock data matching contract shape', async () => {
    const result = await getImpactData('/fake/repo', 'src/main/java/com/example/service/UserService.java');
    assert.ok(!isImpactError(result));
    if (!isImpactError(result)) {
      assert.strictEqual(result.schemaVersion, '1.0');
      assert.ok(result.graph.nodes.length > 0);
    }
  });
});
