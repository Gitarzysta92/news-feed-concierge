import { createContainer } from "../bootstrap/container.js";

const container = await createContainer();
try {
  const result = container.workflows
    ? { jobId: await container.workflows.enqueue("ingestion"), status: "queued" }
    : await container.ingestionCoordinator.execute();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await container.actionQueue.flush();
  await container.repository.close?.();
}
