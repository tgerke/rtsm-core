import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppLayout } from "./app.js";
import { LoginPage } from "./pages/login.js";
import { StudyPage } from "./pages/study.js";

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/study" });
  },
});

const studyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/study",
  component: StudyPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([indexRoute, studyRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
