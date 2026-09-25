import * as assert from 'assert';
import { renderImpact, renderError, renderGraph } from '../../panel/ImpactPanel';
import { ImpactResponse, ImpactErrorResponse } from '../../types';

const sample: ImpactResponse = {
  schemaVersion: '1.0',
  requestedFile: 'src/main/java/com/example/service/UserService.java',
  graph: {
    nodes: [
      { id: 'src/main/java/com/example/controller/UserController.java', className: 'UserController', package: 'com.example.controller' },
      { id: 'src/main/java/com/example/service/UserService.java', className: 'UserService', package: 'com.example.service' },
      { id: 'src/main/java/com/example/repository/UserRepository.java', className: 'UserRepository', package: 'com.example.repository' },
    ],
    edges: [
      { from: 'src/main/java/com/example/controller/UserController.java', to: 'src/main/java/com/example/service/UserService.java', kind: 'import' },
      { from: 'src/main/java/com/example/service/UserService.java', to: 'src/main/java/com/example/repository/UserRepository.java', kind: 'import' },
    ],
  },
  impact: {
    dependsOn: ['src/main/java/com/example/repository/UserRepository.java'],
    dependents: ['src/main/java/com/example/controller/UserController.java'],
    affected: [
      { id: 'src/main/java/com/example/controller/UserController.java', relation: 'dependent', distance: 1 },
      { id: 'src/main/java/com/example/repository/UserRepository.java', relation: 'dependency', distance: 1 },
    ],
  },
  meta: { language: 'java', fileCount: 3 },
};

suite('Graph renderer (Phase 2)', () => {
  test('renders every node and edge from the graph', () => {
    const html = renderGraph(sample);
    for (const node of sample.graph.nodes) {
      assert.ok(html.includes(node.className), `expected ${node.className} in graph HTML`);
    }
    assert.ok(html.includes('graph-edge-import'), 'expected import-kind edge styling');
  });

  test('nodes are clickable and post an openFile message', () => {
    const html = renderImpact(sample);
    assert.ok(html.includes('onclick="openNode('), 'expected clickable nodes');
    assert.ok(html.includes('acquireVsCodeApi'), 'expected the click script to be present');
  });

  test('shows a clear hint on UNSUPPORTED_LANGUAGE', () => {
    const err: ImpactErrorResponse = {
      schemaVersion: '1.0',
      error: { code: 'UNSUPPORTED_LANGUAGE', message: 'requestedFile is not a supported language' },
    };
    const html = renderError(err);
    assert.ok(html.includes('UNSUPPORTED_LANGUAGE'));
    assert.ok(html.includes("doesn"), 'expected the friendly hint text');
  });
});
