// Synthetic Teaching IDE fixture - sample content only, never executed.
export interface Route {
  method: string;
  path: string;
  label: string;
}

const routes: Route[] = [
  { method: "GET", path: "/", label: "Home" },
  { method: "GET", path: "/tasks", label: "Tasks" },
  { method: "POST", path: "/tasks", label: "Create task" },
];

export function createRouter() {
  return {
    dispatch(_request: Request): Response {
      return new Response("demo fixture response", { status: 200 });
    },
    routes,
  };
}
