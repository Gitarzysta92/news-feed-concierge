import type { Metadata } from "next";
import { OperationQueue } from "./operation-queue";

export const metadata: Metadata = {
  title: "Operation queue · News Feed Concierge",
  description: "Inspect queued, running, completed, and failed News Feed Concierge actions.",
};

export default function QueuePage() {
  return <OperationQueue />;
}
