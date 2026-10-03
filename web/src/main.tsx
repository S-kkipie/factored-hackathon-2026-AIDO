import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentPage } from "./pages/Agent";
import { ChatPage } from "./pages/Chat";
import { LoginPage } from "./pages/Login";
import { TracePage } from "./pages/Trace";
import { session } from "./session";
import "./styles.css";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: session.customer() ? "/chat" : "/login" });
  },
});

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  beforeLoad: () => {
    if (!session.customer()) throw redirect({ to: "/login" });
  },
  component: ChatPage,
});

const agentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agent", component: AgentPage });

const traceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/trace/$session", component: TracePage });

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, loginRoute, chatRoute, agentRoute, traceRoute]),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
