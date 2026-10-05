import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CustomerShell } from "./components/CustomerShell";
import { AgentPage } from "./pages/Agent";
import { CasesPage } from "./pages/Cases";
import { ChatPage } from "./pages/Chat";
import { HomePage } from "./pages/Home";
import { LoginPage } from "./pages/Login";
import { SupervisionPage } from "./pages/Supervision";
import { TracePage } from "./pages/Trace";
import { session } from "./session";
import { applyTheme, storedTheme } from "./theme";
// Self-hosted fonts (CSP forbids external font/style origins): Inter for UI text, JetBrains Mono for ids/numbers.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./styles.css";
import "./pages.css";
import "./brand.css";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: session.customer() ? "/inicio" : "/login" });
  },
});

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });

/** Customer area: one layout (navigation + shared conversation) for Home, Assistant and My cases. */
const customerRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "customer",
  beforeLoad: () => {
    if (!session.customer()) throw redirect({ to: "/login" });
  },
  component: CustomerShell,
});
const homeRoute = createRoute({ getParentRoute: () => customerRoute, path: "/inicio", component: HomePage });
const chatRoute = createRoute({ getParentRoute: () => customerRoute, path: "/chat", component: ChatPage });
const casesRoute = createRoute({ getParentRoute: () => customerRoute, path: "/casos", component: CasesPage });

const agentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agent", component: AgentPage });

const supervisionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/supervision", component: SupervisionPage });

const traceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/trace/$session", component: TracePage });

const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    loginRoute,
    customerRoute.addChildren([homeRoute, chatRoute, casesRoute]),
    agentRoute,
    supervisionRoute,
    traceRoute,
  ]),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

applyTheme(storedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
