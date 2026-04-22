let API_BASE_URL = ""; // Will be set dynamically from .env via SystemService.setBaseUrl

// Create a function to get the client, ensuring axios is loaded
const getApiClient = () => {
  if (typeof axios === "undefined") {
    console.error(
      "Axios is not loaded! Please check your network or CSP settings.",
    );
    return null;
  }
  return axios.create({
    baseURL: API_BASE_URL,
    headers: {
      "Content-Type": "application/json",
    },
  });
};

const apiClient = getApiClient();

// Request Interceptor to add Token
if (apiClient) {
  apiClient.interceptors.request.use(
    (config) => {
      const token = localStorage.getItem("token");
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    },
    (error) => {
      return Promise.reject(error);
    },
  );
}

// Centralized API calls
const AuthService = {
  login: (credentials) => {
    if (!apiClient) {
      return Promise.reject(
        new Error("API Client not initialized (Axios missing)"),
      );
    }
    return apiClient.post("/Login/login", credentials);
  },

  logout: () => {
    localStorage.removeItem("user");
    localStorage.removeItem("token");
    window.location.href = "../Login/Login.html";
  },
};

const UserService = {
  getBreaks: (orgId) => {
    return apiClient.get(`/Users/GetBreakMasterById?id=${orgId}`);
  },

  getPunchInOutDetails: (orgId, userId, start, end) => {
    return apiClient.get(
      `/Users/GetUserPunchInOutDetails?OrganizationId=${orgId}&UserId=${userId}&startDate=${start}&endDate=${end}`,
    );
  },

  getActiveTime: (userId, date) => {
    return apiClient.get(
      `/Users/Get_Active_Time?userid=${userId}&startDate=${date}&endDate=${date}`,
    );
  },

  punchIn: (punchInData) => {
    return apiClient.post("/Users/PunchIn_InsertAttendance", [punchInData]);
  },

  insertAttendance: (attendanceData) => {
    return apiClient.post("/Users/InsertAttendance", [attendanceData]);
  },

  insertBreak: (breakData) => {
    return apiClient.post("/Users/InsertBreak", [breakData]);
  },

  getBreakRecords: (orgId, userId, start, end) => {
    return apiClient.get(
      `/Users/GetUserBreakRecordDetails?OrganizationId=${orgId}&UserId=${userId}&startDate=${start}&endDate=${end}`,
    );
  },

  insertActiveTime: (data) => {
    return apiClient.post("/Users/Insert_Active_Time", data);
  },

  insertIdealActivity: (data) => {
    return apiClient.post("/Users/Insert_IdealActivity", data);
  },

  insertApplicationActivity: (data) => {
    return apiClient.post("/AppsUrls/Application", data);
  },

  insertUrlActivity: (data) => {
    return apiClient.post("/AppsUrls/Url", data);
  },
};

const AlertService = {
  getAlertRules: (orgId) => {
    return apiClient.get(`/Alert/GetAlertRule?OrganizationId=${orgId}`);
  },

  insertAlert: (alertData) => {
    return apiClient.post("/Alert/InsertAlert", alertData);
  },
};

const SystemService = {
  getVersion: () => {
    return apiClient.get("/SystemInfo/GetHublogVersion");
  },
  insertOrUpdateSystemInfo: (systemInfo) => {
    return apiClient.post("/SystemInfo/InsertOrUpdateSystemInfo", systemInfo);
  },
  setBaseUrl: (url) => {
    if (apiClient) apiClient.defaults.baseURL = url;
  },
};
