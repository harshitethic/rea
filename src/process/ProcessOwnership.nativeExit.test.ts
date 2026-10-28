import { spawn } from "node:child_process";
import { once } from "node:events";

import { expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
  type ProcessIdentityObservation,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import {
  createSystemProcessOwnershipHost,
  readProcessOwnershipFacts,
} from "./ProcessOwnershipObservation.js";

it.each(["zombie", "absent", "live", "unavailable"] as const)(
  "rechecks native lifetime when a token disappears during cleanup: %s",
  async (lifetimeAfterToken) => {
    const row: ProcessTableEntry = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "fixture",
    };
    let tokenRead = false;
    const identity = (): ProcessIdentityObservation => {
      if (tokenRead && lifetimeAfterToken === "absent")
        return { state: "absent", reason: "not-found-in-caller-pid-namespace" };
      if (tokenRead && lifetimeAfterToken === "unavailable")
        return { state: "unavailable", reason: "identity read denied" };
      return {
        state: "readable",
        identity: "same-generation",
        lifecycle: {
          state: "observed",
          lifecycle:
            tokenRead && lifetimeAfterToken === "zombie"
              ? "zombie"
              : "non-zombie",
        },
        relation: { state: "observed", parentPid: 1, processGroupId: 100 },
      };
    };
    const signalGroup = vi.fn();
    const host: ProcessOwnershipHost = {
      platform: "linux",
      listProcesses: async () => [row],
      environment: async () => ({}),
      runTokens: async (members) => {
        tokenRead = true;
        return new Map(
          members.map(({ pid }) => [
            pid,
            { state: "readable" as const, runId: undefined },
          ]),
        );
      },
      processIdentities: async (members) =>
        new Map(members.map(({ pid }) => [pid, identity()])),
      signalGroup,
    };
    const result = await cleanupOwnedProcessGroup(
      { runId: "run", leaderPid: 100, processGroupId: 100 },
      host,
    );
    expect(tokenRead).toBe(true);
    if (lifetimeAfterToken === "zombie" || lifetimeAfterToken === "absent") {
      expect(result).toEqual({ cleaned: true, signaled: false });
    } else {
      expect(result).toMatchObject({
        cleaned: false,
        failures: [
          {
            pid: 100,
            reason:
              lifetimeAfterToken === "live"
                ? "run-token-mismatch"
                : "process-identity-unavailable",
          },
        ],
      });
    }
    expect(signalGroup).not.toHaveBeenCalled();
  },
);

// A failing procfs environ read does not establish exit on its own. The
// native observer must corroborate the absence before cleanup drops a PID.
it.each(["ESRCH", "ENOENT"] as const)(
  "settles %s from /proc/PID/environ only after native absence confirmation",
  async (code) => {
    const row: ProcessTableEntry = {
      pid: 900,
      parentPid: 1,
      processGroupId: 900,
      state: "S",
      command: "short-lived-fixture",
    };
    let identityReads = 0;
    const live: ProcessIdentityObservation = {
      state: "readable",
      identity: "start:900",
      lifecycle: { state: "observed", lifecycle: "non-zombie" },
      relation: { state: "observed", parentPid: 1, processGroupId: 900 },
    };
    const host: ProcessOwnershipHost = {
      platform: "linux",
      listProcesses: async () => [row],
      environment: async () => {
        throw Object.assign(
          new Error(code + ": no such process, open '/proc/900/environ'"),
          { code },
        );
      },
      processIdentities: async (rows) =>
        new Map<number, ProcessIdentityObservation>(
          rows.map(({ pid }) => [
            pid,
            ++identityReads < 3
              ? live
              : {
                  state: "absent" as const,
                  reason: "not-found-in-caller-pid-namespace" as const,
                },
          ]),
        ),
      signalGroup: vi.fn(),
    };
    const [fact] = await readProcessOwnershipFacts([row], host);
    expect(identityReads).toBe(3);
    expect(fact?.token).toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining(code),
    });
    expect(fact?.state).toBe("absent");
    expect(fact?.identityAfter).toEqual({
      state: "absent",
      reason: "not-found-in-caller-pid-namespace",
    });
    expect(host.signalGroup).not.toHaveBeenCalled();
  },
);

it.each([
  {
    code: "ESRCH",
    mode: "live",
    expectedReads: 3,
    expectedState: "same-generation",
  },
  {
    code: "ESRCH",
    mode: "reused",
    expectedReads: 3,
    expectedState: "unavailable",
  },
  {
    code: "ESRCH",
    mode: "reused-zombie",
    expectedReads: 3,
    expectedState: "unavailable",
  },
  {
    code: "ESRCH",
    mode: "unknown",
    expectedReads: 3,
    expectedState: "same-generation",
  },
  {
    code: "EACCES",
    mode: "absent",
    expectedReads: 2,
    expectedState: "same-generation",
  },
] as const)(
  "does not clear unverifiable /proc environ failures: $code / $mode",
  async ({ code, mode, expectedReads, expectedState }) => {
    const row: ProcessTableEntry = {
      pid: 901,
      parentPid: 1,
      processGroupId: 901,
      state: "S",
      command: "fixture",
    };
    let identityReads = 0;
    const live: ProcessIdentityObservation = {
      state: "readable",
      identity: "start:901",
      lifecycle: { state: "observed", lifecycle: "non-zombie" },
      relation: { state: "observed", parentPid: 1, processGroupId: 901 },
    };
    const host: ProcessOwnershipHost = {
      platform: "linux",
      listProcesses: async () => [row],
      environment: async () => {
        throw Object.assign(new Error(code + ": open '/proc/901/environ'"), {
          code,
        });
      },
      processIdentities: async (rows) =>
        new Map<number, ProcessIdentityObservation>(
          rows.map(({ pid }) => {
            identityReads += 1;
            if (identityReads < 3) return [pid, live] as const;
            switch (mode) {
              case "absent":
                return [
                  pid,
                  {
                    state: "absent" as const,
                    reason: "not-found-in-caller-pid-namespace" as const,
                  },
                ] as const;
              case "reused":
                return [
                  pid,
                  { ...live, identity: "start:replacement" },
                ] as const;
              case "reused-zombie":
                return [
                  pid,
                  {
                    ...live,
                    identity: "start:zombie-replacement",
                    lifecycle: {
                      state: "observed" as const,
                      lifecycle: "zombie" as const,
                    },
                  },
                ] as const;
              case "unknown":
                return [
                  pid,
                  {
                    state: "unavailable" as const,
                    reason: "permission denied",
                  },
                ] as const;
              default:
                return [pid, live] as const;
            }
          }),
        ),
      signalGroup: vi.fn(),
    };
    const [fact] = await readProcessOwnershipFacts([row], host);
    expect(identityReads).toBe(expectedReads);
    expect(fact?.state).toBe(expectedState);
    expect(fact?.identityAfter.state).not.toBe("absent");
    expect(fact?.token.state).toBe("unavailable");
    expect(host.signalGroup).not.toHaveBeenCalled();
  },
);

const itOnLinux = process.platform === "linux" ? it : it.skip;

itOnLinux(
  "verifies a real child exit between the native identity and follow-up read",
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      {
        stdio: "ignore",
      },
    );
    if (child.pid === undefined) throw new Error("fixture child did not start");
    const pid = child.pid;
    const row: ProcessTableEntry = {
      pid,
      parentPid: process.pid,
      processGroupId: pid,
      state: "S",
      command: process.execPath,
    };
    const systemHost = createSystemProcessOwnershipHost("linux", {});
    let nativeReads = 0;
    const host: ProcessOwnershipHost = {
      ...systemHost,
      environment: async () => {
        throw Object.assign(
          new Error(
            "ESRCH: simulated environ-open race before native process exit",
          ),
          { code: "ESRCH" },
        );
      },
      processIdentities: async (...args) => {
        const observations = await systemHost.processIdentities!(...args);
        nativeReads += 1;
        if (nativeReads === 2) {
          child.kill("SIGTERM");
          await once(child, "exit");
        }
        return observations;
      },
      signalGroup: vi.fn(),
    };
    try {
      const [fact] = await readProcessOwnershipFacts([row], host);
      expect(nativeReads).toBe(3);
      expect(fact?.identityBefore).toMatchObject({
        state: "readable",
        identity: expect.stringMatching(/^linux-starttime:/u),
      });
      expect(fact?.token).toMatchObject({
        state: "unavailable",
        reason: expect.stringContaining("ESRCH"),
      });
      expect(fact?.identityAfter).toEqual({
        state: "absent",
        reason: "not-found-in-caller-pid-namespace",
      });
      expect(fact?.state).toBe("absent");
      expect(host.signalGroup).not.toHaveBeenCalled();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  },
);

it.each([
  "absent",
  "delayed-absent",
  "live",
  "reused",
  "delayed-reused",
  "unknown",
  "reused-zombie",
] as const)(
  "resolves a Linux token-read exit race after final sweep retry: %s",
  async (lastIdentity) => {
    const row: ProcessTableEntry = {
      pid: 902,
      parentPid: 1,
      processGroupId: 902,
      state: "S",
      command: "short-lived-worker",
    };
    const live: ProcessIdentityObservation = {
      state: "readable",
      identity: "start:902",
      lifecycle: { state: "observed", lifecycle: "non-zombie" },
      relation: { state: "observed", parentPid: 1, processGroupId: 902 },
    };
    let tokenReads = 0;
    let readsAfterLastToken = 0;
    const host: ProcessOwnershipHost = {
      platform: "linux",
      listProcesses: async () => [row], // stale snapshot must never prove exit
      environment: async () => {
        tokenReads += 1;
        throw Object.assign(new Error("ESRCH: open '/proc/902/environ'"), {
          code: "ESRCH",
        });
      },
      processIdentities: async (members) =>
        new Map<number, ProcessIdentityObservation>(
          members.map(({ pid }) => {
            if (tokenReads < 4) return [pid, live] as const;
            readsAfterLastToken += 1;
            const delayed = lastIdentity.startsWith("delayed-");
            if (readsAfterLastToken < (delayed ? 5 : 3))
              return [pid, live] as const;
            switch (lastIdentity) {
              case "delayed-absent":
              case "absent":
                return [
                  pid,
                  {
                    state: "absent" as const,
                    reason: "not-found-in-caller-pid-namespace",
                  },
                ] as const;
              case "delayed-reused":
              case "reused":
                return [
                  pid,
                  { ...live, identity: "start:replacement" },
                ] as const;
              case "reused-zombie":
                return [
                  pid,
                  {
                    ...live,
                    identity: "start:zombie-replacement",
                    lifecycle: {
                      state: "observed" as const,
                      lifecycle: "zombie" as const,
                    },
                  },
                ] as const;
              case "unknown":
                return [
                  pid,
                  {
                    state: "unavailable" as const,
                    reason: "native identity permission denied",
                  },
                ] as const;
              default:
                return [pid, live] as const;
            }
          }),
        ),
      signalGroup: vi.fn(),
    };
    const result = await verifyNoTokenOwnedProcesses("run-token", host);
    expect(tokenReads).toBe(4);
    // A live process is not repeatedly scanned without a fixed upper bound.
    expect(readsAfterLastToken).toBeLessThanOrEqual(6);
    if (lastIdentity === "delayed-absent" || lastIdentity === "delayed-reused")
      expect(readsAfterLastToken).toBe(5);
    if (lastIdentity === "absent" || lastIdentity === "delayed-absent")
      expect(result).toEqual({ cleaned: true, signaled: false });
    else
      expect(result).toMatchObject({
        cleaned: false,
        failures: [
          {
            pid: 902,
            reason: lastIdentity.includes("reused")
              ? "process-identity-unavailable"
              : "environment-unreadable",
          },
        ],
      });
    expect(host.signalGroup).not.toHaveBeenCalled();
  },
);
