import { createRoot } from "react-dom/client";
import App from "./App";
import "./ui/tokens.css";
import "./ui/app.css";

// No StrictMode: deliberate — effects that create Monaco/xterm surfaces must
// run exactly once in P4.
createRoot(document.getElementById("root")!).render(<App />);
