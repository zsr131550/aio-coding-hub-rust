import assert from "node:assert/strict";
import { ProcessTreeTracker } from "./process-tree.mjs";

function exactProcess({ pid, ppid, birthToken, imageName }) {
  return {
    pid,
    ppid,
    birthToken,
    identityPrecision: "exact",
    imageName,
    workingSetBytes: 1,
    privateBytes: 1,
    cpuTimeMs: 1,
  };
}

const root = exactProcess({
  pid: 10,
  ppid: 1,
  birthToken: "unix-ms:2000",
  imageName: "app",
});
const stalePpidProcess = exactProcess({
  pid: 11,
  ppid: 10,
  birthToken: "unix-ms:1000",
  imageName: "unrelated",
});
const tracker = new ProcessTreeTracker(root);

assert.deepEqual(
  tracker.acceptSnapshot([root, stalePpidProcess]).map((process) => process.pid),
  [10]
);
assert.equal(tracker.owns(stalePpidProcess), false);

const sameMillisecondRoot = exactProcess({
  pid: 20,
  ppid: 1,
  birthToken: "unix-ms:3000",
  imageName: "app",
});
const sameMillisecondChild = exactProcess({
  pid: 21,
  ppid: 20,
  birthToken: "unix-ms:3000",
  imageName: "worker",
});
const sameMillisecondTracker = new ProcessTreeTracker(sameMillisecondRoot);
assert.deepEqual(
  sameMillisecondTracker
    .acceptSnapshot([sameMillisecondRoot, sameMillisecondChild])
    .map((process) => process.pid),
  [20, 21]
);
assert.equal(sameMillisecondTracker.owns(sameMillisecondChild), true);

const reparentedRoot = exactProcess({
  pid: 30,
  ppid: 1,
  birthToken: "100",
  imageName: "app",
});
const reparentedChild = exactProcess({
  pid: 31,
  ppid: 30,
  birthToken: "101",
  imageName: "worker",
});
const reparentedTracker = new ProcessTreeTracker(reparentedRoot);
assert.deepEqual(
  reparentedTracker.acceptSnapshot([reparentedRoot, reparentedChild]).map((process) => process.pid),
  [30, 31]
);
assert.deepEqual(
  reparentedTracker.acceptSnapshot([{ ...reparentedChild, ppid: 1 }]).map((process) => process.pid),
  [31]
);
assert.equal(reparentedTracker.owns({ ...reparentedChild, ppid: 1 }), true);

const opaqueRoot = exactProcess({
  pid: 40,
  ppid: 1,
  birthToken: "unix-ms:4000",
  imageName: "app",
});
const opaqueChild = exactProcess({
  pid: 41,
  ppid: 40,
  birthToken: "opaque-child-birth",
  imageName: "worker",
});
const opaqueGrandchild = exactProcess({
  pid: 42,
  ppid: 41,
  birthToken: "unix-ms:5000",
  imageName: "helper",
});
const opaqueTracker = new ProcessTreeTracker(opaqueRoot);
assert.deepEqual(
  opaqueTracker
    .acceptSnapshot([opaqueRoot, opaqueChild, opaqueGrandchild])
    .map((process) => process.pid),
  [40, 41, 42]
);
assert.equal(opaqueTracker.owns(opaqueChild), false);
assert.equal(opaqueTracker.owns(opaqueGrandchild), false);

console.log("process-tree ownership self-tests passed");
