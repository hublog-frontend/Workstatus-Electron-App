const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  shell,
  Tray,
  Menu,
} = require("electron/main");
require("dotenv").config();
const path = require("node:path");
const fs = require("node:fs");

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Hot Reload logic
try {
  require("electron-reloader")(module);
} catch (_) {}

const os = require("node:os");

function createWindow() {
  const win = new BrowserWindow({
    width: 400,
    height: 670,
    frame: false, // Frameless window to match the screenshot
    resizable: false,
    icon: path.join(__dirname, "images/hublog.ico"),
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
    }
  });

  ipcMain.on("close-window", () => {
    const url = win.webContents.getURL();
    if (url.includes("Login.html")) {
      isQuitting = true;
      app.quit();
    } else {
      win.hide(); // As per requirement: place in system tray instead of closing
    }
  });

  ipcMain.on("open-external", (event, url) => {
    shell.openExternal(url);
  });

  ipcMain.handle("take-screenshot", async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: screen.getPrimaryDisplay().workAreaSize,
      });

      if (sources.length === 0) return null;

      const source = sources[0]; // Capture primary screen
      const dataUrl = source.thumbnail.toDataURL();

      return dataUrl;
    } catch (error) {
      console.error("Failed to take screenshot:", error);
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
    return {
      apiBaseUrl: process.env.API_BASE_URL || "https://localhost:7263/api",
      version: process.env.VERSION || "1.0.0",
    };
  });

  ipcMain.on("show-window", () => {
    if (mainWindow) mainWindow.show();
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

const BROWSER_NAMES = ["chrome", "msedge", "firefox", "opera", "brave"];

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

function getBrowserUrl(processId) {
  if (process.platform !== "win32") return null;
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
    if (result) {
      try {
        let domain = result;
        if (domain.includes("://")) {
          domain = domain.split("://")[1];
        }
        domain = domain.split("/")[0].split("?")[0].split("#")[0];
        if (domain.includes(".") || domain === "localhost") {
          return domain.toLowerCase();
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

async function trackActivity() {
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
      const hostname = getBrowserUrl(processId);
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

  if (trackingInterval) clearInterval(trackingInterval);
  trackingInterval = setInterval(trackActivity, 1000);
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
  const iconPath = path.join(__dirname, "images/hublog.ico");
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Hublog",
      click: () => {
        if (mainWindow) mainWindow.show();
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
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
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
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
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
