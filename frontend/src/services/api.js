import axios from "axios";

const API_URL = (import.meta.env.VITE_API_URL || "").trim();

const apiClient = axios.create({
  baseURL: API_URL || undefined,
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

export async function getMails(status, errorCategory) {
  const params = {};
  if (status) params.status = status;
  if (errorCategory) params.errorCategory = errorCategory;

  const res = await apiClient.get("/api/queue", { params });
  return res.data;
}

export async function retryMail(id) {
  return apiClient.post(`/mails/retry/${id}`);
}

export async function deleteQueueItems({ ids, status, errorCategory }) {
  return apiClient.post("/api/queue/delete", { ids, status, errorCategory });
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
