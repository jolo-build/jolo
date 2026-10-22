import { expect, test } from "bun:test";
import { applyPermissionEvent, seedPermissions } from "../src/tui/permission-queue.js";

const asked = (permissionId, runId = "run") => ({ type: "permission.requested", runId, payload: { permissionId, runId, tool: "Bash" } });

test("requests open at the same time are shown one after another, and none is lost when another is settled", () => {
  let queue = [];
  queue = applyPermissionEvent(queue, asked("p1"));
  queue = applyPermissionEvent(queue, asked("p2"));
  queue = applyPermissionEvent(queue, asked("p2")); // the same request seen twice
  expect(queue.map((request) => request.permissionId)).toEqual(["p1", "p2"]);
  // The later one is answered (or taken back) first: the earlier one is still there to answer.
  queue = applyPermissionEvent(queue, { type: "permission.resolved", payload: { permissionId: "p2" } });
  expect(queue.map((request) => request.permissionId)).toEqual(["p1"]);
  // A run that ends takes its requests with it.
  queue = applyPermissionEvent(applyPermissionEvent(queue, asked("p3", "other")), { type: "run.state", runId: "run", payload: { state: "cancelled" } });
  expect(queue.map((request) => request.permissionId)).toEqual(["p3"]);
  // Nothing to drop leaves the very same queue, so nothing is drawn again.
  expect(applyPermissionEvent(queue, { type: "run.state", runId: "run", payload: { state: "completed" } })).toBe(queue);
});

test("a snapshot adds the requests it lists, except those settled while it loaded", () => {
  const live = applyPermissionEvent([], asked("p3"));
  const pending = [{ permissionId: "p1" }, { permissionId: "p2" }, { permissionId: "p3" }];
  // The one already shown stays first; the snapshot's others follow it.
  expect(seedPermissions(live, pending, new Set(["p2"])).map((request) => request.permissionId)).toEqual(["p3", "p1"]);
  // A request of a run that finished while the snapshot loaded lapsed with it, though no event said so.
  const lapsed = [{ permissionId: "p4", runId: "done" }, { permissionId: "p5", runId: "live" }];
  expect(seedPermissions([], lapsed, new Set(), (runId) => runId === "done").map((request) => request.permissionId)).toEqual(["p5"]);
});
