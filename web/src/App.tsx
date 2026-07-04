import { Component, createSignal, onMount, Show } from "solid-js";
import { Router, Route, Navigate, useNavigate } from "@solidjs/router";
import { currentUser, loadSession } from "./stores/auth";
import { Layout } from "./components/shared/Layout";
import { ToastHost } from "./components/shared/Toast";
import { LoginPage } from "./components/auth/LoginPage";
import { ContainerListPage } from "./components/containers/ContainerListPage";
import { ContainerDetailPage } from "./components/containers/ContainerDetailPage";
import { TerminalWindowPage } from "./components/containers/TerminalWindowPage";
import { ImageListPage } from "./components/images/ImageListPage";
import { ComposeListPage } from "./components/compose/ComposeListPage";
import { ComposeDetailPage } from "./components/compose/ComposeDetailPage";
import { NetworkListPage } from "./components/networks/NetworkListPage";
import { VolumeListPage } from "./components/volumes/VolumeListPage";
import { EventsPage } from "./components/events/EventsPage";
import { ConfigFilesPage } from "./components/config/ConfigFilesPage";
import { UsersPage } from "./components/settings/UsersPage";
import { RegistriesPage } from "./components/settings/RegistriesPage";
import { AuditPage } from "./components/settings/AuditPage";

// Guard wraps the authenticated layout; redirects to /login when no user.
const Guard: Component<{ children?: any }> = (props) => {
  const navigate = useNavigate();
  onMount(() => {
    window.addEventListener("phyless:unauthorized", () => navigate("/login", { replace: true }));
  });
  return (
    <Show when={currentUser()} fallback={<Navigate href="/login" />}>
      <Layout>{props.children}</Layout>
    </Show>
  );
};

export const App: Component = () => {
  const [ready, setReady] = createSignal(false);
  onMount(async () => {
    await loadSession();
    setReady(true);
  });

  return (
    <Show when={ready()} fallback={<div class="p-8">…</div>}>
      <ToastHost />
      <Router>
        <Route path="/login" component={LoginPage} />
        {/* Outside Guard/Layout on purpose — opened as a chrome-less popup
            window (see ConsoleModal), not part of the normal app navigation. */}
        <Route path="/terminal/:id" component={TerminalWindowPage} />
        <Route path="/" component={Guard}>
          <Route path="/" component={() => <Navigate href="/containers" />} />
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
          <Route path="/settings/audit" component={AuditPage} />
        </Route>
      </Router>
    </Show>
  );
};
