// Initialize Icons
lucide.createIcons();

// Close App Logic
document.getElementById("closeBtn").addEventListener("click", () => {
  if (window.electronAPI) {
    window.electronAPI.closeWindow();
  } else {
    console.log("Close action triggered");
  }
});

// Load User Data from Session and Initialize Dashboard
window.addEventListener("DOMContentLoaded", async () => {
  const userStr = localStorage.getItem("user");
  if (!userStr) {
    window.location.href = "../Login/Login.html";
    return;
  }

  const user = JSON.parse(userStr);

  // 0. Load Configuration from .env via Main Process
  if (window.electronAPI && window.electronAPI.getConfig) {
    try {
      const config = await window.electronAPI.getConfig();
      if (config.apiBaseUrl) {
        SystemService.setBaseUrl(config.apiBaseUrl);
        if (typeof ScreenshotService !== "undefined") {
          ScreenshotService.setBaseUrl(config.apiBaseUrl);
        }
      }

      // Fetch version number from API
      try {
        const versionRes = await SystemService.getVersion();
        if (versionRes.data && Array.isArray(versionRes.data) && versionRes.data.length > 0) {
          const versionNumber = versionRes.data[0].versionNumber;
          const versionEl = document.getElementById("appVersionText");
          if (versionEl) versionEl.textContent = `Version ${versionNumber}`;
        }
      } catch (verErr) {
        console.warn("Failed to fetch version from API:", verErr);
      }
    } catch (err) {
      console.error("Failed to load environment config:", err);
    }
  }

  // 1. Reset UI/Storage for initialization
  initUIState(user);
  updateLastSyncTimeText();

  // 2. Initial Sync
  await syncDashboardData(user);

  // 3. Hide Loader
  const loader = document.getElementById("loadingOverlay");
  if (loader) {
    loader.classList.add("hidden");
  }

  // 4. Listen for desktop activity logs from main process
  if (window.electronAPI && window.electronAPI.onLogActivity) {
    window.electronAPI.onLogActivity(async (payload) => {
      try {
        const { Type, Name, ...apiPayload } = payload;
        if (Type === "app") {
          apiPayload.ApplicationName = Name;
          await UserService.insertApplicationActivity(apiPayload);
        } else {
          apiPayload.Url = Name;
          await UserService.insertUrlActivity(apiPayload);
        }
        console.log(`Successfully logged ${Type} activity: ${Name}`);
      } catch (err) {
        console.error(`Failed to log activity via renderer:`, err);
      }
    });
  }
});

// Global Internet Monitoring
window.addEventListener("offline", () => {
  const modal = document.getElementById("networkErrorModal");
  if (modal) {
    modal.classList.add("active");
    lucide.createIcons();
  }
});

window.addEventListener("online", () => {
  // Reload the page when internet comes back
  window.location.reload();
});

async function syncDashboardData(user) {
  if (!navigator.onLine) {
    const modal = document.getElementById("networkErrorModal");
    if (modal) modal.classList.add("active");
    return;
  }

  const orgId = user.organizationId;
  const userId = user.id;

  try {
    const today = new Date();
    const todayStr = formatDate(today);
    const sixDaysAgo = new Date();
    sixDaysAgo.setDate(today.getDate() - 6);
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    // Concurrent sync attempts for individual modules
    await Promise.allSettled([
      // 3. Handle Previous Day Attendance
      UserService.getPunchInOutDetails(
        orgId,
        userId,
        formatDate(sixDaysAgo),
        formatDate(yesterday),
      )
        .then((resp) => handleAutoPunchOut(resp.data, userId))
        .catch((e) => console.error("Prev Attendance Error:", e)),

      // 4. Handle Current Day Attendance
      UserService.getPunchInOutDetails(orgId, userId, todayStr, todayStr)
        .then((resp) => restoreAttendanceState(resp.data))
        .catch((e) => {
          console.error("Today Attendance Error:", e);
          restoreAttendanceState([]);
        }),

      // 5. Handle Break Records
      UserService.getBreakRecords(
        orgId,
        userId,
        formatDate(sixDaysAgo),
        todayStr,
      )
        .then((resp) => restoreBreakState(resp.data, orgId))
        .catch((e) => {
          console.error("Break Records Error:", e);
          restoreBreakState([], orgId);
        }),

      // 6. Handle Alert Rules
      AlertService.getAlertRules(orgId)
        .then((resp) => {
          if (resp.data && resp.data.length > 0) {
            const rule = resp.data[0];
            localStorage.setItem("alertRules", JSON.stringify(rule));

            // Update global inactivity rules using provided API casing
            inactivityRules = {
              alertThresholdMs:
                (rule.alertThreshold || rule.AlertThreshold || 10) * 60 * 1000,
              punchoutThresholdMs:
                (rule.punchoutThreshold || rule.PunchoutThreshold || 30) *
                60 *
                1000,
              enableAlerts: rule.break_alert_status !== false,
              enableTracking: rule.status === true || rule.Status === true,
            };

            console.log("Inactivity Rules Applied:", inactivityRules);
          }
        })
        .catch((e) => console.error("Alert Rules Error:", e)),

      // 7. Check App Version
      SystemService.getVersion()
        .then((resp) => checkAppVersion(resp.data))
        .catch((e) => console.error("Version Check Error:", e)),
    ]);

    // 8. Finalize sync using absolute timestamp to avoid timezone issues
    localStorage.setItem("lastSync", Date.now().toString());
    updateLastSyncTimeText();
    console.log("Dashboard sync complete.");
  } catch (err) {
    console.error("Critical Sync Failure:", err);
  } finally {
    lucide.createIcons();
  }
}

function updateLastSyncTimeText() {
  const lastSyncStr = localStorage.getItem("lastSync");
  const el = document.getElementById("lastSyncText");
  if (!el) return;

  if (!lastSyncStr) {
    el.textContent = "Last sync: Never";
    return;
  }

  const lastSync = parseInt(lastSyncStr);
  if (isNaN(lastSync)) {
    el.textContent = "Last sync: Pending...";
    return;
  }

  const diff = Math.floor((Date.now() - lastSync) / 1000);

  // If clock somehow goes back, or just synced
  if (diff < 60) {
    el.textContent = "Last sync: Just now";
  } else if (diff < 3600) {
    const min = Math.floor(diff / 60);
    el.textContent = `Last sync: ${min} ${min === 1 ? "min" : "mins"} ago`;
  } else {
    const hr = Math.floor(diff / 3600);
    el.textContent = `Last sync: ${hr} ${hr === 1 ? "hr" : "hrs"} ago`;
  }
}

// Auto-update the "X mins ago" every minute
setInterval(updateLastSyncTimeText, 60000);

function formatDate(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";

  // Return YYYY-MM-DD in local time
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().split("T")[0];
}

function getISTTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";

  // Returns "YYYY-MM-DDTHH:mm:ss" in local time (assuming machine is IST)
  // Even if not, it produces the local view which the user wants as "IST"
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().split(".")[0];
}

function initUIState(user) {
  const userNameEl = document.querySelector(".user-name");
  const userEmailEl = document.querySelector(".user-email");
  const avatarEl = document.querySelector(".avatar");

  if (userNameEl)
    userNameEl.textContent = `${user.first_Name} ${user.last_Name}`;
  if (userEmailEl) userEmailEl.textContent = user.email;
  if (avatarEl) {
    const initials = `${user.first_Name[0]}${user.last_Name[0]}`.toUpperCase();
    avatarEl.textContent = initials;
  }

  // Reset session flags
  localStorage.removeItem("activeBreakId");
}

async function handleAutoPunchOut(attendanceRecords, userId) {
  if (
    !attendanceRecords ||
    !Array.isArray(attendanceRecords) ||
    attendanceRecords.length === 0
  )
    return;

  // Find record with missing End_Time (check both casing)
  const incomplete = attendanceRecords.find((r) => {
    const endTime = r.End_Time || r.end_Time;
    return !endTime || endTime === "0001-01-01T00:00:00";
  });

  console.log("Incomplete record found:", incomplete);

  if (incomplete) {
    const rawStartTime = incomplete.Start_Time || incomplete.start_Time;
    if (!rawStartTime) {
      console.warn("Incomplete record has no Start_Time:", incomplete);
      return;
    }

    const startInput = formatDate(new Date(rawStartTime));
    if (!startInput) {
      console.warn("Invalid Start_Time in incomplete record:", rawStartTime);
      return;
    }

    try {
      const activeTime = await UserService.getActiveTime(userId, startInput);
      if (activeTime && activeTime.data && activeTime.data.TriggeredTime) {
        // Auto Punch Out
        const punchOutModel = {
          ...incomplete,
          End_Time: activeTime.data.TriggeredTime,
          PunchOutType: "Auto",
          Status: 1, // Ensure status is set to completed
        };
        await UserService.insertAttendance(punchOutModel);
        console.log("Auto punch-out performed for date:", startInput);
      } else {
        console.log("No active time found for auto punch-out on:", startInput);
      }
    } catch (err) {
      console.error("Auto punch-out failed:", err);
    }
  }
}

function timeToSeconds(hms) {
  if (!hms) return 0;
  const a = hms.split(":");
  if (a.length !== 3) return 0;
  return +a[0] * 60 * 60 + +a[1] * 60 + +a[2];
}

function restoreAttendanceState(records) {
  if (!records || records.length === 0) {
    updatePunchUI(false);
    return;
  }

  // Calculate total accumulated time for all completed sessions today
  let accumulatedSeconds = 0;
  records.forEach((r) => {
    const endTime = r.end_Time || r.End_Time;
    if (endTime && endTime !== "0001-01-01T00:00:00") {
      accumulatedSeconds += timeToSeconds(r.total_Time || r.Total_Time);
    }
  });

  const lastRecord = records[records.length - 1];
  const endTime = lastRecord.end_Time || lastRecord.End_Time;
  const isCurrentlyIn = !endTime || endTime === "0001-01-01T00:00:00";

  if (isCurrentlyIn) {
    isPunchedIn = true;
    currentAttendance = lastRecord;
    updatePunchUI(true);
    // Start elapsed timer based on Start_Time and add previously accumulated seconds
    startElapsedTimeTracker(
      lastRecord.start_Time || lastRecord.Start_Time,
      accumulatedSeconds,
    );

    const user = JSON.parse(localStorage.getItem("user"));
    startTracking(user);
  } else {
    isPunchedIn = false;
    currentAttendance = null;
    updatePunchUI(false);

    const clockEl = document.getElementById("clock");
    if (clockEl) {
      const h = Math.floor(accumulatedSeconds / 3600);
      const m = Math.floor((accumulatedSeconds % 3600) / 60);
      const s = accumulatedSeconds % 60;
      clockEl.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }

  // Store accumulated seconds for next punch-in in same session (Keyed by User ID)
  const user = JSON.parse(localStorage.getItem("user"));
  if (user) {
    localStorage.setItem(`todayAccumulatedSeconds_${user.id}`, accumulatedSeconds);
  }
}

function restoreBreakState(records, orgId) {
  loadBreaks(orgId);
  const activeFromStorage = localStorage.getItem("activeBreak");
  if (activeFromStorage) {
    try {
      currentBreak = JSON.parse(activeFromStorage);
      isOnBreak = true;
      updateBreakUI(true, "Session");
      startBreakTimer(currentBreak.Start_Time, currentBreak.maxTime || 30);
    } catch (e) {
      console.error(e);
    }
  }
}

function checkAppVersion(data) {
  const currentVersion = "1.0.0"; // Should come from package.json or similar
  if (data && data.VersionNumber !== currentVersion) {
    console.warn(
      "App version outdated. Current:",
      currentVersion,
      "Latest:",
      data.VersionNumber,
    );
  }
}

function showNetworkError() {
  alert("No internet connection detected. Please check your network.");
}

// Global Elapsed Timer State
let elapsedInterval = null;
function startElapsedTimeTracker(startTime, initialSeconds = 0) {
  let start = new Date(startTime).getTime();

  // Robust check for invalid date parsing
  if (isNaN(start) || start <= 0) {
    console.warn("Invalid start time provided to tracker:", startTime);
    const clockEl = document.getElementById("clock");
    if (clockEl) {
      const h = Math.floor(initialSeconds / 3600);
      const m = Math.floor((initialSeconds % 3600) / 60);
      const s = initialSeconds % 60;
      clockEl.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return;
  }

  if (elapsedInterval) clearInterval(elapsedInterval);

  elapsedInterval = setInterval(() => {
    const now = new Date().getTime();
    const diff = now - start + initialSeconds * 1000;

    // Ensure diff is positive
    const safeDiff = Math.max(0, diff);

    const h = Math.floor(safeDiff / 3600000);
    const m = Math.floor((safeDiff % 3600000) / 60000);
    const s = Math.floor((safeDiff % 60000) / 1000);

    const clockEl = document.getElementById("clock");
    if (clockEl) {
      clockEl.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }, 1000);
}

function stopElapsedTimeTracker() {
  if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
}

function updatePunchUI(active) {
  const punchStatus = document.querySelector(".punch-status");
  const punchBtn = document.getElementById("punchBtn");
  const bBtn = document.querySelector(".break-btn");

  if (active) {
    punchStatus.textContent = "Out";
    punchBtn.style.background = "linear-gradient(135deg, #ef4444, #dc2626)";
    // Show break button only if we are not already on break
    if (bBtn && !isOnBreak) bBtn.style.display = "flex";
  } else {
    punchStatus.textContent = "In";
    punchBtn.style.background =
      "linear-gradient(135deg, var(--primary), var(--primary-dark))";
    // Hide break button when punched out
    if (bBtn) bBtn.style.display = "none";
  }
}

async function loadBreaks(orgId) {
  try {
    const response = await UserService.getBreaks(orgId);
    // Ensure we handle both single object and array responses
    const breaks = Array.isArray(response.data)
      ? response.data
      : [response.data];

    breakMasterList = breaks;

    const optionsContainer = document.querySelector(".break-options");
    if (!optionsContainer) return;

    optionsContainer.innerHTML = ""; // Clear placeholders

    breaks.forEach((breakItem, index) => {
      const label = document.createElement("label");
      label.className = "break-option";
      label.innerHTML = `
                <input type="radio" name="breakType" value="${breakItem.name}" ${index === 0 ? "checked" : ""} />
                <div class="option-content">
                    <i data-lucide="${getIconForBreak(breakItem.name)}"></i>
                    <div class="option-text">
                        <span class="option-title">${breakItem.name}</span>
                        <span class="option-desc">Limit: ${breakItem.max_Break_Time} minutes</span>
                    </div>
                </div>
            `;
      optionsContainer.appendChild(label);
    });

    lucide.createIcons();
  } catch (error) {
    console.error("Failed to load breaks:", error);
  }
}

function getIconForBreak(name) {
  const lower = name.toLowerCase();
  if (lower.includes("lunch")) return "utensils";
  if (lower.includes("meeting")) return "users";
  if (lower.includes("break")) return "coffee";
  return "coffee"; // Default
}

// Digital Clock & Date Update Logic
function updateClock() {
  const now = new Date();

  // We no longer update #clock here because it's used for the tracking timer
  // Date Format: Luxurious
  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  const dateFormatted = now.toLocaleDateString("en-US", options);

  const dateEl = document.getElementById("date");
  if (dateEl) dateEl.textContent = dateFormatted;
}

// Global Tracking State
let isPunchedIn = false;
let currentAttendance = null;
let activityInterval = null;
let screenshotInterval = null;
let isPunching = false; // New flag for processing state

// Inactivity Tracking State
let lastActivityTime = Date.now();
let inactivityChecker = null;
let isIdleReported = false;
let lastIdleApiCallTime = 0; // Track last recurring idle report
const IDLE_API_TRIGGER_THRESHOLD = 120000; // 2 minutes

let isBreakAlertSent = false;
let isInactivityAlertSent = false;

let inactivityRules = {
  alertThresholdMs: 10 * 60 * 1000,
  punchoutThresholdMs: 30 * 60 * 1000,
  enableAlerts: true,
  enableTracking: true,
};

async function handleAlertTrigger(value) {
  const user = JSON.parse(localStorage.getItem("user"));
  if (!user) return;

  const alertTriggerDetails = [
    {
      UserId: user.id,
      Triggered: value,
      TriggeredTime: getISTTime(),
    },
  ];

  try {
    await AlertService.insertAlert(alertTriggerDetails);
    console.log(`Alert triggered successfully: ${value}`);
  } catch (err) {
    console.error(`Error triggering alert: ${value}`, err);
  }
}

function startTracking(user) {
  // Reset inactivity on start
  resetInactivity();
  startInactivityChecker(user);

  // 1. Active Time Tracking (every 1 minute)
  activityInterval = setInterval(async () => {
    try {
      await UserService.insertActiveTime({
        UserId: user.id,
        TriggeredTime: getISTTime(),
      });
      console.log("Activity time synced.");
    } catch (e) {
      console.error("Activity sync failed", e);
    }
  }, 60000);

  // 2. Screenshot Tracking (every 5 minutes)
  captureAndUploadScreenshot(); // Immediate on start
  screenshotInterval = setInterval(captureAndUploadScreenshot, 300000);

  // 3. Desktop Activity Tracking
  if (window.electronAPI && window.electronAPI.startTracking) {
    window.electronAPI.startTracking(user.id, user.organizationId);
  }
}

function stopTracking() {
  if (activityInterval) clearInterval(activityInterval);
  if (screenshotInterval) clearInterval(screenshotInterval);
  activityInterval = null;
  screenshotInterval = null;

  stopInactivityChecker();

  // 3. Desktop Activity Tracking
  if (window.electronAPI && window.electronAPI.stopTracking) {
    window.electronAPI.stopTracking();
  }
}

function dataURLtoBlob(dataurl) {
  const arr = dataurl.split(",");
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

async function captureAndUploadScreenshot() {
  const user = JSON.parse(localStorage.getItem("user"));
  if (!user || !window.electronAPI || !window.electronAPI.takeScreenshot) {
    console.warn("Screenshot capture skipped: missing user or electronAPI");
    return;
  }

  try {
    console.log("Capture process started...");
    const screenshotData = await window.electronAPI.takeScreenshot();
    if (!screenshotData) {
      console.warn("Screenshot capture failed to return data");
      return;
    }
    console.log("Image data received, converting to blob...");

    const blob = dataURLtoBlob(screenshotData);
    const formData = new FormData();
    formData.append("file", blob, `screenshot_${Date.now()}.png`);

    const dateStr = getISTTime().replace("T", " ");
    console.log(`Uploading to API: ${dateStr}`);
    await ScreenshotService.uploadScreenshot(
      user.id,
      user.organizationId,
      dateStr,
      formData,
    );
    console.log("Upload successful.");
  } catch (e) {
    console.error("Screenshot tracking failed", e);
  }
}

const punchOutModal = document.getElementById("punchOutModal");
const closePunchModal = document.getElementById("closePunchModal");
const cancelPunchModal = document.getElementById("cancelPunchModal");
const confirmPunchOutBtn = document.getElementById("confirmPunchOut");

punchBtn.addEventListener("click", async () => {
  if (isPunchedIn) {
    // Show confirmation modal instead of punching out immediately
    punchOutModal.classList.add("active");
    lucide.createIcons();
  } else {
    // Punch in immediately
    await handlePunchAction();
  }
});

if (punchOutModal) {
  closePunchModal.addEventListener("click", () =>
    punchOutModal.classList.remove("active"),
  );
  cancelPunchModal.addEventListener("click", () =>
    punchOutModal.classList.remove("active"),
  );

  confirmPunchOutBtn.addEventListener("click", async () => {
    punchOutModal.classList.remove("active");
    await handlePunchAction();

    // Re-fetch today's records to aggregate everything correctly
    const user = JSON.parse(localStorage.getItem("user"));
    const todayStr = formatDate(new Date());
    try {
      const resp = await UserService.getPunchInOutDetails(
        user.organizationId,
        user.id,
        todayStr,
        todayStr,
      );
      restoreAttendanceState(resp.data);
    } catch (e) {
      console.error("Aggregation re-sync failed", e);
    }
  });
}

async function handlePunchAction() {
  const user = JSON.parse(localStorage.getItem("user"));
  if (!user || isPunching) return;

  const punchBtn = document.getElementById("punchBtn");
  const punchStatus = punchBtn.querySelector(".punch-status");
  const originalStatus = punchStatus.textContent;

  isPunching = true;
  punchBtn.disabled = true;
  punchStatus.textContent = "..."; // Show loading state

  const now = new Date();
  const todayStr = formatDate(now);

  try {
    if (!isPunchedIn) {
      // PUNCH IN
      const punchInModel = {
        Id: 0,
        UserId: user.id,
        OrganizationId: user.organizationId,
        AttendanceDate: todayStr,
        Start_Time: getISTTime(now),
        End_Time: null,
        Late_Time: null,
        Total_Time: null,
        Status: 0,
      };

      await UserService.punchIn(punchInModel);
      currentAttendance = punchInModel;

      isPunchedIn = true;
      updatePunchUI(true);

      const inSound = document.getElementById("punchInAudio");
      if (inSound) inSound.play().catch((e) => console.warn(e));

      const initialSeconds = parseInt(
        localStorage.getItem(`todayAccumulatedSeconds_${user.id}`) || "0",
      );
      startElapsedTimeTracker(now.toISOString(), initialSeconds);
      startTracking(user);

      console.log("Punched in successfully.");

      // Immediately collect and send system information (Status: 1 for Punch In)
      await syncSystemInfo(user.id, 1);
    } else {
      // PUNCH OUT (Now called from confirm modal)
      // Capture one last screenshot before punching out
      await captureAndUploadScreenshot();

      const punchOutModel = {
        Id: currentAttendance ? currentAttendance.Id : 0,
        UserId: user.id,
        OrganizationId: user.organizationId,
        AttendanceDate: todayStr,
        Start_Time: currentAttendance
          ? currentAttendance.Start_Time
          : getISTTime(now),
        End_Time: getISTTime(now),
        Late_Time: null,
        Total_Time: null,
        Status: 1,
        Punchout_type: "user",
      };

      await UserService.insertAttendance(punchOutModel);

      isPunchedIn = false;
      updatePunchUI(false);

      const outSound = document.getElementById("punchOutAudio");
      if (outSound) outSound.play().catch((e) => console.warn(e));
      stopElapsedTimeTracker();
      stopTracking();
      currentAttendance = null;

      console.log("Punched out successfully.");
      // Synchronize system information (Status: 0 for Punch Out)
      await syncSystemInfo(user.id, 0);
    }
  } catch (error) {
    console.error("Punch action failed", error);
    alert("Action failed. Please check your connection.");
  } finally {
    isPunching = false;
    if (punchBtn) {
      punchBtn.disabled = false;
    }
  }
}

// Triple Button Footer Listeners
document.querySelector(".dashboard-link").addEventListener("click", () => {
  const dashboardUrl = "https://app.workstatus.com"; // REPLACE with your site URL
  if (window.electronAPI && window.electronAPI.openExternal) {
    window.electronAPI.openExternal(dashboardUrl);
  } else {
    window.open(dashboardUrl, "_blank");
  }
});

let isSyncing = false;
document.querySelector(".sync-link").addEventListener("click", () => {
  window.location.reload();
});

const logoutConfirmModal = document.getElementById("logoutConfirmModal");
const logoutWarningModal = document.getElementById("logoutWarningModal");

document.querySelector(".logout-link").addEventListener("click", () => {
  if (isPunchedIn) {
    if (logoutWarningModal) {
      logoutWarningModal.classList.add("active");
      lucide.createIcons();
    }
  } else {
    if (logoutConfirmModal) {
      logoutConfirmModal.classList.add("active");
      lucide.createIcons();
    }
  }
});

// Logout Modal Handlers
document
  .getElementById("closeLogoutModal")
  ?.addEventListener("click", () =>
    logoutConfirmModal.classList.remove("active"),
  );
document
  .getElementById("cancelLogout")
  ?.addEventListener("click", () =>
    logoutConfirmModal.classList.remove("active"),
  );
document.getElementById("confirmLogout")?.addEventListener("click", () => {
  AuthService.logout();
});

document
  .getElementById("closeLogoutWarning")
  ?.addEventListener("click", () =>
    logoutWarningModal.classList.remove("active"),
  );
document
  .getElementById("dismissLogoutWarning")
  ?.addEventListener("click", () =>
    logoutWarningModal.classList.remove("active"),
  );

// Break State
let isOnBreak = false;
let currentBreak = null;
let breakMasterList = [];
let breakTimerInterval = null;

const breakBtn = document.querySelector(".break-btn");
const breakModal = document.getElementById("breakModal");
const closeModal = document.getElementById("closeModal");
const cancelBreak = document.getElementById("cancelBreak");
const startBreakBtn = document.getElementById("startBreak");

if (breakBtn && breakModal) {
  breakBtn.addEventListener("click", () => {
    if (isOnBreak) {
      // Toggle logic: If already on break, end it
      handleEndBreak();
    } else {
      // Show modal to start break
      breakModal.classList.add("active");
      lucide.createIcons();
    }
  });

  const closeHandler = () => {
    breakModal.classList.remove("active");
  };

  closeModal.addEventListener("click", closeHandler);
  cancelBreak.addEventListener("click", closeHandler);

  startBreakBtn.addEventListener("click", async () => {
    const selectedName = document.querySelector(
      'input[name="breakType"]:checked',
    ).value;
    const breakTypeRecord = breakMasterList.find(
      (b) => b.name === selectedName,
    );

    if (!breakTypeRecord) return;

    const user = JSON.parse(localStorage.getItem("user"));
    const now = new Date();

    const breakModel = {
      Id: 0,
      UserId: user.id,
      OrganizationId: user.organizationId,
      BreakDate: formatDate(now),
      Start_Time: getISTTime(now),
      BreakEntryId: breakTypeRecord.id,
      End_Time: null,
      Status: 1,
    };

    try {
      await UserService.insertBreak(breakModel);
      isOnBreak = true;
      isBreakAlertSent = false; // Reset break alert flag
      resetInactivity(); // Reset inactivity timer when starting break
      currentBreak = { ...breakModel, maxTime: breakTypeRecord.max_Break_Time };

      localStorage.setItem("activeBreak", JSON.stringify(currentBreak));
      updateBreakUI(true, selectedName);
      startBreakTimer(now.toISOString(), breakTypeRecord.max_Break_Time);
      closeHandler();
    } catch (e) {
      console.error("Failed to start break", e);
      alert("Could not start break. Please try again.");
    }
  });

  breakModal.addEventListener("click", (e) => {
    if (e.target === breakModal) closeHandler();
  });
}

async function handleEndBreak() {
  if (!currentBreak) return;

  const user = JSON.parse(localStorage.getItem("user"));
  const now = new Date();

  const endModel = {
    ...currentBreak,
    End_Time: getISTTime(now),
    Status: 2,
  };

  try {
    await UserService.insertBreak(endModel);
    isOnBreak = false;
    resetInactivity(); // Reset inactivity timer when resuming work
    currentBreak = null;
    localStorage.removeItem("activeBreak");

    updateBreakUI(false);
    stopBreakTimer();
    console.log("Break ended successfully.");
  } catch (e) {
    console.error("Failed to end break", e);
    alert("Could not end break. Please try again.");
  }
}

const breakTimerModal = document.getElementById("breakTimerModal");
const modalBreakTimer = document.getElementById("modalBreakTimer");
const modalEndBreak = document.getElementById("modalEndBreak");
const timerBreakName = document.getElementById("timerBreakName");

function updateBreakUI(active, name = "") {
  const breakBtnText = breakBtn.querySelector("span");
  const punchBtn = document.getElementById("punchBtn");

  if (active) {
    breakBtn.style.display = "flex";
    breakBtn.classList.add("on-break");

    if (timerBreakName) timerBreakName.textContent = name + " !";
    if (breakTimerModal) breakTimerModal.classList.add("active");

    // Set Dynamic Icon for new UI
    const iconWrapper = document.getElementById("modalBreakIcon");
    if (iconWrapper) {
      const iconName = getIconForBreak(name);
      iconWrapper.innerHTML = `<i data-lucide="${iconName}"></i>`;
      lucide.createIcons();
    }

    // Reset modal colors for new break
    if (modalBreakTimer) modalBreakTimer.style.color = "";
    if (modalEndBreak) {
      modalEndBreak.style.backgroundColor = "";
      modalEndBreak.style.boxShadow = "";
    }

    if (punchBtn) {
      punchBtn.disabled = true;
      punchBtn.style.opacity = "0.5";
      punchBtn.style.pointerEvents = "none";
    }
  } else {
    breakBtn.style.display = isPunchedIn ? "flex" : "none";
    breakBtn.classList.remove("on-break");
    breakBtn.innerHTML = `<i data-lucide="coffee"></i><span>Break</span>`;
    breakBtn.style.backgroundColor = "";
    breakBtn.style.color = "";

    // Close Break Timer Modal
    if (breakTimerModal) breakTimerModal.classList.remove("active");

    lucide.createIcons();
    if (punchBtn) {
      punchBtn.disabled = false;
      punchBtn.style.opacity = "1";
      punchBtn.style.pointerEvents = "auto";
    }
  }
}

function startBreakTimer(startTime, maxMinutes) {
  const start = new Date(startTime).getTime();
  const maxMs = maxMinutes * 60 * 1000;
  const breakBtnText = breakBtn.querySelector("span");
  const name = currentBreak ? currentBreak.name || "Break" : "Break";

  if (breakTimerInterval) clearInterval(breakTimerInterval);

  const updateTimer = () => {
    const now = new Date().getTime();
    const elapsed = now - start;
    const remainingMs = maxMs - elapsed;

    let timeText = "";
    if (remainingMs > 0) {
      const rH = Math.floor(remainingMs / 3600000);
      const rM = Math.floor((remainingMs % 3600000) / 60000);
      const rS = Math.floor((remainingMs % 60000) / 1000);
      timeText = `${String(rH).padStart(2, "0")}:${String(rM).padStart(2, "0")}:${String(rS).padStart(2, "0")}`;
    } else {
      const overMs = Math.abs(remainingMs);
      const oH = Math.floor(overMs / 3600000);
      const oM = Math.floor((overMs % 3600000) / 60000);
      const oS = Math.floor((overMs % 60000) / 1000);
      timeText = `${String(oH).padStart(2, "0")}:${String(oM).padStart(2, "0")}:${String(oS).padStart(2, "0")}`;

      breakBtn.style.backgroundColor = "#ef4444";
      breakBtn.style.color = "white";
      const icon = breakBtn.querySelector("i");
      if (icon) icon.style.color = "white";

      // Make modal timer and button red when exceeded
      if (modalBreakTimer) {
        modalBreakTimer.style.color = "var(--danger)";
      }
      if (modalEndBreak) {
        modalEndBreak.style.backgroundColor = "var(--danger)";
        modalEndBreak.style.boxShadow = "0 10px 20px rgba(239, 68, 68, 0.2)";
      }

      // Trigger Alert if break exceeds 5 minutes
      if (overMs > 5 * 60 * 1000 && !isBreakAlertSent) {
        handleAlertTrigger("Break Time Exceeded");
        isBreakAlertSent = true;
      }

      triggerBreakAlert();
    }

    if (modalBreakTimer) modalBreakTimer.textContent = timeText;
  };

  updateTimer(); // Initial call to avoid 1s delay
  breakTimerInterval = setInterval(updateTimer, 1000);
}

if (modalEndBreak) {
  modalEndBreak.addEventListener("click", handleEndBreak);
}

let breakAlertInterval = false;
let breakAlertTimeout = null;

function stopBreakTimer() {
  if (breakTimerInterval) {
    clearInterval(breakTimerInterval);
    breakTimerInterval = null;
  }

  // Stop the sound loop
  breakAlertInterval = false;
  if (breakAlertTimeout) {
    clearTimeout(breakAlertTimeout);
    breakAlertTimeout = null;
  }

  // Explicitly stop and reset the alert audio
  const notifyAudio = document.getElementById("resumeNotifyAudio");
  if (notifyAudio) {
    notifyAudio.onended = null;
    notifyAudio.pause();
    notifyAudio.currentTime = 0;
  }
}

function triggerBreakAlert() {
  // If alert is already running, don't start another one
  if (breakAlertInterval) return;

  const notifyAudio = document.getElementById("resumeNotifyAudio");
  if (!notifyAudio) return;

  breakAlertInterval = true;

  const playCycle = () => {
    if (!breakAlertInterval) return;

    // Reset and play
    notifyAudio.currentTime = 0;
    
    // Create a one-time listener for the 'ended' event
    const handleEnded = () => {
      notifyAudio.removeEventListener('ended', handleEnded);
      if (breakAlertInterval) {
        // Wait 20 seconds AFTER it ends, then play again
        breakAlertTimeout = setTimeout(playCycle, 20000);
      }
    };

    notifyAudio.addEventListener('ended', handleEnded);

    notifyAudio.play().catch((e) => {
      console.warn("Break alert audio play failed, retrying in 20s:", e);
      notifyAudio.removeEventListener('ended', handleEnded);
      if (breakAlertInterval) {
        breakAlertTimeout = setTimeout(playCycle, 20000);
      }
    });
  };

  // Start the first play
  playCycle();
}

// --- Inactivity Tracking Logic ---

function resetInactivity() {
  lastActivityTime = Date.now();
  lastIdleApiCallTime = 0; // Reset API call tracker
  if (isIdleReported) {
    console.log("User resumed activity.");
    isIdleReported = false;
  }
  isInactivityAlertSent = false; // Reset inactivity alert flag

  // Hide warning modal if open
  const modal = document.getElementById("inactivityModal");
  if (modal) modal.classList.remove("active");

  stopInactivitySound();
}

let inactivitySoundTimeout = null;
function playInactivitySound() {
  const audio = document.getElementById("resumeNotifyAudio");
  if (!audio || inactivitySoundTimeout) return;

  const playHandler = () => {
    audio.currentTime = 0;
    audio
      .play()
      .then(() => {
        audio.onended = () => {
          // When sound finishes, wait 20s before playing again
          inactivitySoundTimeout = setTimeout(playHandler, 20000);
        };
      })
      .catch((e) => {
        console.warn("Inactivity audio error:", e);
        // If blocked/error, retry anyway in 20s
        inactivitySoundTimeout = setTimeout(playHandler, 20000);
      });
  };

  playHandler();
}

function stopInactivitySound() {
  const audio = document.getElementById("resumeNotifyAudio");
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    audio.onended = null;
  }
  if (inactivitySoundTimeout) {
    clearTimeout(inactivitySoundTimeout);
    inactivitySoundTimeout = null;
  }
}

function startInactivityChecker(user) {
  if (inactivityChecker) clearInterval(inactivityChecker);

  // Attach local events for immediate activity detection
  window.addEventListener("mousemove", (e) => {
    if (isOnBreak) return;
    // Only reset if modal is NOT active
    const modal = document.getElementById("inactivityModal");
    if (modal && !modal.classList.contains("active")) {
      resetInactivity();
    }
  });

  window.addEventListener("keydown", () => {
    if (!isOnBreak) resetInactivity();
  });

  window.addEventListener("click", (e) => {
    if (isOnBreak) return;
    const modal = document.getElementById("inactivityModal");
    if (modal && !modal.classList.contains("active")) {
      resetInactivity();
    }
  });

  inactivityChecker = setInterval(async () => {
    if (!inactivityRules.enableTracking || isOnBreak) return;

    // FETCH GLOBAL SYSTEM IDLE TIME (in seconds)
    let idleSeconds = 0;
    if (window.electronAPI && window.electronAPI.checkSystemIdleTime) {
      idleSeconds = await window.electronAPI.checkSystemIdleTime();
    } else {
      // Fallback to local tracking if API missing
      idleSeconds = Math.floor((Date.now() - lastActivityTime) / 1000);
    }

    const idleTimeMs = idleSeconds * 1000;
    const modal = document.getElementById("inactivityModal");

    // 1. Alert Threshold
    if (
      idleTimeMs >= inactivityRules.alertThresholdMs &&
      idleTimeMs < inactivityRules.punchoutThresholdMs
    ) {
      if (
        inactivityRules.enableAlerts &&
        modal &&
        !modal.classList.contains("active")
      ) {
        modal.classList.add("active");
        lucide.createIcons();
        playInactivitySound();

        if (!isInactivityAlertSent) {
          handleAlertTrigger("Inactivity Detected");
          isInactivityAlertSent = true;
        }
      }
    }

    // 2. Periodic Idle Reporting (Every 2 minutes when idle)
    if (idleTimeMs >= IDLE_API_TRIGGER_THRESHOLD && !isOnBreak) {
      const now = Date.now();
      if (
        lastIdleApiCallTime === 0 ||
        now - lastIdleApiCallTime >= IDLE_API_TRIGGER_THRESHOLD
      ) {
        lastIdleApiCallTime = now;
        console.log("Reporting periodic 2nd minute idle activity...");

        try {
          await UserService.insertIdealActivity({
            UserId: user.id,
            OrganizationId: user.organizationId,
            Ideal_duration: 2, // Fixed 2 minutes as per requirement
            Ideal_DateTime: getISTTime(),
          });
        } catch (e) {
          console.error("Periodic idle report failed:", e);
        }
      }
    }

    // 3. Punchout Threshold
    if (idleTimeMs >= inactivityRules.punchoutThresholdMs) {
      if (!isIdleReported) {
        isIdleReported = true;
        console.warn(
          "Inactivity threshold reached. Triggering Auto Punch-Out.",
        );

        const durationMins = Math.floor(idleTimeMs / 60000);

        try {
          // Report idle time to backend
          await UserService.insertIdealActivity({
            UserId: user.id,
            OrganizationId: user.organizationId,
            Ideal_duration: durationMins,
            Ideal_DateTime: getISTTime(),
          });

          // Perform Auto Punch-Out
          await handleAutoPunchOutAction(user);
        } catch (e) {
          console.error("Failed to report inactivity / auto punch-out", e);
        }
      }
    }
  }, 2000); // Check every 2 seconds for better responsiveness
}

function stopInactivityChecker() {
  if (inactivityChecker) {
    clearInterval(inactivityChecker);
    inactivityChecker = null;
  }
  window.removeEventListener("mousemove", resetInactivity);
  window.removeEventListener("keydown", resetInactivity);
  window.removeEventListener("click", resetInactivity);

  const modal = document.getElementById("inactivityModal");
  if (modal) modal.classList.remove("active");
  stopInactivitySound();
}

async function handleAutoPunchOutAction(user) {
  const now = new Date();
  const todayStr = formatDate(now);

  // Capture final screenshot
  await captureAndUploadScreenshot();

  const punchOutModel = {
    Id: currentAttendance ? currentAttendance.Id : 0,
    UserId: user.id,
    OrganizationId: user.organizationId,
    AttendanceDate: todayStr,
    Start_Time: currentAttendance
      ? currentAttendance.Start_Time
      : getISTTime(now),
    End_Time: getISTTime(now),
    Status: 1,
    Punchout_type: "system", // Mark as system
  };

  try {
    await UserService.insertAttendance(punchOutModel);
    isPunchedIn = false;
    updatePunchUI(false);
    stopElapsedTimeTracker();
    stopTracking();
    currentAttendance = null;

    console.log("Auto punch-out successful due to inactivity.");

    // Synchronize system information (Status: 0 for Auto Punch Out)
    await syncSystemInfo(user.id, 0);

    // Optionally redirect or show a specific message
    alert("You have been auto punched out due to inactivity.");
  } catch (e) {
    console.error("Auto punch-out submission failed", e);
  }
}

// Modal "I'm Still Working" button
document.getElementById("imActiveBtn")?.addEventListener("click", () => {
  resetInactivity();
});

// Modal "No" button
document
  .getElementById("noPunchOutBtn")
  ?.addEventListener("click", async () => {
    stopInactivitySound();
    const modal = document.getElementById("inactivityModal");
    if (modal) modal.classList.remove("active");

    const user = JSON.parse(localStorage.getItem("user"));
    if (user) {
      await handleAutoPunchOutAction(user);
    }
  });

async function syncSystemInfo(userId, status) {
  try {
    if (window.electronAPI && window.electronAPI.getSystemInfo) {
      const sysInfo = await window.electronAPI.getSystemInfo();
      sysInfo.userId = userId;
      sysInfo.status = status;
      await SystemService.insertOrUpdateSystemInfo(sysInfo);
      console.log(
        `System information (status: ${status}) synchronized successfully.`,
      );
    }
  } catch (err) {
    console.error(`System information sync failed (status: ${status}):`, err);
  }
}

// Update every second
setInterval(updateClock, 1000);
updateClock();
