// Kairos — CI pipeline (Sukruti's Phase 2, Steps 2–4)
//
// Declarative Pipeline. Assumes a Multibranch Pipeline job (see
// docs/JENKINS_SETUP.md) so this file is picked up automatically for main
// and every PR branch — no separate freestyle job config needed.
//
// Node version is pinned via the NodeJS plugin tool name below rather than
// hardcoded in shell, so agents behave consistently. Update NODE_TOOL to
// match whatever name you give the installation in
// Manage Jenkins > Tools > NodeJS installations.
pipeline {
  agent any

  tools {
    nodejs 'node20' // NodeJS plugin installation name — see docs/JENKINS_SETUP.md
  }

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    // Headless Electron download can be slow/flaky on first run per agent;
    // give the extension test stage room without inflating the others.
    CI = 'true'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        sh 'node --version && npm --version'
      }
    }

    stage('Analyzer Tests') {
      steps {
        dir('analyzer') {
          sh 'npm run test:junit'
        }
      }
      post {
        always {
          junit testResults: 'analyzer/reports/analyzer-junit.xml', allowEmptyResults: true
        }
      }
    }

    stage('Extension Compile') {
      steps {
        dir('extension') {
          sh 'npm ci --no-audit --no-fund'
          sh 'npm run compile'
        }
      }
    }

    stage('Extension Tests') {
      steps {
        dir('extension') {
          // run-tests-headless.sh already handles xvfb-run vs. a plain run
          // (see extension/scripts/run-tests-headless.sh); test:junit only
          // adds KAIROS_JUNIT_OUT on top of that same path.
          sh 'npm run test:junit'
        }
      }
      post {
        always {
          junit testResults: 'extension/reports/extension-junit.xml', allowEmptyResults: true
        }
      }
    }

    stage('Package') {
      when {
        // Packaging needs a Marketplace PAT and isn't needed for every PR —
        // only run it for main, and only once the branch above is green.
        branch 'main'
      }
      steps {
        dir('extension') {
          // Credentials Binding plugin: the PAT is injected into VSCE_PAT
          // for this shell step only, never written to the workspace or
          // echoed to the console. Configure the 'vsce-marketplace-pat'
          // credential in Jenkins first — see docs/JENKINS_SETUP.md.
          // vsce isn't a project dependency (packaging is optional for a
          // class demo — see docs/CONTRACT.md's sibling checklist in the
          // roadmap PDF), so it's invoked via npx rather than added to
          // package.json.
          withCredentials([string(credentialsId: 'vsce-marketplace-pat', variable: 'VSCE_PAT')]) {
            sh 'npx --yes @vscode/vsce package'
          }
        }
      }
      post {
        always {
          archiveArtifacts artifacts: 'extension/*.vsix', allowEmptyArchive: true
        }
      }
    }
  }

  post {
    always {
      cleanWs()
    }
  }
}
