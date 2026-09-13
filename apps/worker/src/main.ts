import { deploymentStatuses } from "@previewforge/contracts";

console.log(
  JSON.stringify({
    event: "worker.started",
    service: "previewforge-worker",
    supportedDeploymentStates: deploymentStatuses.length,
  }),
);

const stop = (signal: NodeJS.Signals) => {
  console.log(JSON.stringify({ event: "worker.stopped", signal }));
  process.exit(0);
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
