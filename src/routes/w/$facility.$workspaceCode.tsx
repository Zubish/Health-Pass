import { createFileRoute, redirect } from "@tanstack/react-router";

// The name is a readable label; the unique code is authoritative and is verified by the API.
// Existing links continue to work after a facility name changes.
export const Route = createFileRoute("/w/$facility/$workspaceCode")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/workspace",
      search: { mode: "professional-signin", workspace: params.workspaceCode },
      replace: true,
    });
  },
});
