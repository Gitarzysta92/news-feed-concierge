import assert from "node:assert/strict";
import test from "node:test";
import { ActionQueue } from "../src/application/action-queue.js";

test("action queue exposes real lifecycle transitions and bounds terminal history", () => {
  const queue = new ActionQueue(1);
  const extraction = queue.enqueue({
    kind: "extraction",
    label: "Extract article",
    detail: "Waiting for a worker",
    context: { articleId: "source:1" },
  });
  assert.equal(queue.snapshot().counts.queued, 1);

  extraction.start("Downloading full text");
  let snapshot = queue.snapshot();
  assert.equal(snapshot.counts.running, 1);
  assert.equal(snapshot.actions[0].detail, "Downloading full text");
  assert.ok(snapshot.actions[0].startedAt);

  extraction.complete("1,024 characters extracted");
  snapshot = queue.snapshot();
  assert.equal(snapshot.counts.completed, 1);
  assert.ok(snapshot.actions[0].finishedAt);

  const semantic = queue.enqueue({
    kind: "semantic-evaluation",
    label: "Evaluate article",
    detail: "Waiting for evaluator",
  });
  semantic.start();
  semantic.fail(new Error("gateway timeout"), "Base ranking retained");

  snapshot = queue.snapshot();
  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.counts.failed, 1);
  assert.equal(snapshot.actions[0].error, "gateway timeout");
  assert.equal(snapshot.actions[0].detail, "Base ranking retained");
});
