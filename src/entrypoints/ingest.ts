import { createContainer } from "../bootstrap/container.js";

const container = await createContainer();
const result = await container.ingestionCoordinator.execute();
console.log(JSON.stringify(result, null, 2));
