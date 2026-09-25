# Kairos — extension build/test image (Phase 2, Indu's step 4)
FROM node:20-bullseye

# VS Code headless test dependencies (@vscode/test-electron needs these + Xvfb)
RUN apt-get update && apt-get install -y \
    xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/extension
COPY extension/package*.json ./
RUN npm ci

COPY extension/ ./
RUN npm run compile

# Run tests headlessly under Xvfb
CMD ["xvfb-run", "-a", "npm", "test"]
