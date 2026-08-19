import type { Metadata } from "next";
import { AlgorithmCatalog } from "./algorithm-catalog";

export const metadata: Metadata = {
  title: "Ranking algorithms · News Feed Concierge",
  description: "Inspect the ranking algorithms registered with News Feed Concierge.",
};

export default function AlgorithmsPage() {
  return <AlgorithmCatalog />;
}
