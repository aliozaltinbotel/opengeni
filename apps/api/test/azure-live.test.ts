import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { brokerAzureLive } from "../src/azure-live";
const settings = testSettings({
  azureLiveEndpoint: "https://voice.example.test",
  azureLiveApiKey: "synthetic-key",
});
test("Azure Live negotiates server-side and sends history with client delegation", async () => {
  let request!: Request;
  const result = await brokerAzureLive({
    settings,
    request: { sdp: "synthetic offer" },
    initialItems: [{ role: "user", text: "Build a page" }],
    fetch: async (url, init) => {
      request = new Request(url, init);
      return Response.json({
        session: { id: "provider-id" },
        transport: { sdp: "synthetic answer" },
      });
    },
  });
  expect(request.url).toBe("https://voice.example.test/openai/v1/live/sessions");
  expect(request.headers.get("api-key")).toBe("synthetic-key");
  const body = await request.json();
  expect(body.session.model).toBe("gpt-live-1");
  expect(body.session.audio.output.voice).toBe("marin");
  expect(body.session.delegation).toEqual({ type: "client" });
  expect(body.session.instructions).toContain('"text":"Build a page"');
  expect(result).toEqual({
    sdp: "synthetic answer",
    version: "v3",
    model: "opengeni-azure/gpt-live-1",
  });
});
test("provider rejection stays generic and is never retried", async () => {
  let calls = 0;
  await expect(
    brokerAzureLive({
      settings,
      request: { sdp: "offer" },
      initialItems: [],
      fetch: async () => {
        calls++;
        return new Response("private upstream diagnostic", { status: 429 });
      },
    }),
  ).rejects.toMatchObject({
    reason: "rate_limited",
    providerStatus: 429,
    message: "Hosted voice connection was rejected",
  });
  expect(calls).toBe(1);
});

test("provider session identity is captured by the trusted backend owner before the SDP returns", async () => {
  const observed: unknown[] = [];
  await brokerAzureLive({ settings, request: { sdp: "offer" }, initialItems: [],
    fetch: async () => Response.json({ session: { id: "sess_provider" }, transport: { sdp: "answer" } }),
    onProviderSessionCreated: async source => { observed.push(source); },
  });
  expect(observed).toEqual([{ providerSessionId: "sess_provider", upstreamModel: settings.azureLiveDeployment, providerCredentialId: null }]);
  await expect(brokerAzureLive({ settings, request: { sdp: "offer" }, initialItems: [],
    fetch: async () => Response.json({ session: { id: "sess_provider" }, transport: { sdp: "answer" } }),
    onProviderSessionCreated: async () => { throw new Error("writer unavailable"); },
  })).rejects.toThrow("writer unavailable");
});

test("native occurrence survives an invalid provider SDP after session creation", async () => {
  const observed: string[] = [];
  await expect(brokerAzureLive({ settings, request: { sdp: "offer" }, initialItems: [],
    fetch: async () => Response.json({ session: { id: "sess_created" }, transport: { sdp: null } }),
    onProviderSessionCreated: async source => { observed.push(source.providerSessionId); },
  })).rejects.toMatchObject({ reason: "invalid_provider_response" });
  expect(observed).toEqual(["sess_created"]);
});
