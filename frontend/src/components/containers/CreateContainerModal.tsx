import { lazy, Show, Suspense, ErrorBoundary, type Component, type ComponentProps } from "solid-js";
import type { CreateContainerModal as ModalContent } from "./CreateContainerModalContent";
import { Modal } from "../shared/Modal";

const Content = lazy(() => import("./CreateContainerModalContent").then((m) => ({ default: m.CreateContainerModal })));

// Load editors and converters only when a container configuration dialog opens.
export const CreateContainerModal: Component<ComponentProps<typeof ModalContent>> = (props) => (
  <Show when={props.open}>
    <ErrorBoundary fallback={(_, retry) => <Modal open onClose={props.onClose} title="容器配置"><button onClick={retry}>加载失败，点击重试</button></Modal>}>
      <Suspense fallback={<Modal open onClose={props.onClose} title="容器配置">加载中…</Modal>}>
        <Content {...props} />
      </Suspense>
    </ErrorBoundary>
  </Show>
);
