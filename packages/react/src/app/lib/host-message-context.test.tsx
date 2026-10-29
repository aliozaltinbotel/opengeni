import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as contextStores from "./message-context";
import * as appHost from "./app-host";
const { useHostMessageContext, useMessageContextPills } = appHost;
import * as registry from "../../../../../apps/web/src/host-extension/registry";
const { validateHostExtension } = registry;

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

async function fixture(
  run: (read: () => string | undefined, exclude: () => void) => void,
  stock = false,
) {
  let text = "Page one";
  function Probe() {
    const read = useHostMessageContext();
    const { pills, exclude } = useMessageContextPills();
    return (
      <button
        onClick={() =>
          run(
            () => {
              text = "Page two";
              return read?.();
            },
            () => exclude("page"),
          )
        }
      >
        {pills[0]?.label}
      </button>
    );
  }
  expect(appHost).toHaveProperty("HostMessageContextProvider");
  const { HostMessageContextProvider } = appHost;
  const container = document.createElement("div");
  const inner = createRoot(container);
  try {
    await act(async () =>
      inner.render(
        <HostMessageContextProvider
          context={{ workspaceId: "w1", pathname: "/page" }}
          resolve={
            stock
              ? undefined
              : () => ({ id: "page", label: "Current page", text })
          }
        >
          <Probe />
        </HostMessageContextProvider>,
      ),
    );
    expect(container.textContent).toBe(stock ? "" : "Current page");
    await act(async () => container.querySelector("button")!.click());
  } finally {
    await act(async () => {
      inner.unmount();
    });
  }
}

test("a host messageContext item is sent with a typed message", async () => {
  await fixture((read) => expect(read()).toBe("Page two"));
});
test("a host messageContext item is sent with a realtime start", async () => {
  await fixture((getModelContext) =>
    expect(getModelContext()).toBe("Page two"),
  );
});
test("an unlabelled host item is refused at first resolution", () => {
  const source = () => ({ id: "page", text: "Page" });
  expect(() => validateHostExtension({ id: "host", messageContext: source })).not.toThrow();
  expect(registry).toHaveProperty("createHostMessageContextResolver");
  const resolve = registry.createHostMessageContextResolver(source);
  expect(resolve({ workspaceId: "w1", pathname: "/" })).toBeUndefined();
});
test("the person can leave a host pill out and it is not sent", async () => {
  await fixture((read, exclude) => {
    exclude();
    expect(read()).toBeUndefined();
  });
});
test("stock console without an extension is unchanged", async () => {
  await fixture((read) => expect(read()).toBeUndefined(), true);
});

test("the first new-chat send reads the shared page store outside the workspace shell", () => {
  expect(contextStores).toHaveProperty("createHostMessageContextStore");
  let workspaceId = "w1";
  let pathname = "/workspaces/w1/sessions";
  const store = contextStores.createHostMessageContextStore(
    (context) => ({
      id: "page",
      label: "Current page",
      text: context.pathname,
    }),
    () => ({ workspaceId, pathname }),
  );
  expect(store.forSend()).toBe(pathname);
  store.exclude("page");
  expect(store.forSend()).toBeUndefined();
  pathname = "/workspaces/w1/sessions/new";
  expect(store.forSend()).toBeUndefined();
  workspaceId = "w2";
  expect(store.forSend()).toBe(pathname);
});

test("a host pill excluded before the first send stays excluded", () => {
  const item = {
    id: "page",
    label: "Current page",
    text: "Current page details",
  };
  const store = contextStores.createHostMessageContextStore(
    () => item,
    () => ({ workspaceId: "w1", pathname: "/" }),
  );
  store.set(item);
  store.exclude("page");
  expect(store.forSend()).toBeUndefined();
});

test("installation never calls a workspace-dependent host resolver", () => {
  let calls = 0;
  expect(() => validateHostExtension({ id: "host", messageContext: ({ workspaceId }: { workspaceId: string }) => {
    calls += 1;
    if (!workspaceId) throw new Error("workspace required");
    return undefined;
  } })).not.toThrow();
  expect(calls).toBe(0);
});

test("a throwing host resolver sends the message without host items", () => {
  expect(registry).toHaveProperty("createHostMessageContextResolver");
  const resolve = registry.createHostMessageContextResolver(() => { throw new Error("host unavailable"); });
  const store = contextStores.createHostMessageContextStore(resolve, () => ({ workspaceId: "w1", pathname: "/" }));
  expect({ message: "Hello", modelContext: store.forSend() }).toEqual({ message: "Hello", modelContext: undefined });
});

test("an invalid host item is dropped, not sent, and the send succeeds", () => {
  expect(registry).toHaveProperty("createHostMessageContextResolver");
  const resolve = registry.createHostMessageContextResolver(() => ({ id: "page", text: "Hidden details" }));
  const store = contextStores.createHostMessageContextStore(resolve, () => ({ workspaceId: "w1", pathname: "/" }));
  expect({ message: "Hello", modelContext: store.forSend() }).toEqual({ message: "Hello", modelContext: undefined });
});

test("host resolution failures warn once without exposing host values", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const resolve = registry.createHostMessageContextResolver(() => { throw new Error("private host value"); });
    resolve({ workspaceId: "w1", pathname: "/" });
    resolve({ workspaceId: "w1", pathname: "/next" });
    expect(warning.mock.calls).toEqual([["HOST_MESSAGE_CONTEXT_FAILED"]]);
  } finally { warning.mockRestore(); }
});

test("host context resolves on pathname changes and sends, without resolving on unrelated renders", async () => {
  let calls = 0;
  let read: (() => string | undefined) | undefined;
  const resolve = () => { calls += 1; return { id: "page", label: "Page", text: "Details" }; };
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() { read = useHostMessageContext(); return null; }
  const render = (pathname: string) => root.render(<appHost.HostMessageContextProvider context={{ workspaceId: "w1", pathname }} resolve={resolve}><Probe /></appHost.HostMessageContextProvider>);
  try {
    await act(async () => render("/"));
    const initial = calls;
    await act(async () => render("/"));
    expect(calls).toBe(initial);
    await act(async () => render("/next"));
    expect(calls).toBe(initial + 1);
    await act(async () => expect(read?.()).toBe("Details"));
    expect(calls).toBe(initial + 2);
  } finally { await act(async () => root.unmount()); }
});
