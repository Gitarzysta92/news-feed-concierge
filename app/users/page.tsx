import type { Metadata } from "next";
import { UserManagement } from "./user-management";

export const metadata: Metadata = {
  title: "Users · News Feed Concierge",
  description: "Manage anonymous and edge-created News Feed Concierge user identities and display names.",
};

export default function UsersPage() {
  return <UserManagement />;
}
