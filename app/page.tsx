import type { Metadata } from "next";
import { Dashboard } from "./dashboard";

export const metadata: Metadata = {
  title: "News Feed Concierge · Control room",
  description: "Monitor ingestion, ranking, delivery, and channel feedback.",
};

export default function Home() {
  return <Dashboard />;
}
