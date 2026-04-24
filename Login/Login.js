// Initialize Lucide Icons
lucide.createIcons();

window.addEventListener("DOMContentLoaded", async () => {
  if (window.electronAPI && window.electronAPI.getConfig) {
    try {
      const config = await window.electronAPI.getConfig();
      if (config.apiBaseUrl) {
        SystemService.setBaseUrl(config.apiBaseUrl);
        if (typeof ScreenshotService !== "undefined") {
          ScreenshotService.setBaseUrl(config.apiBaseUrl);
        }
      }
    } catch (err) {
      console.error("Login config load failed:", err);
    }
  }
});

// Close Window Logic
document.querySelector(".close-btn").addEventListener("click", () => {
  window.electronAPI.closeWindow();
});

// Auto-Login Logic: If user already logged in, skip to dashboard
(function checkAutoLogin() {
  const user = localStorage.getItem("user");
  const token = localStorage.getItem("token");
  if (user && token) {
    console.log("Existing session found, redirecting to Dashboard...");
    window.location.href = "../Dashboard/Dashboard.html";
  } else {
    // If no session, show the login page
    if (window.electronAPI && window.electronAPI.showWindow) {
      window.electronAPI.showWindow();
    }
  }
})();

// Password Toggle Logic
const togglePassword = document.querySelector("#togglePassword");
const password = document.querySelector("#password");
const emailInput = document.querySelector("#email");
const loginForm = document.querySelector("#loginForm");
const emailError = document.querySelector("#emailError");
const passwordError = document.querySelector("#passwordError");

if (loginForm) {
  // Saved Emails Logic
  const savedInfoDropdown = document.querySelector("#savedInfoDropdown");
  const savedEmailsList = document.querySelector("#savedEmailsList");
  const closeDropdown = document.querySelector("#closeDropdown");

  function getSavedEmails() {
    const emails = localStorage.getItem("savedEmails");
    return emails ? JSON.parse(emails) : [];
  }

  function saveEmail(email) {
    let emails = getSavedEmails();
    if (!emails.includes(email)) {
      emails.push(email);
      localStorage.setItem("savedEmails", JSON.stringify(emails));
    }
  }

  function populateSavedEmails() {
    const emails = getSavedEmails();
    if (emails.length === 0) return;

    savedEmailsList.innerHTML = "";
    emails.forEach((email) => {
      const item = document.createElement("div");
      item.className = "saved-email-item";
      item.textContent = email;
      item.addEventListener("click", () => {
        emailInput.value = email;
        savedInfoDropdown.classList.remove("active");
        emailError.textContent = ""; // Clear existing error if any
      });
      savedEmailsList.appendChild(item);
    });
  }

  emailInput.addEventListener("focus", () => {
    const emails = getSavedEmails();
    if (emails.length > 0) {
      populateSavedEmails();
      savedInfoDropdown.classList.add("active");
    }
  });

  // Close dropdown on click outside or close button
  document.addEventListener("click", (e) => {
    if (
      !emailInput.contains(e.target) &&
      !savedInfoDropdown.contains(e.target)
    ) {
      savedInfoDropdown.classList.remove("active");
    }
  });

  if (closeDropdown) {
    closeDropdown.addEventListener("click", (e) => {
      e.stopPropagation();
      savedInfoDropdown.classList.remove("active");
    });
  }

  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const submitBtn = loginForm.querySelector(".login-btn");
    const originalText = submitBtn.textContent;

    // Validate
    const emailErr = emailValidator(emailInput.value);
    const passwordErr = passwordValidator(password.value);

    // Display Errors
    emailError.textContent = emailErr;
    passwordError.textContent = passwordErr;

    if (!emailErr && !passwordErr) {
      // Show loading state
      submitBtn.disabled = true;
      submitBtn.textContent = "Authenticating...";
      submitBtn.style.opacity = "0.7";
      submitBtn.style.cursor = "not-allowed";

      // Use centralized AuthService with async/await
      (async () => {
        try {
          const response = await AuthService.login({
            userName: emailInput.value,
            password: password.value,
          });

          // Store user and token in localStorage
          localStorage.setItem("user", JSON.stringify(response.data.user));
          localStorage.setItem("token", response.data.token);

          // Save email to "Saved info" list
          saveEmail(emailInput.value);

          console.log("Login successful! Navigating to Dashboard...");
          window.location.href = "../Dashboard/Dashboard.html";
        } catch (error) {
          // Reset button state
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
          submitBtn.style.opacity = "1";
          submitBtn.style.cursor = "pointer";

          // Handle Error
          if (error.response && error.response.status === 401) {
            passwordError.textContent = "Invalid email or password.";
          } else if (error.response) {
            passwordError.textContent = "Invalid email or password.";
          } else {
            passwordError.textContent =
              "Server unreachable. Check your connection.";
            console.error("API Error:", error);
          }
        }
      })();
    }
  });
}

if (togglePassword && password) {
  togglePassword.addEventListener("click", function () {
    const isPassword = password.getAttribute("type") === "password";

    // 1. Toggle input type
    password.setAttribute("type", isPassword ? "text" : "password");

    // 2. Fetch the current icons (Lucide might have replaced them with SVGs)
    // We use querySelector to find them inside the wrapper
    const eyeIcon = document.querySelector("#eyeIcon");
    const eyeOffIcon = document.querySelector("#eyeOffIcon");

    // 3. Toggle icon visibility
    if (isPassword) {
      // Showing password -> Show "eye"
      if (eyeIcon) eyeIcon.style.setProperty("display", "block", "important");
      if (eyeOffIcon)
        eyeOffIcon.style.setProperty("display", "none", "important");
    } else {
      // Hiding password -> Show "eye-off"
      if (eyeIcon) eyeIcon.style.setProperty("display", "none", "important");
      if (eyeOffIcon)
        eyeOffIcon.style.setProperty("display", "block", "important");
    }
  });
}

// Screenshot Logic
const screenshotBtn = document.querySelector("#screenshotBtn");
let screenshotInterval = null;
let isCapturing = false;

if (screenshotBtn) {
  screenshotBtn.addEventListener("click", async () => {
    if (isCapturing) {
      // Stop capturing
      clearInterval(screenshotInterval);
      screenshotInterval = null;
      isCapturing = false;
      screenshotBtn.textContent = "Start to Take Screenshot";
      screenshotBtn.classList.remove("capturing");
      console.log("Screenshot capture stopped.");
    } else {
      // Start capturing
      isCapturing = true;
      screenshotBtn.textContent = "Stop Taking Screenshots";
      screenshotBtn.classList.add("capturing");

      // Take first screenshot immediately
      await window.electronAPI.takeScreenshot();

      // Set interval for every 5 seconds
      screenshotInterval = setInterval(async () => {
        await window.electronAPI.takeScreenshot();
      }, 5000);

      console.log("Screenshot capture started (every 5s).");
    }
  });
}
