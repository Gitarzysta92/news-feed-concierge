import type { Metadata } from "next";
import { Dashboard } from "../dashboard";

export const metadata: Metadata = {
  title: "Learning · News Feed Concierge",
  description: "Inspect ranked articles, processing decisions, reactions, and the live channel learning profile.",
};

export default function LearningPage() {
  return <Dashboard />;
}
