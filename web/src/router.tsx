import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Layout } from "./Layout";
import { AgentPage } from "./pages/AgentPage";
import { ChatPage } from "./pages/ChatPage";
import { LoginPage } from "./pages/LoginPage";
import { TracePage } from "./pages/TracePage";
import { readCustomer } from "./session";

const rootRoute = createRootRoute({ component: Layout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/login" });
  },
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { expired?: boolean } => (search.expired ? { expired: true } : {}),
  component: LoginPage,
});

export const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  beforeLoad: () => {
    if (!readCustomer()) throw redirect({ to: "/login" });
  },
  component: ChatPage,
});

export const agentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agent", component: AgentPage });

export const traceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/trace/$session", component: TracePage });

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, loginRoute, chatRoute, agentRoute, traceRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
