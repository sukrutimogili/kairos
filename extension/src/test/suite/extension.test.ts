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

  test('getImpactData returns real analyzer data matching contract shape', async () => {
    // Stage 3: getImpactData no longer reads mock JSON, so this must point
    // at a real repo the analyzer can walk — the Stage 1 sample fixture.
    const path = require('path');
    const sampleRepo = path.resolve(__dirname, '../../../../tests/fixtures/sample-project');
    const result = await getImpactData(sampleRepo, 'src/main/java/com/example/service/UserService.java');
    assert.ok(!isImpactError(result));
    if (!isImpactError(result)) {
      assert.strictEqual(result.schemaVersion, '1.0');
      assert.ok(result.graph.nodes.length > 0);
    }
  });
});
