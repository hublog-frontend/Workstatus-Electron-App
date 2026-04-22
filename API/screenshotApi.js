const SCREENSHOT_API_BASE_URL = "https://localhost:7263/api";

const getScreenshotClient = () => {
  if (typeof axios === "undefined") {
    console.error("Axios is not loaded!");
    return null;
  }
  return axios.create({
    baseURL: SCREENSHOT_API_BASE_URL,
    // We omit the default Content-Type header here so Axios/Browser
    // can automatically handle multipart/form-data with boundaries.
  });
};

const screenshotClient = getScreenshotClient();

if (screenshotClient) {
  screenshotClient.interceptors.request.use(
    (config) => {
      const token = localStorage.getItem("token");
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );
}

const ScreenshotService = {
  uploadScreenshot: (userId, orgId, date, formData) => {
    if (!screenshotClient) return Promise.reject("Axios not loaded");
    return screenshotClient.post("/Users/UploadFile", formData, {
      headers: {
        UId: userId,
        OId: orgId,
        SDate: date,
        SType: "Auto",
      },
    });
  },
};
