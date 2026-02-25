const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const API_HOST = "127.0.0.1";
const API_PORT = 8080;
const API_URL = `http://${API_HOST}:${API_PORT}`;
const UI_URL = `${API_URL}/ui`;

let backendProcess = null;

function ensureDirExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function waitForHealth({ retries = 80, delayMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const tryOnce = () => {
      attempts += 1;
      const req = http.get(`${API_URL}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        if (attempts >= retries) {
          reject(new Error(`Health check failed with status ${res.statusCode}`));
          return;
        }
        setTimeout(tryOnce, delayMs);
      });

      req.on("error", () => {
        if (attempts >= retries) {
          reject(new Error("Health check failed"));
          return;
        }
        setTimeout(tryOnce, delayMs);
      });
    };

    tryOnce();
  });
}

function startBackend() {
  const repoRoot = path.resolve(__dirname, "..");
  const userDataDir = app.getPath("userData");
  ensureDirExists(userDataDir);

  const dbPath = path.join(userDataDir, "elastisched.db");
  const env = {
    ...process.env,
    PYTHONPATH: path.join(repoRoot, "backend"),
    DATABASE_URL: `sqlite+aiosqlite:///${dbPath}`,
  };

  const python = process.env.ELASTISCHED_PYTHON || "python3";
  backendProcess = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "backend.main:app",
      "--host",
      API_HOST,
      "--port",
      String(API_PORT),
    ],
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    }
  );

  backendProcess.on("exit", (code) => {
    if (code !== 0) {
      console.error(`Backend exited with code ${code}`);
    }
  });
}

function stopBackend() {
  if (!backendProcess) return;
  backendProcess.kill();
  backendProcess = null;
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  try {
    await waitForHealth();
    await window.loadURL(UI_URL);
  } catch (error) {
    await window.loadURL(
      `data:text/plain,Failed%20to%20start%20backend.%0A${encodeURIComponent(
        error.message || String(error)
      )}`
    );
  }
}

app.whenReady().then(() => {
  startBackend();
  return createWindow();
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopBackend();
});
