import React from "react";
import MailTable from "./components/MailTable.jsx";
import Stats from "./components/Stats.jsx";

export default function App() {
  return (
    <div>
      <h1>Mail System Dashboard</h1>
      <Stats />
      <MailTable status="Pending" />
      <MailTable status="Failed" />
      <MailTable status="Sent" />
    </div>
  );
}