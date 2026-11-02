// Synthetic Teaching IDE fixture - sample content only, never executed.
import { createRouter } from "./routes.ts";

const PORT = 3000;

const router = createRouter();

function handleRequest(request: Request): Response {
  return router.dispatch(request);
}

const server = {
  listen(port: number) {
    console.log(`Demo server listening on http://localhost:${port}`);
  },
};

server.listen(PORT);
export { handleRequest };
