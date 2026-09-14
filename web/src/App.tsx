import { Component, createSignal, onMount, onCleanup, Show, Suspense, lazy } from "solid-js";
import { Router, Route, Navigate } from "@solidjs/router";
import { currentUser, doLogout, loadSession } from "./stores/auth";
import { Layout } from "./components/shared/Layout";
import { ToastHost } from "./components/shared/Toast";
import { ConfirmModal } from "./components/shared/ConfirmModal";

// Keep the login shell small; page-only dependencies (xterm, CodeMirror,
// compose converters) load with the route that needs them.
const LoginPage = lazy(() => import("./components/auth/LoginPage").then((m) => ({ default: m.LoginPage })));
const OverviewPage = lazy(() => import("./components/overview/OverviewPage").then((m) => ({ default: m.OverviewPage })));
const ContainerListPage = lazy(() => import("./components/containers/ContainerListPage").then((m) => ({ default: m.ContainerListPage })));
const ContainerDetailPage = lazy(() => import("./components/containers/ContainerDetailPage").then((m) => ({ default: m.ContainerDetailPage })));
const TerminalWindowPage = lazy(() => import("./components/containers/TerminalWindowPage").then((m) => ({ default: m.TerminalWindowPage })));
const ImageListPage = lazy(() => import("./components/images/ImageListPage").then((m) => ({ default: m.ImageListPage })));
const ComposeListPage = lazy(() => import("./components/compose/ComposeListPage").then((m) => ({ default: m.ComposeListPage })));
const ComposeDetailPage = lazy(() => import("./components/compose/ComposeDetailPage").then((m) => ({ default: m.ComposeDetailPage })));
const NetworkListPage = lazy(() => import("./components/networks/NetworkListPage").then((m) => ({ default: m.NetworkListPage })));
const VolumeListPage = lazy(() => import("./components/volumes/VolumeListPage").then((m) => ({ default: m.VolumeListPage })));
const EventsPage = lazy(() => import("./components/events/EventsPage").then((m) => ({ default: m.EventsPage })));
const ConfigFilesPage = lazy(() => import("./components/config/ConfigFilesPage").then((m) => ({ default: m.ConfigFilesPage })));
const UsersPage = lazy(() => import("./components/settings/UsersPage").then((m) => ({ default: m.UsersPage })));
const RegistriesPage = lazy(() => import("./components/settings/RegistriesPage").then((m) => ({ default: m.RegistriesPage })));
const DockerSettingsPage = lazy(() => import("./components/settings/DockerSettingsPage").then((m) => ({ default: m.DockerSettingsPage })));
const AuditPage = lazy(() => import("./components/settings/AuditPage").then((m) => ({ default: m.AuditPage })));

// Guard wraps the authenticated layout; redirects to /login when no user.
const Guard: Component<{ children?: any }> = (props) => {
  return (
    <Show when={currentUser()} fallback={<Navigate href="/login" />}>
      <Layout>
        <Suspense fallback={<div class="p-8">加载中…</div>}>{props.children}</Suspense>
      </Layout>
    </Show>
  );
};

export const App: Component = () => {
  const [ready, setReady] = createSignal(false);
  onMount(() => {
    const onUnauthorized = () => doLogout();
    window.addEventListener("phyless:unauthorized", onUnauthorized);
    onCleanup(() => window.removeEventListener("phyless:unauthorized", onUnauthorized));
    void loadSession().finally(() => setReady(true));
  });

  return (
    <Show when={ready()} fallback={<div class="p-8">…</div>}>
      <ToastHost />
      <ConfirmModal />
      <Suspense fallback={<div class="p-8">加载中…</div>}>
      <Router>
        <Route path="/login" component={LoginPage} />
        {/* Outside Guard/Layout on purpose — opened as a chrome-less popup
            window (see ConsoleModal), not part of the normal app navigation. */}
        <Route path="/terminal/:id" component={TerminalWindowPage} />
        <Route path="/" component={Guard}>
          <Route path="/" component={() => <Navigate href="/overview" />} />
          <Route path="/overview" component={OverviewPage} />
          <Route path="/containers" component={ContainerListPage} />
          <Route path="/containers/:id" component={ContainerDetailPage} />
          <Route path="/images" component={ImageListPage} />
          <Route path="/compose" component={ComposeListPage} />
          <Route path="/compose/:id" component={ComposeDetailPage} />
          <Route path="/networks" component={NetworkListPage} />
          <Route path="/volumes" component={VolumeListPage} />
          <Route path="/events" component={EventsPage} />
          <Route path="/config" component={ConfigFilesPage} />
          <Route path="/settings/users" component={UsersPage} />
          <Route path="/settings/registries" component={RegistriesPage} />
          <Route path="/settings/docker" component={DockerSettingsPage} />
          <Route path="/settings/audit" component={AuditPage} />
          <Route path="/*all" component={() => <Navigate href="/" />} />
        </Route>
      </Router>
      </Suspense>
    </Show>
  );
};
