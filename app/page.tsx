import type { Metadata } from "next";
import { Overview } from "./overview";

export const metadata: Metadata = {
  title: "Overview · News Feed Concierge",
  description: "See the most important learning, processing, delivery, and algorithm signals in one place.",
};

export default function Home() {
  return <Overview />;
}
