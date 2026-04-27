const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  shell,
  Tray,
  Menu,
  nativeImage,
  systemPreferences,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const fs = require("node:fs");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Set App User Model ID for Windows to show the correct icon in the taskbar and search results
if (process.platform === "win32") {
  app.setAppUserModelId("com.hublog.app");
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Hot Reload logic
try {
  require("electron-reloader")(module);
} catch (_) { }

const os = require("node:os");

function updateDockIcon() {
  if (process.platform === "darwin") {
    const iconPath = path.join(__dirname, "images/hublog_2.png");
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      app.dock.setIcon(image);
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 400,
    height: 670,
    frame: false, // Frameless window to match the screenshot
    resizable: false,
    icon:
      process.platform === "win32"
        ? path.join(__dirname, "images/hublog_2.ico")
        : nativeImage.createFromPath(path.join(__dirname, "images/hublog_2.png")),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
    show: false, // Initially hide to prevent flash
  });

  mainWindow = win;
  win.loadFile("Login/Login.html");

  // Prevent app from closing when X is pressed (hide instead)
  win.on("close", (event) => {
    const url = win.webContents.getURL();
    if (!isQuitting && url.includes("Dashboard.html")) {
      event.preventDefault();
      win.hide();
      if (process.platform === "darwin") app.dock.hide();
    }
  });

  ipcMain.on("close-window", () => {
    const url = win.webContents.getURL();
    if (url.includes("Login.html")) {
      isQuitting = true;
      app.quit();
    } else {
      win.hide(); // As per requirement: place in system tray instead of closing
      if (process.platform === "darwin") app.dock.hide();
    }
  });

  ipcMain.on("open-external", (event, url) => {
    shell.openExternal(url);
  });

  ipcMain.handle("take-screenshot", async () => {
    try {
      // Add a small delay to ensure OS permissions are checked
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log("Attempting to capture screen sources...");
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1280, height: 720 },
      });

      console.log(`Found ${sources.length} sources.`);
      if (sources.length === 0) {
        console.warn("No screen sources found. Check Screen Recording permissions in System Settings.");
        return null;
      }

      const source = sources[0];
      return source.thumbnail.toDataURL();
    } catch (error) {
      console.error("Screenshot capture failed:", error.message);
      return null;
    }
  });

  ipcMain.handle("get-system-idle-time", () => {
    const { powerMonitor } = require("electron");
    return powerMonitor.getSystemIdleTime();
  });

  ipcMain.handle("get-system-info", () => {
    const interfaces = os.networkInterfaces();
    let ipAddress = "127.0.0.1";
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          ipAddress = iface.address;
          break;
        }
      }
    }

    return {
      deviceId: os.hostname(),
      deviceName: os.hostname(),
      platform: process.platform,
      osName: os.type(),
      osBuild: os.release(),
      systemType: os.arch(),
      ipAddress: ipAddress,
      appType: "Electron",
      hublogVersion: process.env.VERSION || "1.0.0",
      status: 0,
    };
  });

  ipcMain.handle("get-config", () => {
    const baseUrl = process.env.API_BASE_URL || "https://workstatus.qubinex.com:8086/api";
    console.log("Config requested. Base URL:", baseUrl);
    return {
      apiBaseUrl: baseUrl,
      version: app.getVersion(),
    };
  });

  ipcMain.on("show-window", () => {
    if (mainWindow) {
      mainWindow.show();
      if (process.platform === "darwin") {
        updateDockIcon();
        app.dock.show();
        updateDockIcon();
      }
    }
  });
}

let trackingInterval = null;
let currentActivity = {
  userId: null,
  organizationId: null,
  type: null,
  name: null,
  startTime: null,
};

const BROWSER_NAMES = ["chrome", "msedge", "firefox", "opera", "brave", "safari"];

function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, "0")).join(":");
}

function notifyRendererToLog(activity) {
  if (!mainWindow || !activity.name || !activity.startTime) return;

  const durationSec = Math.floor((Date.now() - activity.startTime) / 1000);
  if (durationSec < 1) return;

  const payload = {
    UserId: activity.userId,
    OrganizationId: activity.organizationId,
    TotalUsage: formatDuration(durationSec),
    UsageDate: new Date().toISOString().split("T")[0],
    Details: `Auto-tracked via Workstatus Desktop`,
    Type: activity.type,
    Name: activity.name,
  };

  mainWindow.webContents.send("log-activity", payload);
}

let getWindowsModule = null;
async function getActiveWin() {
  if (!getWindowsModule) {
    getWindowsModule = await import("get-windows");
  }
  return getWindowsModule.activeWindow;
}

const { execSync } = require("child_process");

function extractDomain(url) {
  if (!url) return null;
  try {
    let domain = url;
    if (domain.includes("://")) {
      domain = domain.split("://")[1];
    }
    domain = domain.split("/")[0].split("?")[0].split("#")[0];
    if (domain.includes(".") || domain === "localhost") {
      return domain.toLowerCase();
    }
  } catch (e) { }
  return null;
}

function getBrowserUrl(processId, ownerName) {
  if (process.platform === "win32") {
    try {
      const psScript = `
        [void][Reflection.Assembly]::LoadWithPartialName('UIAutomationClient');
        [void][Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes');
        $root = [System.Windows.Automation.AutomationElement]::RootElement;
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${processId});
        $browser = $root.FindFirst('Children', $cond);
        if ($browser) {
            $valCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty, $true);
            $elements = $browser.FindAll('Descendants', $valCond);
            foreach ($e in $elements) {
                $v = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value;
                if ($v -match '^[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\\b') {
                    $v; break;
                }
            }
        }
      `;
      const result = execSync(
        `powershell -command "${psScript.replace(/\n/g, " ")}"`,
        { encoding: "utf8" },
      ).trim();
      return extractDomain(result);
    } catch (e) { }
  } else if (process.platform === "darwin") {
    const name = ownerName ? ownerName.toLowerCase() : "";
    let script = "";

    if (name.includes("google chrome")) {
      script = 'tell application "Google Chrome" to get URL of active tab of first window';
    } else if (name.includes("safari")) {
      script = 'tell application "Safari" to get URL of current tab of front window';
    } else if (name.includes("brave")) {
      script = 'tell application "Brave Browser" to get URL of active tab of first window';
    } else if (name.includes("microsoft edge") || name.includes("msedge")) {
      script = 'tell application "Microsoft Edge" to get URL of active tab of first window';
    } else if (name.includes("opera")) {
      script = 'tell application "Opera" to get URL of active tab of first window';
    }

    if (script) {
      try {
        const result = execSync(`osascript -e '${script}'`, {
          encoding: "utf8",
          timeout: 2000, // Add a timeout to prevent hanging
        }).trim();
        return extractDomain(result);
      } catch (e) {
        if (e.message.includes("Not authorized to send Apple events")) {
          console.warn("Automation permission missing for browser:", ownerName);
        } else {
          console.error("URL Tracking Error:", e.message);
        }
      }
    }
  }
  return null;
}

async function trackActivity() {
  if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) {
    console.warn("Accessibility permissions not granted. Tracking suspended.");
    return;
  }

  try {
    const awFunc = await getActiveWin();
    const window = await awFunc();

    if (!window) {
      console.log("No active window detected.");
      return;
    }

    const ownerName = window.owner.name.toLowerCase();
    const title = window.title;
    const processId = window.owner.processId;

    let activityType = "app";
    let activityName = window.owner.name;

    const isBrowser = BROWSER_NAMES.some((b) => ownerName.includes(b));

    if (isBrowser) {
      activityType = "url";

      // Try to get actual hostname from browser address bar
      const hostname = getBrowserUrl(processId, window.owner.name);
      let potentialUrl = hostname || title;

      if (potentialUrl.toLowerCase().includes("localhost")) {
        potentialUrl = "localhost";
      }

      const isSystemTab = ["new tab", "settings", "extensions", "history"].some(
        (sys) => potentialUrl.toLowerCase().includes(sys),
      );

      if (isSystemTab) {
        console.log(`Skipping browser system tab: ${title}`);
        return;
      }

      activityName = potentialUrl;
    } else {
      if (!/[a-zA-Z].*[a-zA-Z]/.test(activityName)) {
        console.log(
          `Skipping application (validation failed): ${activityName}`,
        );
        return;
      }
    }

    if (activityName !== currentActivity.name) {
      console.log(
        `Activity switch: from "${currentActivity.name || "None"}" to "${activityName}"`,
      );
      if (currentActivity.name) {
        notifyRendererToLog({ ...currentActivity });
      }

      currentActivity.name = activityName;
      currentActivity.type = activityType;
      currentActivity.startTime = Date.now();
    }
  } catch (e) {
    console.error("Tracking Error:", e.message);
  }
}

ipcMain.on("start-tracking", (event, userId, organizationId) => {
  console.log("Tracking started for User:", userId, "Org:", organizationId);
  currentActivity.userId = userId;
  currentActivity.organizationId = organizationId;
  currentActivity.name = null;
  currentActivity.startTime = null;

  if (process.platform === "darwin") {
    const hasAccess = systemPreferences.isTrustedAccessibilityClient(false);
    if (!hasAccess) {
      console.log("Requesting Accessibility Access...");
      // This will trigger the system prompt if not already shown.
      systemPreferences.isTrustedAccessibilityClient(true);
    }
  }

  if (trackingInterval) clearInterval(trackingInterval);
  trackingInterval = setInterval(trackActivity, 2000); // Increased interval slightly
});

ipcMain.on("stop-tracking", () => {
  console.log("Tracking stopped");
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
    if (currentActivity.name) {
      notifyRendererToLog({ ...currentActivity });
    }
    currentActivity.name = null;
    currentActivity.startTime = null;
  }
});
// --- End Activity Tracking ---

function createTray() {
  const iconPath =
    process.platform === "win32"
      ? path.join(__dirname, "images/hublog_2.ico")
      : path.join(__dirname, "images/hublog_2.png");

  let icon = nativeImage.createFromPath(iconPath);

  if (process.platform === "darwin") {
    icon = icon.resize({ width: 18, height: 18 });
  }

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Hublog",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          if (process.platform === "darwin") {
            updateDockIcon();
            app.dock.show();
            updateDockIcon();
          }
        }
      },
    },
    { type: "separator" },
    {
      label: "Exit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Hublog Workstatus");
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
        if (process.platform === "darwin") app.dock.hide();
      } else {
        mainWindow.show();
        if (process.platform === "darwin") {
          updateDockIcon();
          app.dock.show();
          updateDockIcon();
        }
      }
    }
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) {
        mainWindow.show();
        if (process.platform === "darwin") {
          updateDockIcon();
          app.dock.show();
          updateDockIcon();
        }
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    updateDockIcon();
    createWindow();
    createTray();

    // Enable auto-launch on Windows/Mac
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath("exe"),
    });

    // Auto-update logging
    autoUpdater.on("checking-for-update", () =>
      console.log("Checking for update..."),
    );
    autoUpdater.on("update-available", (info) =>
      console.log("Update available:", info),
    );
    autoUpdater.on("update-not-available", (info) =>
      console.log("Update not available:", info),
    );
    autoUpdater.on("error", (err) =>
      console.log("Error in auto-updater:", err),
    );
    autoUpdater.on("download-progress", (progress) =>
      console.log(`Download progress: ${progress.percent}%`),
    );
    autoUpdater.on("update-downloaded", (info) => {
      console.log("Update downloaded:", info);
      autoUpdater.quitAndInstall(); // Automatically restart to apply update
    });

    autoUpdater.checkForUpdatesAndNotify();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
      if (process.platform === "darwin") {
        updateDockIcon();
        app.dock.show();
      }
    });
  });
}

app.on("window-all-closed", () => {
  // Overridden to keep app running in tray
});

app.on("before-quit", () => {
  isQuitting = true;
});
