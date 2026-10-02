import { expect, test } from "bun:test";
import { connect, type ConnectionOptions } from "nats";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { startTestServices } from "../src/compose";
import { runCommand } from "../src/process";

test("an opted-in test broker requires a nonempty control-plane identity", async () => {
  for (const natsControlAuth of [
    { user: " ", password: "fixture" },
    { user: "fixture", password: " " },
  ]) {
    await expect(startTestServices({ temporal: false, natsControlAuth })).rejects.toThrow(
      "natsControlAuth requires a nonempty user and password",
    );
  }
});

test.skipIf(process.env.OPENGENI_TEST_COMPOSE_AUTH !== "1")(
  "one authenticated fixture broker accepts its identity, refuses others, and cleans up",
  async () => {
    const natsControlAuth = {
      user: ` fixture-${crypto.randomUUID()} `,
      password: ` fixture-${crypto.randomUUID()}:"\\ `,
    };
    const services = await startTestServices({ temporal: false, natsControlAuth });
    const owned = {
      projectName: services.projectName,
      fixtureDirectory: services.cwd,
      containers: [] as string[],
      volumes: [] as string[],
      networks: [] as string[],
    };
    try {
      const filter = `label=com.docker.compose.project=${services.projectName}`;
      const pinFilter = `label=com.opengeni.test-image-pin=${services.projectName}`;
      owned.containers = [
        ...(await dockerLines(["ps", "-aq", "--filter", filter])),
        ...(await dockerLines(["ps", "-aq", "--filter", pinFilter])),
      ];
      owned.networks = await dockerLines(["network", "ls", "-q", "--filter", filter]);
      for (const id of owned.containers) {
        const mounts = JSON.parse(
          (await dockerLines(["inspect", "--format", "{{json .Mounts}}", id])).join("\n"),
        ) as Array<{ Type: string; Name?: string }>;
        for (const mount of mounts) {
          if (mount.Type === "volume" && mount.Name) owned.volumes.push(mount.Name);
        }
      }
      owned.volumes = [...new Set(owned.volumes)];
      console.log(JSON.stringify({ event: "compose_auth_resources", ...owned }));

      expect(services.natsControlAuth?.user === natsControlAuth.user.trim()).toBe(true);
      expect(services.natsControlAuth?.password === natsControlAuth.password.trim()).toBe(true);
      expect((await stat(services.cwd)).mode & 0o777).toBe(0o700);
      expect((await stat(join(services.cwd, "nats.conf"))).mode & 0o777).toBe(0o600);
      const compose = await readFile(services.composeFile, "utf8");
      expect(compose.includes(natsControlAuth.user.trim())).toBe(false);
      expect(compose.includes(natsControlAuth.password.trim())).toBe(false);
      expect(new URL(services.natsUrl).username).toBe("");
      expect(new URL(services.natsUrl).password).toBe("");

      const connection = await connect({
        servers: services.natsUrl,
        timeout: 1_000,
        reconnect: false,
        user: services.natsControlAuth!.user,
        pass: services.natsControlAuth!.password,
      });
      try {
        await connection.flush();
        expect(connection.isClosed()).toBe(false);
      } finally {
        await connection.close();
      }
      expect(await connectionOutcome({ servers: services.natsUrl })).toBe(
        "AUTHORIZATION_VIOLATION",
      );
      expect(
        await connectionOutcome({
          servers: services.natsUrl,
          user: services.natsControlAuth!.user,
          pass: "wrong-fixture-password",
        }),
      ).toBe("AUTHORIZATION_VIOLATION");
    } finally {
      await services.down();
      console.log(
        JSON.stringify({ event: "compose_auth_cleanup", projectName: owned.projectName }),
      );
    }
    expect(await Bun.file(services.composeFile).exists()).toBe(false);
    for (const id of owned.containers) {
      expect(await dockerLines(["ps", "-aq", "--filter", `id=${id}`])).toEqual([]);
    }
    for (const volume of owned.volumes) {
      expect(await dockerLines(["volume", "ls", "-q", "--filter", `name=${volume}`])).toEqual([]);
    }
    for (const network of owned.networks) {
      expect(await dockerLines(["network", "ls", "-q", "--filter", `id=${network}`])).toEqual([]);
    }
  },
  180_000,
);

async function dockerLines(args: string[]): Promise<string[]> {
  const result = await runCommand(["docker", ...args], { timeoutMs: 5_000 });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error("Owned fixture Docker inspection failed");
  }
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function connectionOutcome(options: ConnectionOptions): Promise<string> {
  try {
    const connection = await connect({ timeout: 1_000, reconnect: false, ...options });
    await connection.close();
    return "CONNECTED";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    return String(error.code);
  }
}
