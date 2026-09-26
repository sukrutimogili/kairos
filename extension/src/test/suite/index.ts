import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export function run(): Promise<void> {
  // JUnit-XML output for Jenkins, mirroring analyzer/'s own test:junit
  // convention (analyzer/reports/analyzer-junit.xml). Only kicks in when
  // KAIROS_JUNIT_OUT is set, so a plain `npm test` locally still gets the
  // normal readable console reporter.
  const junitOut = process.env.KAIROS_JUNIT_OUT;
  const mocha = new Mocha(
    junitOut
      ? {
          ui: 'tdd',
          color: true,
          reporter: 'mocha-junit-reporter',
          reporterOptions: { mochaFile: junitOut },
        }
      : { ui: 'tdd', color: true }
  );
  const testsRoot = path.resolve(__dirname, '..');

  return new Promise((resolve, reject) => {
    glob('**/**.test.js', { cwd: testsRoot }).then((files: string[]) => {
      files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));
      try {
        mocha.run((failures: number) => {
          if (failures > 0) {
            reject(new Error(`${failures} tests failed.`));
          } else {
            resolve();
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}
