import axios from "axios";

const API_URL = "http://localhost:3000";

const apiClient = axios.create({
  baseURL: API_URL
});

apiClient.interceptors.request.use(config => {
  const token = localStorage.getItem("mail_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export async function login(username, password) {
  const res = await apiClient.post("/api/auth/login", { username, password });
  if (res.data?.token) {
    localStorage.setItem("mail_token", res.data.token);
  }
  return res.data;
}

export function logout() {
  localStorage.removeItem("mail_token");
}

export function isLoggedIn() {
  return Boolean(localStorage.getItem("mail_token"));
}

export async function getMails(status) {
  const res = await apiClient.get("/mails");
  if (status) return res.data.filter(m => m.status === status);
  return res.data;
}

export async function retryMail(id) {
  return apiClient.post(`/mails/retry/${id}`);
}

export async function getStats() {
  const mails = await getMails();
  return {
    total: mails.length,
    sent: mails.filter(m => m.status === "Sent").length,
    failed: mails.filter(m => m.status === "Failed").length,
    pending: mails.filter(m => m.status === "Pending").length
  };
}
