import axios from "axios";

const API_URL = "http://localhost:3000"; // tu API Node

export async function getMails(status) {
  const res = await axios.get(`${API_URL}/mails`);
  if (status) return res.data.filter(m => m.status === status);
  return res.data;
}

export async function retryMail(id) {
  return axios.post(`${API_URL}/mails/retry/${id}`);
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