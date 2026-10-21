import { afterEach, expect, test } from "bun:test";
import {
  registerExternalAccessTokenSource,
  registerExternalSignOut,
  signOutExternalAccess,
  hasExternalAccessTokenSource,
  managedActorFetch,
  requestResponse,
  createOpenGeniClient,
  configureClientAuth,
} from "./api";
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  configureClientAuth({ mode: "local" } as never);
});
function capture() {
  const requests: Headers[] = [];
  globalThis.window = { location: { origin: "http://localhost" } } as Window & typeof globalThis;
  globalThis.fetch = (async (_url, init) => {
    requests.push(new Headers(init?.headers));
    return Response.json({});
  }) as typeof fetch;
  return requests;
}
test("optional source is absent by default and registration stores no JWT", async () => {
  const requests = capture();
  expect(hasExternalAccessTokenSource()).toBe(false);
  await requestResponse("/v1/config/client");
  expect(requests[0]?.has("authorization")).toBe(false);
  dispose = registerExternalAccessTokenSource(async () => "fixture-token-one");
  expect(hasExternalAccessTokenSource()).toBe(true);
  dispose();
  expect(hasExternalAccessTokenSource()).toBe(false);
});
test("manual bootstrap and SDK requests each obtain fresh external JWT before auth config", async () => {
  const requests = capture();
  let sequence = 0;
  dispose = registerExternalAccessTokenSource(async () => `fixture-token-${++sequence}`);
  await requestResponse("/v1/config/client");
  await createOpenGeniClient().getAccessContext();
  expect(requests.map((h) => h.get("authorization"))).toEqual([
    "Bearer fixture-token-1",
    "Bearer fixture-token-2",
  ]);
});
test("signed-out or rejected token source refuses before network", async () => {
  const requests = capture();
  dispose = registerExternalAccessTokenSource(async () => null);
  await expect(requestResponse("/v1/config/client")).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
test("a sign-out during token lookup cannot send the resolved token", async () => {
  const requests = capture();
  let finish!: (token: string) => void;
  dispose = registerExternalAccessTokenSource(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = requestResponse("/v1/config/client");
  dispose();
  finish("fixture-expired-token");
  await expect(pending).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
test("external token never reaches a signed object-storage request or another origin", async () => {
  const requests = capture();
  let reads = 0;
  dispose = registerExternalAccessTokenSource(async () => {
    reads++;
    return "fixture-token";
  });
  await managedActorFetch("https://objects.test/signed", { credentials: "omit" });
  await managedActorFetch("https://unrelated.test/path", { credentials: "include" });
  expect(reads).toBe(0);
  expect(requests.every((h) => !h.has("authorization"))).toBe(true);
});

test("external JWT is never written to browser storage", async () => {
  capture();
  const originalStorage = globalThis.localStorage;
  let writes = 0;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {
      writes++;
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  try {
    dispose = registerExternalAccessTokenSource(async () => "fixture-private-jwt");
    await requestResponse("/v1/config/client");
    expect(writes).toBe(0);
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test("native sign-out delegates to Clerk and rejects further token requests", async () => {
  const requests = capture();
  let signOuts = 0;
  dispose = registerExternalAccessTokenSource(async () => "fixture-signed-in-jwt");
  const unregisterSignOut = registerExternalSignOut(async () => {
    signOuts++;
  });
  try {
    const oldClient = createOpenGeniClient();
    await requestResponse("/v1/config/client");
    expect(await signOutExternalAccess()).toBe(true);
    await expect(oldClient.getAccessContext()).rejects.toMatchObject({ name: "AbortError" });
    expect(signOuts).toBe(1);
    await expect(requestResponse("/v1/config/client")).rejects.toThrow();
    expect(requests).toHaveLength(1);
  } finally {
    unregisterSignOut();
  }
});

test("external session replacement rejects actor A headers even when native auth epoch is null", async () => {
  capture();
  dispose = registerExternalAccessTokenSource(async () => "fixture-actor-a");
  let finish!: (response: Response) => void;
  let requested!: () => void;
  const entered = new Promise<void>((resolve) => {
    requested = resolve;
  });
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    requested();
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as typeof fetch;
  const pending = managedActorFetch("http://localhost/v1/resource");
  await entered;
  dispose();
  dispose = registerExternalAccessTokenSource(async () => "fixture-actor-b");
  finish(Response.json({ privateActorA: true }));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("external session replacement rejects an actor A finite JSON body", async () => {
  capture();
  dispose = registerExternalAccessTokenSource(async () => "fixture-actor-a");
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let requested!: () => void;
  const entered = new Promise<void>((resolve) => {
    requested = resolve;
  });
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    requested();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const pending = managedActorFetch("http://localhost/v1/resource");
  await entered;
  dispose();
  dispose = registerExternalAccessTokenSource(async () => "fixture-actor-b");
  body.enqueue(new TextEncoder().encode('{"privateActorA":true}'));
  body.close();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("cross-tab sign-out aborts an admitted actor A streaming body", async () => {
  capture();
  dispose = registerExternalAccessTokenSource(async () => "fixture-actor-a");
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    new Response(new ReadableStream(), {
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
  const response = await managedActorFetch("http://localhost/v1/resource");
  const pending = response.body!.getReader().read();
  dispose();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("cached actor A SDK client cannot dispatch after cross-tab sign-out or as actor B", async () => {
  const requests = capture();
  dispose = registerExternalAccessTokenSource(async () => "fixture-actor-a");
  const oldClient = createOpenGeniClient();
  dispose();
  await expect(oldClient.getAccessContext()).rejects.toMatchObject({ name: "AbortError" });
  dispose = registerExternalAccessTokenSource(async () => "fixture-actor-b");
  await expect(oldClient.getAccessContext()).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toHaveLength(0);
});

test("Request-form credential omission never obtains or attaches a Clerk token", async () => {
  const requests = capture();
  let reads = 0;
  dispose = registerExternalAccessTokenSource(async () => {
    reads++;
    return "fixture-private-jwt";
  });
  const input = new Request("http://localhost/v1/signed-file", { credentials: "omit" });
  // Bun 1.3 ignores RequestInit.credentials; expose the standard browser projection.
  Object.defineProperty(input, "credentials", { value: "omit" });
  await managedActorFetch(input);
  expect(reads).toBe(0);
  expect(requests[0]?.has("authorization")).toBe(false);
});
