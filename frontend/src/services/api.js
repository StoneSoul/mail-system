import axios from "axios";

const API_URL = "http://localhost:3000";

const apiClient = axios.create({
  baseURL: API_URL,
  withCredentials: true
});

export async function login(username, password) {
  const res = await apiClient.post("/auth/login", { username, password });
  return res.data;
}

export function logout() {
  return apiClient.post("/auth/logout");
}

export async function getAuthStatus() {
  const res = await apiClient.get("/auth/status");
  return res.data;
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
