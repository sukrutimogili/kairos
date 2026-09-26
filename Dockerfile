# Kairos — extension build/test image (Phase 2, Indu's step 4)
FROM node:20-bookworm

# VS Code headless test dependencies (@vscode/test-electron needs these + Xvfb)
RUN apt-get update && apt-get install -y \
    xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY analyzer/ ./analyzer/
COPY tests/ ./tests/

WORKDIR /workspace/extension
COPY extension/package*.json ./
RUN npm ci

COPY extension/ ./
RUN npm run compile

# Run tests headlessly: start Xvfb manually and wait for it before running tests,
# since xvfb-run's readiness check can hang inside some container setups.
CMD Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp & \
    sleep 2 && \
    export DISPLAY=:99 && \
    npm test
